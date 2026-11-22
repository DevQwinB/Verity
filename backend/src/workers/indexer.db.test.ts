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
  seedWebhookSubscription,
  deliveryCount,
  type WorkerDbContext,
} from "../test/worker-db.js";

// Postgres-backed handler tests: run only with VERITY_DB_TESTS=1 (CI sets it).
// They drive the real handleEvent/recordTerminalVerdict against an embedded
// Postgres with every chain read stubbed through the seam.
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
const REX2 = Keypair.random().publicKey();
const REX3 = Keypair.random().publicKey();

test("submission_created applied twice produces the same rows", skip, async () => {
  const { db, chain, indexer } = ctx!;
  const market = await seedMarketplace(db);
  await seedReexecutor(db, REX1);
  await seedReexecutor(db, REX2);
  await seedReexecutor(db, REX3);
  await seedSubmission(db, market.id, { chain_tx_hash: "tx-create-1", chain_submission_id: null });
  chain.readSubmission = async () =>
    chainSubmissionRecord({ challenge_window_s: 900n, submitted_at: 1_700_000_000n, escrow_value: 1000n });

  const value = { agent: "GAGENT", escrow_ref: Buffer.alloc(32), escrow_value: 1000n, bond: 50n };
  await indexer.handleEvent(["submission_created", "7"], value, 100, "tx-create-1");

  const subAfterFirst = await db.selectFrom("submission").selectAll().executeTakeFirstOrThrow();
  assert.equal(subAfterFirst.chain_submission_id, "7");
  assert.equal(subAfterFirst.chain_tx_hash, "tx-create-1");
  assert.equal(subAfterFirst.escrow_value, "1000");
  assert.equal(subAfterFirst.challenge_window_s, 900);
  // quorum 2 + REPLAY_OVERASSIGN 1 spare = 3 replay assignments
  assert.equal((await db.selectFrom("replay").selectAll().execute()).length, 3);

  const replaySnapshot = await db.selectFrom("replay").selectAll().orderBy("id").execute();
  await indexer.handleEvent(["submission_created", "7"], value, 100, "tx-create-1");

  const subAfterSecond = await db.selectFrom("submission").selectAll().execute();
  const replayAfterSecond = await db.selectFrom("replay").selectAll().orderBy("id").execute();
  assert.equal(subAfterSecond.length, 1);
  assert.equal(replayAfterSecond.length, replaySnapshot.length);
  assert.deepEqual(
    replayAfterSecond.map((r) => [r.reexecutor_id, r.status, r.assignment_seed]),
    replaySnapshot.map((r) => [r.reexecutor_id, r.status, r.assignment_seed])
  );
});

test("replay_attested applied twice keeps a single confirmed vote", skip, async () => {
  const { db, indexer } = ctx!;
  const market = await seedMarketplace(db);
  const rex = await seedReexecutor(db, REX1);
  const sub = await seedSubmission(db, market.id, { chain_submission_id: "7" });

  const value = { reexecutor: REX1, output_hash: Buffer.from("ab".repeat(32), "hex"), matched: true };
  await indexer.handleEvent(["replay_attested", "7"], value, 101, "tx-vote-1");
  const votesAfterFirst = await db.selectFrom("replay").selectAll().where("submission_id", "=", sub.id).execute();
  assert.equal(votesAfterFirst.length, 1);
  assert.equal(votesAfterFirst[0].status, "confirmed_onchain");
  assert.equal(votesAfterFirst[0].match, true);
  assert.equal(votesAfterFirst[0].tx_hash, "tx-vote-1");
  assert.equal(votesAfterFirst[0].reexecutor_id, rex.id);

  await indexer.handleEvent(["replay_attested", "7"], value, 101, "tx-vote-1");
  const votesAfterSecond = await db.selectFrom("replay").selectAll().where("submission_id", "=", sub.id).execute();
  assert.equal(votesAfterSecond.length, 1);
  // executed_at is re-stamped on every apply by design; everything else must match.
  const { executed_at: _e1, ...firstRest } = votesAfterFirst[0];
  const { executed_at: _e2, ...secondRest } = votesAfterSecond[0];
  assert.deepEqual(secondRest, firstRest);
});

