import test from "node:test";
import assert from "node:assert/strict";
import { Keypair } from "@stellar/stellar-sdk";
import {
  DB_TESTS,
  setupWorkerDbTest,
  stubChain,
  chainSubmissionRecord,
  seedMarketplace,
  seedReexecutor,
  seedSubmission,
  type WorkerDbContext,
} from "../test/worker-db.js";

// Postgres-backed scheduler-pass tests: run only with VERITY_DB_TESTS=1 (CI
// sets it). Each pass is exercised against an embedded Postgres with the chain
// stubbed through the seam, including a second run to prove idempotency.
let ctx: WorkerDbContext | undefined;

test.before(async () => {
  if (!DB_TESTS) return;
  ctx = await setupWorkerDbTest();
});

test.after(async () => {
  await ctx?.harness.stop();
});

test.beforeEach(async () => {
  if (!ctx) return;
  stubChain(ctx.chain);
  await ctx.harness.reset();
});

const skip = { skip: !DB_TESTS };
const REX1 = Keypair.random().publicKey();

test("settleOnce waits out the grace period before stamping settled_at", skip, async () => {
  const { db, scheduler } = ctx!;
  const market = await seedMarketplace(db);
  const rex = await seedReexecutor(db, REX1);
  const sub = await seedSubmission(db, market.id, {
    chain_submission_id: "7",
    status: "verified",
    resolution_method: "reexecution_consensus",
    settled_at: null,
  });
  await db
    .insertInto("replay")
    .values({ submission_id: sub.id, reexecutor_id: rex.id, status: "confirmed_onchain", match: true, tx_hash: "tx-vote-1" })
    .execute();

  // The chain knows 2 votes but only 1 is indexed yet; the grace period
  // (SETTLE_GRACE_S = 600) has not elapsed, so nothing may be settled.
  const calls = stubChain(ctx!.chain, {
    readSubmission: async () =>
      chainSubmissionRecord({ finalized: true, verdict: ["Verified"], match_votes: 2, mismatch_votes: 0 }),
  });

  assert.equal(await scheduler.settleOnce(), 0);
  let row = await db.selectFrom("submission").select(["settled_at"]).where("id", "=", sub.id).executeTakeFirstOrThrow();
  assert.equal(row.settled_at, null);
  assert.equal(calls.releaseLock.length, 0);

  // Past the grace period the indexed votes are enough: settle proceeds.
  await db
    .updateTable("submission")
    .set({ updated_at: new Date(Date.now() - 700_000) })
    .where("id", "=", sub.id)
    .execute();
  assert.equal(await scheduler.settleOnce(), 1);

  row = await db.selectFrom("submission").select(["settled_at"]).where("id", "=", sub.id).executeTakeFirstOrThrow();
  assert.ok(row.settled_at, "settled_at stamped after the grace period");
  assert.deepEqual(calls.releaseLock, [REX1]);
  const vote = await db.selectFrom("replay").select(["lock_released_at"]).where("submission_id", "=", sub.id).executeTakeFirstOrThrow();
  assert.ok(vote.lock_released_at, "stake lock released");
  const attestations = await db.selectFrom("attestation_export").selectAll().where("submission_id", "=", sub.id).execute();
  assert.equal(attestations.length, 1);

  // A second pass finds nothing left to settle.
  assert.equal(await scheduler.settleOnce(), 0);
});

test("purgeDraftsOnce deletes only stale drafts and keeps recent and on-chain rows", skip, async () => {
  const { db, scheduler } = ctx!;
  const market = await seedMarketplace(db);
  const recent = await seedSubmission(db, market.id, { chain_submission_id: null, escrow_ref: "fresh" });
  const stale = await seedSubmission(db, market.id, { chain_submission_id: null, escrow_ref: "stale" });
  const onChain = await seedSubmission(db, market.id, { chain_submission_id: "9", escrow_ref: "onchain" });
  const old = new Date(Date.now() - 2 * 3600 * 1000); // twice the default DRAFT_TTL_S
  await db.updateTable("submission").set({ updated_at: old }).where("id", "=", stale.id).execute();
  await db.updateTable("submission").set({ updated_at: old }).where("id", "=", onChain.id).execute();

  assert.equal(await scheduler.purgeDraftsOnce(), 1);

  const remaining = await db.selectFrom("submission").select(["id", "escrow_ref"]).orderBy("escrow_ref").execute();
  assert.deepEqual(
    remaining.map((r) => r.escrow_ref),
    ["fresh", "onchain"]
  );
  assert.ok(remaining.some((r) => r.id === recent.id), "recent draft kept");
  assert.ok(remaining.some((r) => r.id === onChain.id), "on-chain submission never purged");

  // Idempotent: a second pass purges nothing.
  assert.equal(await scheduler.purgeDraftsOnce(), 0);
});

