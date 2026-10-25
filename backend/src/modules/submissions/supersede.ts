/** A transaction built by the contract client is valid for 5 minutes
 * (stellar-sdk `contract.DEFAULT_TIMEOUT`), plus ledger-close slack. */
export const BUILT_TX_VALIDITY_MS = (5 * 60 + 30) * 1000;

export type ChainTxStatus = "SUCCESS" | "FAILED" | "NOT_FOUND";

/** What a retry of POST /v1/submissions may do with an unconfirmed draft.
 *
 * - `rebuild`: the old transaction cannot land (never broadcast, failed,
 *   or expired), so the draft may point at a freshly built one.
 * - `landed`: the old transaction is on-chain; rebuilding would orphan the
 *   submission it created, so the draft is kept and nothing is left to sign.
 * - `in_flight`: it was broadcast and may still land; rebuilding now would
 *   orphan it, or lock the bond twice if both landed. */
export type SupersedeDecision = "rebuild" | "landed" | "in_flight";

export function decideSupersede(input: {
  relayStartedAt: Date | null;
  chainStatus: ChainTxStatus;
  now?: number;
}): SupersedeDecision {
  if (!input.relayStartedAt) return "rebuild";
  if (input.chainStatus === "SUCCESS") return "landed";
  if (input.chainStatus === "FAILED") return "rebuild";
  const now = input.now ?? Date.now();
  return now - input.relayStartedAt.getTime() < BUILT_TX_VALIDITY_MS ? "in_flight" : "rebuild";
}
