import type { SubmissionRecord } from "escrow-gate";
import { Errors } from "escrow-gate";
import { escrowGateAsKeeper } from "./clients.js";
import { keeperPublicKey, withKeeperLock } from "./keeper.js";
import { fromChainVerdict, toChainResolutionMethod } from "./mappers.js";

/** Maps "Error(Contract, #11)" in an SDK/RPC error message back to the
 * contract's own error name (BondTooLow), or null if it isn't one. */
export function contractErrorName(err: unknown): string | null {
  const message = err instanceof Error ? err.message : String(err);
  const m = /Error\(Contract, #(\d+)\)/.exec(message);
  if (!m) return null;
  const entry = (Errors as Record<number, { message: string }>)[Number(m[1])];
  return entry?.message ?? `ContractError#${m[1]}`;
}

export async function readSubmission(chainSubmissionId: string): Promise<SubmissionRecord | null> {
  const tx = await escrowGateAsKeeper.get_submission({ id: BigInt(chainSubmissionId) });
  return tx.result ?? null;
}

/** Same arithmetic as the contract's consensus_outcome(): a minimum voter
 * count AND a bonded supermajority in one direction. Used only to decide
 * whether sending a keeper transaction is worthwhile — the contract
 * re-derives the verdict itself and is the sole authority on it. */
export function consensusOutcome(record: SubmissionRecord): "verified" | "slashed" | null {
  const totalVotes = record.match_votes + record.mismatch_votes;
  if (totalVotes < record.cfg_quorum_min_reexecutors) return null;
  const totalWeight = record.bonded_weight_matched + record.bonded_weight_mismatched;
  if (totalWeight <= 0n) return null;
  const rhs = totalWeight * BigInt(record.cfg_quorum_supermajority_bps);
  if (record.bonded_weight_matched * 10000n >= rhs) return "verified";
  if (record.bonded_weight_mismatched * 10000n >= rhs) return "slashed";
  return null;
}

export interface KeeperTxResult {
  status: string;
  txHash: string | null;
}

/** finalize() legitimately has nothing to do in several states — already
 * finalized, or still Pending behind an unresolved challenge that landed a
 * ledger after consensus formed. Simulation then reports a pure read, which
 * the SDK refuses to sign and send; the simulated verdict is the answer. */
export function finalizeOnChain(chainSubmissionId: string): Promise<KeeperTxResult> {
  return withKeeperLock(async () => {
    const tx = await escrowGateAsKeeper.finalize({ submission_id: BigInt(chainSubmissionId) });
    if (tx.isReadCall) {
      return { status: fromChainVerdict(tx.result.unwrap()), txHash: null };
    }
    const sent = await tx.signAndSend();
    return {
      status: fromChainVerdict(sent.result.unwrap()),
      txHash: sent.sendTransactionResponse?.hash ?? null,
    };
  });
}

export function resolveChallengeOnChain(chainSubmissionId: string): Promise<KeeperTxResult> {
  return withKeeperLock(async () => {
    const tx = await escrowGateAsKeeper.resolve_challenge({
      submission_id: BigInt(chainSubmissionId),
      method: toChainResolutionMethod("reexecution_consensus"),
    });
    const sent = await tx.signAndSend();
    return {
      status: fromChainVerdict(sent.result.unwrap()),
      txHash: sent.sendTransactionResponse?.hash ?? null,
    };
  });
}

/** Returns the slash tx hash, or null when there was nothing left to do
 * (already slashed, or the contract says this party was not on the wrong
 * side — the contract, not this caller, decides who is slashable). */
export function slashOnChain(
  chainSubmissionId: string,
  reexecutor: string,
  amount: bigint
): Promise<string | null> {
  return withKeeperLock(async () => {
    try {
      const tx = await escrowGateAsKeeper.slash({
        keeper: keeperPublicKey,
        reexecutor,
        submission_id: BigInt(chainSubmissionId),
        amount,
      });
      const sent = await tx.signAndSend();
      sent.result.unwrap();
      return sent.sendTransactionResponse?.hash ?? null;
    } catch (err) {
      const name = contractErrorName(err);
      if (name === "AlreadySlashed" || name === "PartyNotOnWrongSide") return null;
      throw err;
    }
  });
}

export function releaseAttestationLockOnChain(chainSubmissionId: string, reexecutor: string): Promise<void> {
  return withKeeperLock(async () => {
    try {
      const tx = await escrowGateAsKeeper.release_attestation_lock({
        submission_id: BigInt(chainSubmissionId),
        reexecutor,
      });
      const sent = await tx.signAndSend();
      sent.result.unwrap();
    } catch (err) {
      if (contractErrorName(err) === "AttestationAlreadyReleased") return;
      throw err;
    }
  });
}