test("sweepOnce finalizes a due submission once; the second pass is a no-op", skip, async () => {
  const { db, chain, scheduler } = ctx!;
  const market = await seedMarketplace(db);
  const sub = await seedSubmission(db, market.id, {
    chain_submission_id: "7",
    status: "pending",
    submitted_at: new Date(Date.now() - 2 * 3600 * 1000),
    challenge_window_s: 600,
    finalize_attempted_at: null,
  });
  let finalizeCalls = 0;
  stubChain(ctx!.chain, {
    finalizeOnChain: async () => {
      finalizeCalls++;
      return { status: "verified", txHash: "tx-sweep" };
    },
    // recordTerminalVerdict back-fills resolution_method from the chain record.
    readSubmission: async () =>
      chainSubmissionRecord({ finalized: true, verdict: ["Verified"], resolution_method: ["ReexecutionConsensus"] }),
  });

  assert.equal(await scheduler.sweepOnce(), 1);
  let row = await db.selectFrom("submission").select(["status", "finalize_attempted_at", "finalize_tx_hash"]).where("id", "=", sub.id).executeTakeFirstOrThrow();
  assert.equal(row.status, "verified");
  assert.equal(row.finalize_tx_hash, "tx-sweep");
  assert.ok(row.finalize_attempted_at);

  // Second pass: the submission is no longer pending, so nothing is due.
  assert.equal(await scheduler.sweepOnce(), 0);
  assert.equal(finalizeCalls, 1, "finalize called exactly once");
});

test("reconcileOnce adopts a terminal chain verdict and is idempotent", skip, async () => {
  const { db, chain, scheduler } = ctx!;
  const market = await seedMarketplace(db);
  const sub = await seedSubmission(db, market.id, { chain_submission_id: "7", status: "pending" });
  stubChain(ctx!.chain, {
    readSubmission: async () =>
      chainSubmissionRecord({ finalized: true, verdict: ["Verified"], resolution_method: ["ReexecutionConsensus"] }),
  });

  assert.equal(await scheduler.reconcileOnce(), 1);
  let row = await db.selectFrom("submission").select(["status"]).where("id", "=", sub.id).executeTakeFirstOrThrow();
  assert.equal(row.status, "verified");

  assert.equal(await scheduler.reconcileOnce(), 0);
  row = await db.selectFrom("submission").select(["status"]).where("id", "=", sub.id).executeTakeFirstOrThrow();
  assert.equal(row.status, "verified");
});

test("earlyFinalizeOnce only finalizes when the chain record shows consensus", skip, async () => {
  const { db, chain, scheduler } = ctx!;
  const market = await seedMarketplace(db);
  const rex = await seedReexecutor(db, REX1);
  const sub = await seedSubmission(db, market.id, { chain_submission_id: "7", status: "pending" });
  await db
    .insertInto("replay")
    .values({ submission_id: sub.id, reexecutor_id: rex.id, status: "confirmed_onchain", match: true, tx_hash: "tx-vote-1" })
    .execute();

  // No consensus yet: votes below quorum -> nothing happens.
  let calls = stubChain(ctx!.chain, {
    readSubmission: async () => chainSubmissionRecord({ finalized: false, match_votes: 1, mismatch_votes: 0 }),
  });
  assert.equal(await scheduler.earlyFinalizeOnce(), 1); // one candidate considered
  assert.equal(calls.finalize, 0, "no finalize without consensus");
  let row = await db.selectFrom("submission").select(["status"]).where("id", "=", sub.id).executeTakeFirstOrThrow();
  assert.equal(row.status, "pending");

  // Consensus reached: bonded supermajority of matched votes -> finalize.
  calls = stubChain(ctx!.chain, {
    readSubmission: async () =>
      chainSubmissionRecord({
        finalized: false,
        match_votes: 2,
        mismatch_votes: 0,
        bonded_weight_matched: 2000n,
        bonded_weight_mismatched: 0n,
        cfg_quorum_min_reexecutors: 2,
        cfg_quorum_supermajority_bps: 6600,
      }),
  });
  assert.equal(await scheduler.earlyFinalizeOnce(), 1);
  assert.equal(calls.finalize, 1);
  row = await db.selectFrom("submission").select(["status"]).where("id", "=", sub.id).executeTakeFirstOrThrow();
  assert.equal(row.status, "verified");
});
