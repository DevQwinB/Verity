import test, { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import type { SubmissionRecord } from "escrow-gate";
import { ReplayInfrastructureError } from "./sandbox/runner.js";
import { RetrievalTransientError } from "./sandbox/retrieval.js";
import { NO_OUTPUT_HASH } from "./vote.js";
import { createWorker, type WorkerDeps, type Assignment } from "./worker.js";

function makeSubmissionRecord(overrides: Partial<SubmissionRecord> = {}): SubmissionRecord {
  const defaultInput = Buffer.from(JSON.stringify({ n: 42 }));
  const inputHash = createHash("sha256").update(defaultInput).digest();

  return {
    id: 1n,
    agent: "GAGENTAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    escrow_ref: Buffer.alloc(32),
    escrow_value: 1000n,
    bond: 100n,
    task_type: { tag: "Deterministic" } as any,
    claimed_output_hash: Buffer.alloc(32),
    submitted_at: 1000n,
    challenge_window_s: 3600n,
    finalized: false,
    resolution_method: null,
    verdict: { tag: "Pending" } as any,
    match_votes: 0n,
    mismatch_votes: 0n,
    input_hash: inputHash,
    ...overrides,
  } as SubmissionRecord;
}

function createFakeDeps(overrides: Partial<WorkerDeps> = {}) {
  const attestedCalls: Array<{ submissionId: bigint; outputHash: Buffer; matched: boolean }> = [];
  let currentTimeMs = 2000 * 1000;

  const defaultInputBytes = Buffer.from(JSON.stringify({ n: 42 }));
  const artifacts = new Map<string, Buffer>([
    ["input-ref", defaultInputBytes],
    ["fn-ref", Buffer.from("return { result: input.n * 2 };")],
  ]);

  const deps: WorkerDeps = {
    api: async <T>() =>
      ({
        replay_assignments: [],
        spot_check_assignments: [],
      } as unknown as T),
    getSubmission: async () => makeSubmissionRecord(),
    attest: async (params) => {
      attestedCalls.push(params);
      return { hash: "tx-hash-123" };
    },
    fetchArtifact: async (ref) => artifacts.get(ref) ?? defaultInputBytes,
    runDeterministicFunction: async () => ({
      outputHash: Buffer.alloc(32).toString("hex"),
      engine: "fake-engine",
    }),
    runRetrieval: async () => ({
      outputHash: Buffer.alloc(32).toString("hex"),
      output: { ok: true },
      engine: "fake-retrieval",
    }),
    hasConnectivity: async () => true,
    now: () => currentTimeMs,
    config: {
      retryBudgetS: 120,
      connectivityUrl: "http://control.test",
    },
    log: {
      log: () => {},
      warn: () => {},
      error: () => {},
    },
    ...overrides,
  };

  return {
    deps,
    attestedCalls,
    setTime: (ms: number) => {
      currentTimeMs = ms;
    },
    advanceSeconds: (s: number) => {
      currentTimeMs += s * 1000;
    },
  };
}

describe("worker assignment and vote logic", () => {
  it("can be imported without env vars and without network access", async () => {
    const mod = await import("./worker.js");
    assert.equal(typeof mod.createWorker, "function");
  });

  it("refuses to vote when input artifact bytes do not match on-chain input_hash", async () => {
    const { deps, attestedCalls } = createFakeDeps({
      fetchArtifact: async () => Buffer.from("corrupted input data"),
    });
    const worker = createWorker(deps);
    const assignment: Assignment = {
      chain_submission_id: "1",
      input_ref: "input-ref",
      function_ref: "fn-ref",
    };

    await assert.rejects(
      () => worker.processAssignment(assignment),
      /backend served an input artifact that does not match the on-chain input_hash/
    );
    assert.equal(attestedCalls.length, 0);
  });

  it("votes mismatch with NO_OUTPUT_HASH when deterministic input artifact is not JSON", async () => {
    const rawNonJson = Buffer.from("invalid json {{{");
    const inputHash = createHash("sha256").update(rawNonJson).digest();
    const { deps, attestedCalls } = createFakeDeps({
      getSubmission: async () => makeSubmissionRecord({ input_hash: inputHash }),
      fetchArtifact: async (ref) => (ref === "input-ref" ? rawNonJson : Buffer.from("return 1;")),
    });
    const worker = createWorker(deps);
    const assignment: Assignment = {
      chain_submission_id: "1",
      input_ref: "input-ref",
      function_ref: "fn-ref",
    };

    await worker.processAssignment(assignment);
    assert.equal(attestedCalls.length, 1);
    assert.equal(attestedCalls[0].matched, false);
    assert.equal(attestedCalls[0].outputHash.toString("hex"), NO_OUTPUT_HASH);
  });

  it("votes mismatch with NO_OUTPUT_HASH when retrieval spec is not JSON", async () => {
    const rawNonJson = Buffer.from("invalid retrieval spec");
    const inputHash = createHash("sha256").update(rawNonJson).digest();
    const { deps, attestedCalls } = createFakeDeps({
      getSubmission: async () =>
        makeSubmissionRecord({
          input_hash: inputHash,
          task_type: { tag: "Retrieval", values: undefined },
        }),
      fetchArtifact: async () => rawNonJson,
    });
    const worker = createWorker(deps);
    const assignment: Assignment = {
      chain_submission_id: "1",
      input_ref: "input-ref",
      function_ref: null,
    };

    await worker.processAssignment(assignment);
    assert.equal(attestedCalls.length, 1);
    assert.equal(attestedCalls[0].matched, false);
    assert.equal(attestedCalls[0].outputHash.toString("hex"), NO_OUTPUT_HASH);
  });

  it("retrieval transient error before giveUpAt throws and does not vote", async () => {
    const validSpec = Buffer.from(JSON.stringify({ url: "https://example.com/api" }));
    const inputHash = createHash("sha256").update(validSpec).digest();
    const submittedAt = 1000n; // second 1000

    const { deps, attestedCalls, setTime } = createFakeDeps({
      getSubmission: async () =>
        makeSubmissionRecord({
          input_hash: inputHash,
          task_type: { tag: "Retrieval", values: undefined },
          submitted_at: submittedAt,
          challenge_window_s: 3600n, // budget = min(120, 1800) = 120
        }),
      fetchArtifact: async () => validSpec,
      runRetrieval: async () => {
        throw new RetrievalTransientError("gateway timeout HTTP 504");
      },
    });

    setTime(1050 * 1000); // 50s elapsed (< 120s budget)
    const worker = createWorker(deps);
    const assignment: Assignment = {
      chain_submission_id: "1",
      input_ref: "input-ref",
      function_ref: null,
    };

    await assert.rejects(
      () => worker.processAssignment(assignment),
      /retrieval inconclusive \(gateway timeout HTTP 504\); retrying for another/
    );
    assert.equal(attestedCalls.length, 0);
  });

  it("retrieval transient error after giveUpAt with connectivity votes mismatch", async () => {
    const validSpec = Buffer.from(JSON.stringify({ url: "https://example.com/api" }));
    const inputHash = createHash("sha256").update(validSpec).digest();
    const submittedAt = 1000n;

    const { deps, attestedCalls, setTime } = createFakeDeps({
      getSubmission: async () =>
        makeSubmissionRecord({
          input_hash: inputHash,
          task_type: { tag: "Retrieval", values: undefined },
          submitted_at: submittedAt,
          challenge_window_s: 3600n,
        }),
      fetchArtifact: async () => validSpec,
      runRetrieval: async () => {
        throw new RetrievalTransientError("gateway timeout HTTP 504");
      },
      hasConnectivity: async () => true,
    });

    // First attempt at t=1000 (firstUnreachable recorded as 1000)
    setTime(1000 * 1000);
    const worker = createWorker(deps);
    const assignment: Assignment = {
      chain_submission_id: "1",
      input_ref: "input-ref",
      function_ref: null,
    };

    await assert.rejects(() => worker.processAssignment(assignment));
    assert.equal(attestedCalls.length, 0);

    // Second attempt at t=1125 (> 1000 + 120 budget)
    setTime(1125 * 1000);
    await worker.processAssignment(assignment);
    assert.equal(attestedCalls.length, 1);
    assert.equal(attestedCalls[0].matched, false);
    assert.equal(attestedCalls[0].outputHash.toString("hex"), NO_OUTPUT_HASH);
  });

  it("retrieval transient error after giveUpAt without connectivity throws and does not vote", async () => {
    const validSpec = Buffer.from(JSON.stringify({ url: "https://example.com/api" }));
    const inputHash = createHash("sha256").update(validSpec).digest();
    const submittedAt = 1000n;

    const { deps, attestedCalls, setTime } = createFakeDeps({
      getSubmission: async () =>
        makeSubmissionRecord({
          input_hash: inputHash,
          task_type: { tag: "Retrieval", values: undefined },
          submitted_at: submittedAt,
          challenge_window_s: 3600n,
        }),
      fetchArtifact: async () => validSpec,
      runRetrieval: async () => {
        throw new RetrievalTransientError("gateway timeout HTTP 504");
      },
      hasConnectivity: async () => false,
    });

    setTime(1000 * 1000);
    const worker = createWorker(deps);
    const assignment: Assignment = {
      chain_submission_id: "1",
      input_ref: "input-ref",
      function_ref: null,
    };

    // First attempt
    await assert.rejects(() => worker.processAssignment(assignment));

    // Past budget, but no connectivity
    setTime(1150 * 1000);
    await assert.rejects(
      () => worker.processAssignment(assignment),
      /this host has no outbound connectivity; not voting/
    );
    assert.equal(attestedCalls.length, 0);
  });

  it("guest error in deterministic replay votes mismatch with NO_OUTPUT_HASH", async () => {
    const { deps, attestedCalls } = createFakeDeps({
      runDeterministicFunction: async () => {
        throw new Error("guest syntax error or thrown exception");
      },
    });
    const worker = createWorker(deps);
    const assignment: Assignment = {
      chain_submission_id: "1",
      input_ref: "input-ref",
      function_ref: "fn-ref",
    };

    await worker.processAssignment(assignment);
    assert.equal(attestedCalls.length, 1);
    assert.equal(attestedCalls[0].matched, false);
    assert.equal(attestedCalls[0].outputHash.toString("hex"), NO_OUTPUT_HASH);
  });

  it("ReplayInfrastructureError in deterministic replay throws and does not vote", async () => {
    const { deps, attestedCalls } = createFakeDeps({
      runDeterministicFunction: async () => {
        throw new ReplayInfrastructureError("host failed to spawn worker thread");
      },
    });
    const worker = createWorker(deps);
    const assignment: Assignment = {
      chain_submission_id: "1",
      input_ref: "input-ref",
      function_ref: "fn-ref",
    };

    await assert.rejects(
      () => worker.processAssignment(assignment),
      /host failed to spawn worker thread/
    );
    assert.equal(attestedCalls.length, 0);
  });

  it("contract error #23 (AlreadyAttested) marks assignment done without rethrowing", async () => {
    const { deps } = createFakeDeps({
      attest: async () => {
        throw new Error("HostError: Error(Contract, #23)");
      },
    });
    const worker = createWorker(deps);
    const assignment: Assignment = {
      chain_submission_id: "1",
      input_ref: "input-ref",
      function_ref: "fn-ref",
    };

    // Does not throw
    await worker.processAssignment(assignment);
    assert.equal(worker.isAttested("1"), true);
  });

  it("contract error #20 (ReexecutorNotActive) pauses voting for 60s", async () => {
    const { deps, setTime } = createFakeDeps({
      attest: async () => {
        throw new Error("HostError: Error(Contract, #20)");
      },
    });
    setTime(10_000);
    const worker = createWorker(deps);
    const assignment: Assignment = {
      chain_submission_id: "1",
      input_ref: "input-ref",
      function_ref: "fn-ref",
    };

    await worker.processAssignment(assignment);
    assert.equal(worker.isVotingBlocked(), true);
    assert.equal(worker.getState().votingBlockedUntil, 70_000);

    // After 60s, voting unblocks
    setTime(70_001);
    assert.equal(worker.isVotingBlocked(), false);
  });

  it("finalized submission is marked done without voting", async () => {
    const { deps, attestedCalls } = createFakeDeps({
      getSubmission: async () => makeSubmissionRecord({ finalized: true }),
    });
    const worker = createWorker(deps);
    const assignment: Assignment = {
      chain_submission_id: "1",
      input_ref: "input-ref",
      function_ref: "fn-ref",
    };

    await worker.processAssignment(assignment);
    assert.equal(attestedCalls.length, 0);
    assert.equal(worker.isAttested("1"), true);
  });

  it("pruneToListed only prunes after a successful poll", async () => {
    let apiShouldFail = true;
    const { deps } = createFakeDeps({
      api: async <T>() => {
        if (apiShouldFail) throw new Error("network down");
        return {
          replay_assignments: [{ chain_submission_id: "1", function_ref: null, input_ref: null }],
          spot_check_assignments: [],
        } as unknown as T;
      },
    });

    const worker = createWorker(deps);
    // Manually add id 2 to attested
    worker.getState().attested.add("2");
    assert.equal(worker.isAttested("2"), true);

    // Failing poll: id 2 is not pruned
    await assert.rejects(() => worker.pollOnce("rex-1"));
    assert.equal(worker.isAttested("2"), true);

    // Successful poll listing only id 1: id 2 is pruned
    apiShouldFail = false;
    await worker.pollOnce("rex-1");
    assert.equal(worker.isAttested("2"), false);
  });
});
