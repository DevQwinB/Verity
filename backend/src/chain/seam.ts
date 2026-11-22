import type { ConfigRecord, SubmissionRecord } from "escrow-gate";
import * as actions from "./actions.js";
import type { KeeperTxResult } from "./actions.js";
import { escrowGateAsKeeper } from "./clients.js";
import { getGateConfig } from "./config.js";

/** The re-executor record the indexer needs from `reexecutor_info`. */
export interface ReexecutorInfo {
  stake_amount: bigint;
  active: boolean;
  approved: boolean;
}

export interface ReexecutorInfoResponse {
  result: ReexecutorInfo | null;
}

/**
 * The narrow seam every worker-side chain read goes through. Production
 * delegates to the real RPC clients; tests replace individual members with
 * stubs (e.g. `chain.readSubmission = async () => stubRecord`) so handler and
 * scheduler logic can be exercised against a real Postgres with the chain
 * stubbed out. Pure helpers (consensusOutcome, minChallengerBond, the mappers)
 * stay direct imports — they never touch the network.
 */
export const chain: {
  readSubmission: (chainSubmissionId: string) => Promise<SubmissionRecord | null>;
  finalizeOnChain: (chainSubmissionId: string) => Promise<KeeperTxResult>;
  resolveChallengeOnChain: (chainSubmissionId: string) => Promise<KeeperTxResult>;
  releaseAttestationLockOnChain: (
    chainSubmissionId: string,
    reexecutor: string
  ) => Promise<string | null>;
  reexecutorInfo: (reexecutor: string) => Promise<ReexecutorInfoResponse>;
  getGateConfig: () => Promise<ConfigRecord>;
} = {
  readSubmission: (chainSubmissionId) => actions.readSubmission(chainSubmissionId),
  finalizeOnChain: (chainSubmissionId) => actions.finalizeOnChain(chainSubmissionId),
  resolveChallengeOnChain: (chainSubmissionId) => actions.resolveChallengeOnChain(chainSubmissionId),
  releaseAttestationLockOnChain: (chainSubmissionId, reexecutor) =>
    actions.releaseAttestationLockOnChain(chainSubmissionId, reexecutor),
  reexecutorInfo: async (reexecutor) =>
    (await escrowGateAsKeeper.reexecutor_info({ reexecutor })) as unknown as ReexecutorInfoResponse,
  getGateConfig: () => getGateConfig(),
};
