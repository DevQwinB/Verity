import { createHash } from "node:crypto";
import type { SubmissionRecord } from "escrow-gate";
import { ReplayInfrastructureError } from "./sandbox/runner.js";
import { RetrievalTransientError } from "./sandbox/retrieval.js";
import { NO_OUTPUT_HASH, voteMatches } from "./vote.js";

export interface Assignment {
  function_ref: string | null;
  input_ref: string | null;
  chain_submission_id: string;
}

export interface WorkerLogger {
  log: (...args: unknown[]) => void;
  warn: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
}

export interface WorkerConfig {
  retryBudgetS: number;
  connectivityUrl: string;
}

export interface WorkerDeps {
  api: <T>(path: string, init?: { method?: string; body?: unknown }) => Promise<T>;
  getSubmission: (id: bigint) => Promise<SubmissionRecord | null | undefined>;
  attest: (params: {
    submissionId: bigint;
    outputHash: Buffer;
    matched: boolean;
  }) => Promise<{ hash?: string }>;
  fetchArtifact: (ref: string) => Promise<Buffer>;
  runDeterministicFunction: (source: string, input: unknown) => Promise<{ outputHash: string; engine: string }>;
  runRetrieval: (spec: any) => Promise<{ outputHash: string; output: unknown; engine: string }>;
  hasConnectivity: (url: string) => Promise<boolean>;
  now?: () => number;
  config: WorkerConfig;
  log?: WorkerLogger;
  publicKey?: string;
}

export function createWorker(deps: WorkerDeps) {
  const nowMs = deps.now ?? (() => Date.now());
  const nowS = () => nowMs() / 1000;
  const logger = deps.log ?? console;
  const tag = deps.publicKey ? `[reexecutor ${deps.publicKey.slice(0, 8)}]` : "[reexecutor]";

  const noOutput = (why: string) => ({ outputHash: NO_OUTPUT_HASH, engine: why });
  const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString("hex");

  const firstUnreachableAt = new Map<string, number>();
  const attested = new Set<string>();
  let votingBlockedUntil = 0;

  function pruneToListed(listed: ReadonlySet<string>) {
    for (const id of attested) if (!listed.has(id)) attested.delete(id);
    for (const id of firstUnreachableAt.keys()) if (!listed.has(id)) firstUnreachableAt.delete(id);
  }

  async function reExecute(
    a: Assignment,
    record: SubmissionRecord
  ): Promise<{ outputHash: string; engine: string }> {
    if (!a.input_ref) return noOutput("none (no input artifact declared)");
    const inputBytes = await deps.fetchArtifact(a.input_ref);
    if (createHash("sha256").update(inputBytes).digest("hex") !== hex(record.input_hash)) {
      throw new Error("backend served an input artifact that does not match the on-chain input_hash");
    }

    if (record.task_type.tag === "Retrieval") {
      let spec;
      try {
        spec = JSON.parse(inputBytes.toString("utf8"));
      } catch {
        return noOutput("retrieval failed: the request spec is not JSON");
      }
      try {
        return await deps.runRetrieval(spec);
      } catch (err) {
        const message = (err as Error).message;
        if (!(err instanceof RetrievalTransientError)) return noOutput(`retrieval failed: ${message}`);

        const currentNow = nowS();
        const first = firstUnreachableAt.get(a.chain_submission_id) ?? currentNow;
        firstUnreachableAt.set(a.chain_submission_id, first);
        const budget = Math.min(deps.config.retryBudgetS, Number(record.challenge_window_s) / 2);
        const giveUpAt = Math.max(Number(record.submitted_at), first) + budget;
        if (currentNow < giveUpAt) {
          throw new Error(
            `retrieval inconclusive (${message}); retrying for another ${Math.ceil(giveUpAt - currentNow)}s before judging`
          );
        }
        if (!(await deps.hasConnectivity(deps.config.connectivityUrl))) {
          throw new Error(`retrieval inconclusive (${message}) and this host has no outbound connectivity; not voting`);
        }
        return noOutput(
          `retrieval failed: target unreachable for ${Math.round(budget)}s while this host was online (${message})`
        );
      }
    }

    if (!a.function_ref) return noOutput("none (no function artifact declared)");
    const functionSource = (await deps.fetchArtifact(a.function_ref)).toString("utf8");
    let input: unknown;
    try {
      input = JSON.parse(inputBytes.toString("utf8"));
    } catch {
      return noOutput("replay failed: the input artifact is not JSON");
    }
    try {
      return await deps.runDeterministicFunction(functionSource, input);
    } catch (err) {
      if (err instanceof ReplayInfrastructureError) throw err;
      return noOutput(`replay failed: ${(err as Error).message}`);
    }
  }

  async function processAssignment(a: Assignment) {
    if (attested.has(a.chain_submission_id)) return;
    const record = await deps.getSubmission(BigInt(a.chain_submission_id));
    if (!record) throw new Error("submission is not on-chain (yet)");
    if (record.finalized) {
      attested.add(a.chain_submission_id);
      firstUnreachableAt.delete(a.chain_submission_id);
      return;
    }

    logger.log(`${tag} re-executing ${record.task_type.tag.toLowerCase()} submission #${a.chain_submission_id}`);
    const { outputHash, engine } = await reExecute(a, record);
    const claimed = hex(record.claimed_output_hash);
    const matched = voteMatches(outputHash, claimed);
    logger.log(`${tag}   engine=${engine}`);
    logger.log(`${tag}   output=${outputHash} claimed=${claimed} matched=${matched}`);

    try {
      const res = await deps.attest({
        submissionId: BigInt(a.chain_submission_id),
        outputHash: Buffer.from(outputHash, "hex"),
        matched,
      });
      logger.log(`${tag}   attest_replay tx: ${res?.hash ?? "(confirmed)"}`);
    } catch (err) {
      const code = /Error\(Contract, #(\d+)\)/.exec((err as Error).message ?? "")?.[1];
      if (code === "20" || code === "27") {
        votingBlockedUntil = nowMs() + 60_000;
        logger.warn(
          `${tag}   EscrowGate refused the vote: this account is ${code === "20" ? "not active (stake below the floor)" : "not approved as a voter"}. Pausing work for 60s.`
        );
        return;
      }
      if (code !== "23" && code !== "32") throw err;
      logger.log(`${tag}   nothing to do (already attested or already finalized)`);
    }
    attested.add(a.chain_submission_id);
    firstUnreachableAt.delete(a.chain_submission_id);
  }

  async function pollOnce(reexecutorId: string) {
    const { replay_assignments, spot_check_assignments } = await deps.api<{
      replay_assignments: Assignment[];
      spot_check_assignments: Assignment[];
    }>(`/v1/reexecutors/${reexecutorId}/assignments`);

    pruneToListed(new Set([...replay_assignments, ...spot_check_assignments].map((a) => a.chain_submission_id)));

    if (nowMs() < votingBlockedUntil) return;
    for (const assignment of [...replay_assignments, ...spot_check_assignments]) {
      try {
        await processAssignment(assignment);
      } catch (err) {
        logger.error(
          `${tag}   assignment #${assignment.chain_submission_id} failed, will retry:`,
          (err as Error).message
        );
      }
    }
  }

  return {
    reExecute,
    processAssignment,
    pollOnce,
    pruneToListed,
    getState: () => ({
      attested,
      firstUnreachableAt,
      votingBlockedUntil,
    }),
    isAttested: (id: string) => attested.has(id),
    isVotingBlocked: () => nowMs() < votingBlockedUntil,
  };
}
