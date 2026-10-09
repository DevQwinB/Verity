import { Keypair } from "@stellar/stellar-sdk";
import { basicNodeSigner } from "@stellar/stellar-sdk/contract";
import { env } from "../config/env.js";

/**
 * Verity's own signing key for admin/keeper-driven on-chain calls
 * (finalize sweeps, slash execution, resolve_challenge). Never a user's
 * key — users always sign their own submit/challenge/stake transactions
 * client-side via the build-sign-relay-confirm flow (see routes.ts files).
 */
export const keeperKeypair = Keypair.fromSecret(env.KEEPER_SECRET_KEY);
export const keeperSigner = basicNodeSigner(keeperKeypair, env.NETWORK_PASSPHRASE);
export const keeperPublicKey = keeperKeypair.publicKey();

/** Every keeper-signed transaction shares one account sequence number, and
 * the indexer and scheduler loops run concurrently — so all keeper sends go
 * through this single-file queue, or two of them race on the same sequence
 * and one is rejected with txBadSeq. */
let keeperQueue: Promise<unknown> = Promise.resolve();
export function withKeeperLock<T>(fn: () => Promise<T>): Promise<T> {
  const run = keeperQueue.then(fn, fn);
  keeperQueue = run.catch(() => undefined);
  return run;
}
