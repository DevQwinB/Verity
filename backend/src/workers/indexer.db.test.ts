import "../test/env-setup.js";
import assert from "node:assert/strict";
import test from "node:test";
import { isDbTestEnabled, setupTestDb, reset, teardownTestDb, db } from "../test/db-harness.js";
import { handleEvent, indexerChain } from "./indexer.js";
import { verdictChain } from "../modules/submissions/verdict.js";

test.before(async () => {
  if (isDbTestEnabled) {
    await setupTestDb();
  }
});

test.after(async () => {
  if (isDbTestEnabled) {
    await teardownTestDb();
  }
});

let defaultMarketplaceId: string;

test.beforeEach(async () => {
  if (isDbTestEnabled) {
    await reset();
    const mkt = await db
      .insertInto("marketplace")
      .values({
        stellar_account: "GA" + "A".repeat(54),
        name: "Test Marketplace",
      })
      .returningAll()
      .executeTakeFirstOrThrow();
    defaultMarketplaceId = mkt.id;
  }
});

function fakeSubmission(overrides: Record<string, any> = {}) {
  return {
    escrow_ref: "00".repeat(32),
    marketplace_id: defaultMarketplaceId,
    agent_id: "agent-1",
    task_type: "deterministic" as const,
    input_hash: "11".repeat(32),
    claimed_output_hash: "22".repeat(32),
    bond_amount: "100",
    bond_asset: "native",
    escrow_value: "1000",
    challenge_window_s: 300,
    status: "pending" as const,
    ...overrides,
  };
}

