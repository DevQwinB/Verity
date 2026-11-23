import "../test/env-setup.js";
import assert from "node:assert/strict";
import test from "node:test";
import { isDbTestEnabled, setupTestDb, reset, teardownTestDb, db } from "../test/db-harness.js";
import { recordTerminalVerdict } from "../modules/submissions/verdict.js";
import { settleOnce, purgeDraftsOnce, schedulerChain } from "./scheduler.js";

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
        stellar_account: "GB" + "B".repeat(54),
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

test("recordTerminalVerdict called concurrently from two promises dispatches one webhook", {
  skip: !isDbTestEnabled ? "VERITY_DB_TESTS=1 not set" : false,
}, async () => {
  await db
    .insertInto("webhook_subscription")
    .values({
      marketplace_id: defaultMarketplaceId,
      url: "https://127.0.0.1:1/webhook",
      secret: "secret-key",
      events: ["submission.verified"],
      active: true,
    })
    .execute();

  const sub = await db
    .insertInto("submission")
    .values(
      fakeSubmission({
        chain_submission_id: null,
      })
    )
    .returningAll()
    .executeTakeFirstOrThrow();

  // Two concurrent calls
  await Promise.all([
    recordTerminalVerdict(sub.id, "verified", "tx_hash_1"),
    recordTerminalVerdict(sub.id, "verified", "tx_hash_2"),
  ]);

  const updatedSub = await db.selectFrom("submission").selectAll().where("id", "=", sub.id).executeTakeFirstOrThrow();
  assert.equal(updatedSub.status, "verified");

  const deliveries = await db.selectFrom("webhook_delivery").selectAll().execute();
  assert.equal(deliveries.length, 1);
  assert.equal(deliveries[0].event_type, "submission.verified");
});

test("settleOnce does not stamp settled_at before votes are indexed within the grace period", {
  skip: !isDbTestEnabled ? "VERITY_DB_TESTS=1 not set" : false,
}, async () => {
  const sub = await db
    .insertInto("submission")
    .values(
      fakeSubmission({
        chain_submission_id: "200",
        status: "verified",
        settled_at: null,
        updated_at: new Date(), // updated just now (well within SETTLE_GRACE_S = 600s)
      })
    )
    .returningAll()
    .executeTakeFirstOrThrow();

  const rex = await db
    .insertInto("reexecutor")
    .values({
      stellar_account: "GREX1",
      stake_amount: "1000",
      stake_asset: "native",
      active: true,
      approved: true,
    })
    .returningAll()
    .executeTakeFirstOrThrow();

  // 1 indexed vote
  await db
    .insertInto("replay")
    .values({
      submission_id: sub.id,
      reexecutor_id: rex.id,
      status: "confirmed_onchain",
      match: true,
      replay_output_hash: "00".repeat(32),
      tx_hash: "vote_tx_1",
    })
    .execute();

  // Stub on-chain read to report 2 votes (match_votes: 1, mismatch_votes: 1) -> 1 indexed < 2 on-chain
  schedulerChain.readSubmission = async () =>
    ({
      id: 200n,
      match_votes: 1,
      mismatch_votes: 1,
    } as any);

  const settledCount = await settleOnce();
  assert.equal(settledCount, 0);

  const subAfter = await db.selectFrom("submission").selectAll().where("id", "=", sub.id).executeTakeFirstOrThrow();
  assert.equal(subAfter.settled_at, null, "settled_at must not be stamped while votes are still missing within grace period");
});

test("purgeDraftsOnce keeps a draft with a recent updated_at and deletes expired ones", {
  skip: !isDbTestEnabled ? "VERITY_DB_TESTS=1 not set" : false,
}, async () => {
  // Recent draft
  const recent = await db
    .insertInto("submission")
    .values(
      fakeSubmission({
        chain_submission_id: null,
        status: "pending",
        updated_at: new Date(),
      })
    )
    .returningAll()
    .executeTakeFirstOrThrow();

  // Expired draft (updated 2 hours ago, DRAFT_TTL_S defaults to 3600 = 1 hour)
  const expired = await db
    .insertInto("submission")
    .values(
      fakeSubmission({
        chain_submission_id: null,
        status: "pending",
        updated_at: new Date(Date.now() - 7200 * 1000),
      })
    )
    .returningAll()
    .executeTakeFirstOrThrow();

  const deletedCount = await purgeDraftsOnce();
  assert.equal(deletedCount, 1);

  const remainingRecent = await db.selectFrom("submission").selectAll().where("id", "=", recent.id).executeTakeFirst();
  assert.ok(remainingRecent, "recent draft must be kept");

  const remainingExpired = await db.selectFrom("submission").selectAll().where("id", "=", expired.id).executeTakeFirst();
  assert.equal(remainingExpired, undefined, "expired draft must be purged");
});
