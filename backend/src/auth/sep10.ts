import { Keypair, WebAuth } from "@stellar/stellar-sdk";
import jwt from "jsonwebtoken";
import { env } from "../config/env.js";
import { keeperKeypair } from "../chain/keeper.js";

/** Verity's own SEP-10 signing key. Reusing the keeper key is fine here —
 * signing a WebAuth challenge grants no on-chain authority, unlike the
 * keeper's escrow-gate calls. */
const serverKeypair: Keypair = keeperKeypair;

export function buildChallenge(clientAccountId: string, homeDomain: string) {
  return WebAuth.buildChallengeTx(
    serverKeypair,
    clientAccountId,
    homeDomain,
    300,
    env.NETWORK_PASSPHRASE,
    env.WEB_AUTH_DOMAIN
  );
}

/**
 * Verifies the returned challenge really was signed by the claimed account's
 * key — a real Ed25519 signature check against the transaction hash, not a
 * trust-the-client-claim. v1 simplification: checks that the client account
 * itself signed (single-signer assumption), not full weighted-multisig
 * threshold — that needs a Horizon signer-weight lookup, left as a documented
 * follow-up rather than faked.
 */
export function verifyChallenge(signedChallengeXdr: string): { account: string } {
  const { tx, clientAccountID } = WebAuth.readChallengeTx(
    signedChallengeXdr,
    serverKeypair.publicKey(),
    env.NETWORK_PASSPHRASE,
    [env.HOME_DOMAIN],
    env.WEB_AUTH_DOMAIN
  );
  const signers = WebAuth.verifyChallengeTxSigners(
    tx.toXDR(),
    serverKeypair.publicKey(),
    env.NETWORK_PASSPHRASE,
    [clientAccountID],
    [env.HOME_DOMAIN],
    env.WEB_AUTH_DOMAIN
  );
  if (!signers.includes(clientAccountID)) {
    throw new Error("Challenge transaction was not signed by the claimed account");
  }
  return { account: clientAccountID };
}

export function issueJwt(account: string): string {
  return jwt.sign({ sub: account }, env.JWT_SECRET, { expiresIn: "1h" });
}

export function verifyJwt(token: string): { sub: string } {
  return jwt.verify(token, env.JWT_SECRET) as { sub: string };
}