test("challenge_opened applied twice records one challenge and one dispute webhook", skip, async () => {
  const { db, indexer } = ctx!;
  const market = await seedMarketplace(db);
  await seedReexecutor(db, REX1);
  await seedReexecutor(db, REX2);
  await seedReexecutor(db, REX3);
  await seedWebhookSubscription(db, market.id, ["submission.disputed"]);
  const sub = await seedSubmission(db, market.id, { chain_submission_id: "7" });

  const value = { challenger: "GCHALLENGER", bond: 10n };
  await indexer.handleEvent(["challenge_opened", "7"], value, 102, "tx-ch-1");
  await indexer.handleEvent(["challenge_opened", "7"], value, 102, "tx-ch-1");

  const challenges = await db.selectFrom("challenge").selectAll().where("submission_id", "=", sub.id).execute();
  assert.equal(challenges.length, 1);
  assert.equal(challenges[0].chain_tx_hash, "tx-ch-1");
  assert.equal(challenges[0].challenger_account, "GCHALLENGER");

  const subAfter = await db.selectFrom("submission").select(["status"]).where("id", "=", sub.id).executeTakeFirstOrThrow();
  assert.equal(subAfter.status, "disputed");

  // The webhook dispatch is fire-and-forget; exactly one delivery row may appear.
  const deliveries = await deliveryCount(db, "submission.disputed");
  await new Promise((r) => setTimeout(r, 150));
  assert.equal(await deliveryCount(db, "submission.disputed"), deliveries);
  assert.equal(deliveries, 1);
});

test("finalized applied twice records the terminal verdict once and fires one webhook", skip, async () => {
  const { db, indexer } = ctx!;
  const market = await seedMarketplace(db);
  await seedWebhookSubscription(db, market.id, ["submission.verified"]);
  const sub = await seedSubmission(db, market.id, { chain_submission_id: "7" });

  await indexer.handleEvent(["finalized", "7"], { verdict: ["Verified"] }, 103, "tx-fin-1");
  await indexer.handleEvent(["finalized", "7"], { verdict: ["Verified"] }, 103, "tx-fin-1");

  const row = await db.selectFrom("submission").selectAll().where("id", "=", sub.id).executeTakeFirstOrThrow();
  assert.equal(row.status, "verified");
  assert.equal(row.finalize_tx_hash, "tx-fin-1");
  assert.equal(row.resolution_method, "reexecution_consensus");

  const deliveries = await deliveryCount(db, "submission.verified");
  await new Promise((r) => setTimeout(r, 150));
  assert.equal(await deliveryCount(db, "submission.verified"), deliveries);
  assert.equal(deliveries, 1);
});

test("slashed applied twice increments slashed_count exactly once", skip, async () => {
  const { db, chain, indexer } = ctx!;
  const market = await seedMarketplace(db);
  const rex = await seedReexecutor(db, REX1, { slashedCount: 0 });
  await seedSubmission(db, market.id, { chain_submission_id: "7" });
  chain.reexecutorInfo = async () => ({ result: { stake_amount: 80n, active: true, approved: true } });

  const value = { reexecutor: REX1, amount: 20n };
  await indexer.handleEvent(["slashed", "7"], value, 104, "tx-slash-1");
  await indexer.handleEvent(["slashed", "7"], value, 104, "tx-slash-1");

  const events = await db.selectFrom("slashing_event").selectAll().execute();
  assert.equal(events.length, 1);
  assert.equal(events[0].tx_hash, "tx-slash-1");
  assert.equal(events[0].amount, "20");
  assert.equal(events[0].reexecutor_id, rex.id);

  const rexAfter = await db
    .selectFrom("reexecutor")
    .select(["slashed_count", "stake_amount"])
    .where("id", "=", rex.id)
    .executeTakeFirstOrThrow();
  assert.equal(rexAfter.slashed_count, 1);
  // stake re-mirrored from the stubbed chain read
  assert.equal(rexAfter.stake_amount, "80");
});

test("recordTerminalVerdict called concurrently dispatches exactly one webhook", skip, async () => {
  const { db, verdict } = ctx!;
  const market = await seedMarketplace(db);
  await seedWebhookSubscription(db, market.id, ["submission.verified", "submission.slashed"]);
  const sub = await seedSubmission(db, market.id, { chain_submission_id: "7" });

  // Two concurrent calls race on the same row; only the one that performs the
  // pending -> verified transition may dispatch the webhook.
  await Promise.all([
    verdict.recordTerminalVerdict(sub.id, "verified", "tx-race-a"),
    verdict.recordTerminalVerdict(sub.id, "verified", "tx-race-b"),
  ]);
  await verdict.recordTerminalVerdict(sub.id, "verified", "tx-race-c");

  const row = await db.selectFrom("submission").select(["status"]).where("id", "=", sub.id).executeTakeFirstOrThrow();
  assert.equal(row.status, "verified");

  const first = await deliveryCount(db, "submission.verified");
  await new Promise((r) => setTimeout(r, 200));
  const after = await deliveryCount(db, "submission.verified");
  assert.equal(first, 1);
  assert.equal(after, 1, "no further webhook on repeat/concurrent calls");
});
