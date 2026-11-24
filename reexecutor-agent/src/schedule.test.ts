import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Keypair, StrKey } from "@stellar/stellar-sdk";

process.env.NODE_ENV = "test";
process.env.ESCROW_GATE_CONTRACT_ID = StrKey.encodeContract(Buffer.alloc(32));
process.env.REEXECUTOR_SECRET_KEY = Keypair.random().secret();

const {
  calculateBackoffMs,
  pruneToListed,
  sortAssignmentsByDeadline,
  submissionSchedules,
  firstUnreachableAt,
  attested,
} = await import("./index.js");

describe("calculateBackoffMs", () => {
  it("exponentially scales backoff with jitter bounded", () => {
    const b0 = calculateBackoffMs(0, 3000);
    assert(b0 >= 3000 * 0.8 && b0 <= 3000 * 1.2);

    const b1 = calculateBackoffMs(1, 3000);
    assert(b1 >= 6000 * 0.8 && b1 <= 6000 * 1.2);

    const b2 = calculateBackoffMs(2, 3000);
    assert(b2 >= 12000 * 0.8 && b2 <= 12000 * 1.2);

    const bHigh = calculateBackoffMs(10, 3000);
    // Capped at 60s
    assert(bHigh >= 60000 * 0.8 && bHigh <= 60000 * 1.2);
  });
});

describe("pruneToListed", () => {
  it("drops state for submissions no longer listed", () => {
    attested.add("sub-1");
    attested.add("sub-2");
    firstUnreachableAt.set("sub-1", 100);
    firstUnreachableAt.set("sub-2", 200);
    submissionSchedules.set("sub-1", { nextAttemptAt: 500, attempts: 1 });
    submissionSchedules.set("sub-2", { nextAttemptAt: 600, attempts: 2 });

    pruneToListed(new Set(["sub-1"]));

    assert.equal(attested.has("sub-1"), true);
    assert.equal(attested.has("sub-2"), false);
    assert.equal(firstUnreachableAt.has("sub-1"), true);
    assert.equal(firstUnreachableAt.has("sub-2"), false);
    assert.equal(submissionSchedules.has("sub-1"), true);
    assert.equal(submissionSchedules.has("sub-2"), false);

    // Clean up
    attested.clear();
    firstUnreachableAt.clear();
    submissionSchedules.clear();
  });
});

describe("sortAssignmentsByDeadline", () => {
  it("sorts assignments with known deadlines first and earliest deadline first", () => {
    submissionSchedules.set("1", {
      nextAttemptAt: 0,
      attempts: 0,
      record: {
        submitted_at: 1000n,
        challenge_window_s: 600n, // deadline 1600
      } as any,
    });
    submissionSchedules.set("2", {
      nextAttemptAt: 0,
      attempts: 0,
      record: {
        submitted_at: 1000n,
        challenge_window_s: 200n, // deadline 1200
      } as any,
    });
    // submission 3 has no cached record yet (deadline Infinity)

    const list = [
      { chain_submission_id: "3", function_ref: null, input_ref: null },
      { chain_submission_id: "1", function_ref: null, input_ref: null },
      { chain_submission_id: "2", function_ref: null, input_ref: null },
    ];

    const sorted = sortAssignmentsByDeadline(list);
    assert.deepEqual(
      sorted.map((s) => s.chain_submission_id),
      ["2", "1", "3"]
    );

    submissionSchedules.clear();
  });
});