test("each event type twice in a row produces the same rows (idempotence)", {
  skip: !isDbTestEnabled ? "VERITY_DB_TESTS=1 not set" : false,
}, async () => {
  // 1. submission_created
  // Seed a draft submission that matches chain_tx_hash
  const draftTxHash = "tx_hash_draft_1";
  const draft = await db
    .insertInto("submission")
    .values(fakeSubmission({ chain_tx_hash: draftTxHash }))
    .returningAll()
    .executeTakeFirstOrThrow();

  indexerChain.assignReplayJobs = async () => {};
  indexerChain.escalateToFullReplay = async () => {};
  verdictChain.readSubmission = async () => null;
  indexerChain.readSubmission = async () =>
    ({
      id: 1n,
      agent: "GA...",
      escrow_value: 1000n,
      bond_amount: 100n,
      submitted_at: 1700000000n,
      challenge_window_s: 300n,
      cfg_challenger_bond_min_bps: 500,
    } as any);

  const subCreatedTopic = ["submission_created", "1"];
  const subCreatedValue = {
    agent: "GA...",
    escrow_ref: Buffer.alloc(32),
    escrow_value: 1000n,
    bond: 100n,
  };

  // Run twice
  await handleEvent(subCreatedTopic, subCreatedValue, 100, draftTxHash);
  const afterFirstSub = await db.selectFrom("submission").selectAll().where("id", "=", draft.id).executeTakeFirstOrThrow();
  assert.equal(afterFirstSub.chain_submission_id, "1");

  await handleEvent(subCreatedTopic, subCreatedValue, 100, draftTxHash);
  const afterSecondSub = await db.selectFrom("submission").selectAll().where("id", "=", draft.id).executeTakeFirstOrThrow();
  assert.deepEqual(
    { ...afterFirstSub, updated_at: null },
    { ...afterSecondSub, updated_at: null }
  );

  const subs = await db.selectFrom("submission").selectAll().execute();
  assert.equal(subs.length, 1);

  // 2. replay_attested
  const reexecutorAccount = "GDREEXECUTOR1";
  const rex = await db
    .insertInto("reexecutor")
    .values({
      stellar_account: reexecutorAccount,
      stake_amount: "5000",
      stake_asset: "native",
      active: true,
      approved: true,
    })
    .returningAll()
    .executeTakeFirstOrThrow();

  const replayTopic = ["replay_attested", "1"];
  const replayValue = {
    reexecutor: reexecutorAccount,
    output_hash: Buffer.alloc(32, 1),
    matched: true,
  };

  // Run twice
  await handleEvent(replayTopic, replayValue, 101, "vote_tx_1");
  const replaysFirst = await db.selectFrom("replay").selectAll().where("submission_id", "=", draft.id).execute();
  assert.equal(replaysFirst.length, 1);
  assert.equal(replaysFirst[0].status, "confirmed_onchain");

  await handleEvent(replayTopic, replayValue, 101, "vote_tx_1");
  const replaysSecond = await db.selectFrom("replay").selectAll().where("submission_id", "=", draft.id).execute();
  assert.equal(replaysSecond.length, 1);
  assert.deepEqual(
    { ...replaysFirst[0], executed_at: null },
    { ...replaysSecond[0], executed_at: null }
  );

  // 3. challenge_opened
  const chalTopic = ["challenge_opened", "1"];
  const chalValue = {
    challenger: "GCHALLENGER1",
    bond: 500n,
  };

  // Run twice
  await handleEvent(chalTopic, chalValue, 102, "chal_tx_1");
  const challengesFirst = await db.selectFrom("challenge").selectAll().where("submission_id", "=", draft.id).execute();
  assert.equal(challengesFirst.length, 1);
  const subAfterChal1 = await db.selectFrom("submission").selectAll().where("id", "=", draft.id).executeTakeFirstOrThrow();
  assert.equal(subAfterChal1.status, "disputed");

  await handleEvent(chalTopic, chalValue, 102, "chal_tx_1");
  const challengesSecond = await db.selectFrom("challenge").selectAll().where("submission_id", "=", draft.id).execute();
  assert.equal(challengesSecond.length, 1);
  assert.deepEqual(challengesFirst[0], challengesSecond[0]);

  // 4. finalized
  const finalizedTopic = ["finalized", "1"];
  const finalizedValue = {
    verdict: { tag: "Verified", values: undefined },
  };

  // Run twice
  await handleEvent(finalizedTopic, finalizedValue, 103, "finalize_tx_1");
  const subAfterFin1 = await db.selectFrom("submission").selectAll().where("id", "=", draft.id).executeTakeFirstOrThrow();
  assert.equal(subAfterFin1.status, "verified");

  await handleEvent(finalizedTopic, finalizedValue, 103, "finalize_tx_1");
  const subAfterFin2 = await db.selectFrom("submission").selectAll().where("id", "=", draft.id).executeTakeFirstOrThrow();
  assert.equal(subAfterFin2.status, "verified");

  // 5. slashed
  indexerChain.reexecutorInfo = async () => ({
    active: true,
    approved: true,
    stake_amount: 4500n,
  });

  const slashTopic = ["slashed", "1"];
  const slashValue = {
    reexecutor: reexecutorAccount,
    amount: 500n,
  };

  // Run twice
  await handleEvent(slashTopic, slashValue, 104, "slash_tx_1");
  const slashesFirst = await db.selectFrom("slashing_event").selectAll().where("reexecutor_id", "=", rex.id).execute();
  assert.equal(slashesFirst.length, 1);
  const rexAfterSlash1 = await db.selectFrom("reexecutor").selectAll().where("id", "=", rex.id).executeTakeFirstOrThrow();
  assert.equal(rexAfterSlash1.slashed_count, 1);

  await handleEvent(slashTopic, slashValue, 104, "slash_tx_1");
  const slashesSecond = await db.selectFrom("slashing_event").selectAll().where("reexecutor_id", "=", rex.id).execute();
  assert.equal(slashesSecond.length, 1);
  assert.deepEqual(slashesFirst[0], slashesSecond[0]);

  const rexAfterSlash2 = await db.selectFrom("reexecutor").selectAll().where("id", "=", rex.id).executeTakeFirstOrThrow();
  assert.equal(rexAfterSlash2.slashed_count, 1);
});

test("slashed event increments slashed_count exactly once even on replay", {
  skip: !isDbTestEnabled ? "VERITY_DB_TESTS=1 not set" : false,
}, async () => {
  const account = "GDSLASHED_ONCE";
  const rex = await db
    .insertInto("reexecutor")
    .values({
      stellar_account: account,
      stake_amount: "10000",
      stake_asset: "native",
      active: true,
      approved: true,
      slashed_count: 0,
    })
    .returningAll()
    .executeTakeFirstOrThrow();

  indexerChain.reexecutorInfo = async () => ({
    active: false,
    approved: false,
    stake_amount: 0n,
  });

  const slashTopic = ["slashed", "99"];
  const slashValue = {
    reexecutor: account,
    amount: 10000n,
  };

  await handleEvent(slashTopic, slashValue, 200, "same_tx_hash_123");
  await handleEvent(slashTopic, slashValue, 200, "same_tx_hash_123");
  await handleEvent(slashTopic, slashValue, 200, "same_tx_hash_123");

  const rexUpdated = await db.selectFrom("reexecutor").selectAll().where("id", "=", rex.id).executeTakeFirstOrThrow();
  assert.equal(rexUpdated.slashed_count, 1);

  const slashEvents = await db.selectFrom("slashing_event").selectAll().where("reexecutor_id", "=", rex.id).execute();
  assert.equal(slashEvents.length, 1);
});
