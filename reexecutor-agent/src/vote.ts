/** 32 zero bytes: the recorded output hash when the declared work could not
 * be reproduced at all (it threw, exceeded the sandbox's limits, or its
 * artifacts are missing or malformed). That is itself a mismatch with
 * whatever the agent claimed. */
export const NO_OUTPUT_HASH = "0".repeat(64);

/** Whether a replay agrees with the claimed output. The "could not reproduce"
 * placeholder never agrees, even when the agent committed to that same
 * placeholder as its claimed output; otherwise a submission whose function
 * always fails would be verified by every honest re-executor. */
export function voteMatches(outputHash: string, claimedOutputHash: string): boolean {
  return outputHash !== NO_OUTPUT_HASH && outputHash === claimedOutputHash;
}
