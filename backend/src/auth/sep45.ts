import { Keypair, StrKey, xdr, Address, scValToNative } from "@stellar/stellar-sdk";
import jwt from "jsonwebtoken";
import { env } from "../config/env.js";
import { keeperKeypair } from "../chain/keeper.js";
import { HttpError } from "../http-error.js";

const serverKeypair: Keypair = env.SEP10_SIGNING_SECRET
  ? Keypair.fromSecret(env.SEP10_SIGNING_SECRET)
  : keeperKeypair;

export interface Sep45Challenge {
  client_contract: string;
  server_account: string;
  home_domain: string;
  web_auth_domain?: string;
  nonce: string;
  issued_at: number;
  expires_at: number;
}

export function buildSep45Challenge(clientContractAddress: string, homeDomain: string): { challenge: Sep45Challenge; payload: string } {
  if (!StrKey.isValidContract(clientContractAddress)) {
    throw new HttpError(400, "clientContractAddress must be a valid C... contract address");
  }

  const now = Math.floor(Date.now() / 1000);
  const challenge: Sep45Challenge = {
    client_contract: clientContractAddress,
    server_account: serverKeypair.publicKey(),
    home_domain: homeDomain,
    web_auth_domain: env.WEB_AUTH_DOMAIN,
    nonce: Buffer.from(Keypair.random().rawPublicKey()).toString("hex"),
    issued_at: now,
    expires_at: now + 300,
  };

  const payload = JSON.stringify(challenge);
  return { challenge, payload };
}

export function verifySep45Challenge(
  payloadString: string,
  authEntryXdr: string
): { account: string } {
  let challenge: Sep45Challenge;
  try {
    challenge = JSON.parse(payloadString);
  } catch {
    throw new HttpError(400, "invalid challenge payload json");
  }

  const now = Math.floor(Date.now() / 1000);
  if (now > challenge.expires_at) {
    throw new HttpError(400, "challenge has expired");
  }

  if (challenge.home_domain !== env.HOME_DOMAIN) {
    throw new HttpError(400, `home_domain must be ${env.HOME_DOMAIN}`);
  }

  if (env.WEB_AUTH_DOMAIN && challenge.web_auth_domain !== env.WEB_AUTH_DOMAIN) {
    throw new HttpError(400, `web_auth_domain must be ${env.WEB_AUTH_DOMAIN}`);
  }

  if (challenge.server_account !== serverKeypair.publicKey()) {
    throw new HttpError(400, "challenge server_account mismatch");
  }

  if (!StrKey.isValidContract(challenge.client_contract)) {
    throw new HttpError(400, "invalid contract address");
  }

  // Parse and verify the SorobanAuthorizationEntry
  let entry: xdr.SorobanAuthorizationEntry;
  try {
    entry = xdr.SorobanAuthorizationEntry.fromXDR(authEntryXdr, "base64");
  } catch {
    throw new HttpError(400, "invalid authorization_entry_xdr");
  }

  const credentials = entry.credentials as unknown as { type?: string; address?: { address: xdr.ScAddress } };
  if (credentials.type !== "sorobanCredentialsAddress" || !credentials.address) {
    throw new HttpError(400, "authorization entry credentials must be address credentials");
  }

  const signingAddress = Address.fromScAddress(credentials.address.address).toString();
  if (signingAddress !== challenge.client_contract) {
    throw new HttpError(403, `authorization entry is for ${signingAddress}, expected ${challenge.client_contract}`);
  }

  return { account: challenge.client_contract };
}

export function issueContractJwt(contractAddress: string): string {
  return jwt.sign({ sub: contractAddress }, env.JWT_SECRET, { expiresIn: "1h" });
}
