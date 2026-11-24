import { Keypair, StrKey, WebAuth, xdr } from "@stellar/stellar-sdk";
import jwt from "jsonwebtoken";
import { env } from "../config/env.js";
import { keeperKeypair } from "../chain/keeper.js";
import { server } from "../chain/rpc.js";
import { HttpError } from "../http-error.js";

/** Verity's own SEP-10 signing key. Signing a WebAuth challenge grants no
 * on-chain authority, so falling back to the keeper key is safe — but a
 * deployment should set SEP10_SIGNING_SECRET so the key that pays for keeper
 * transactions is not the one exercised by every login. */
const serverKeypair: Keypair = env.SEP10_SIGNING_SECRET
  ? Keypair.fromSecret(env.SEP10_SIGNING_SECRET)
  : keeperKeypair;
export const sep10SigningKey = serverKeypair.publicKey();

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

export type AccountLookup = (clientAccountId: string) => Promise<xdr.AccountEntry | null>;

export async function defaultAccountLookup(clientAccountId: string): Promise<xdr.AccountEntry | null> {
  try {
    const ledgerKey = xdr.LedgerKey.account(
      new xdr.LedgerKeyAccount({
        accountId: Keypair.fromPublicKey(clientAccountId).xdrPublicKey(),
      })
    );
    const response = await server.getLedgerEntries(ledgerKey);
    const entry = response.entries?.[0];
    if (!entry) return null;
    return typeof (entry.val as any).account === "function"
      ? (entry.val as any).account()
      : (entry.val as any).account;
  } catch (err) {
    if (err instanceof HttpError) throw err;
    throw new HttpError(503, `Soroban RPC unavailable: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/**
 * Verifies the returned challenge really was signed by authorized signers for
 * the claimed account. For an existing on-chain account, fetches its signers
 * and requires the signatures to meet its medium threshold (with a minimum
 * threshold of 1 so a revoked master key with weight 0 cannot sign in). If the
 * account does not yet exist on-chain, falls back to verifying that the claimed
 * account's master key itself signed.
 */
export async function verifyChallenge(
  signedChallengeXdr: string,
  accountLookup: AccountLookup = defaultAccountLookup
): Promise<{ account: string }> {
  const { tx, clientAccountID } = WebAuth.readChallengeTx(
    signedChallengeXdr,
    serverKeypair.publicKey(),
    env.NETWORK_PASSPHRASE,
    [env.HOME_DOMAIN],
    env.WEB_AUTH_DOMAIN
  );

  let accountEntry: xdr.AccountEntry | null;
  try {
    accountEntry = await accountLookup(clientAccountID);
  } catch (err) {
    if (err instanceof HttpError) throw err;
    throw new HttpError(503, `Soroban RPC unavailable: ${err instanceof Error ? err.message : String(err)}`);
  }

  if (!accountEntry) {
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

  const thresholds = (accountEntry.thresholds as any).value ?? accountEntry.thresholds;
  const masterWeight = thresholds[0];
  const signerMap = new Map<string, { key: string; weight: number; type: string }>();
  signerMap.set(clientAccountID, { key: clientAccountID, weight: masterWeight, type: "ed25519_public_key" });

  for (const signer of accountEntry.signers) {
    if (signer.key.type === "signerKeyTypeEd25519") {
      const raw = (signer.key.ed25519 as any).value ?? signer.key.ed25519;
      const key = StrKey.encodeEd25519PublicKey(raw);
      signerMap.set(key, { key, weight: signer.weight, type: "ed25519_public_key" });
    }
  }

  const signerSummary = Array.from(signerMap.values());
  const mediumThreshold = thresholds[2];
  const requiredThreshold = Math.max(1, mediumThreshold);

  WebAuth.verifyChallengeTxThreshold(
    tx.toXDR(),
    serverKeypair.publicKey(),
    env.NETWORK_PASSPHRASE,
    requiredThreshold,
    signerSummary,
    [env.HOME_DOMAIN],
    env.WEB_AUTH_DOMAIN
  );

  return { account: clientAccountID };
}

export function issueJwt(account: string): string {
  return jwt.sign({ sub: account }, env.JWT_SECRET, { expiresIn: "1h" });
}

export function verifyJwt(token: string): { sub: string } {
  return jwt.verify(token, env.JWT_SECRET) as { sub: string };
}
