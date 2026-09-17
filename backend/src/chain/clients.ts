import { Client as EscrowGateClient } from "escrow-gate";
import { Client as ZkRegistryClient } from "zk-verifier-registry";
import { env } from "../config/env.js";
import { keeperPublicKey, keeperSigner } from "./keeper.js";

const base = {
  networkPassphrase: env.NETWORK_PASSPHRASE,
  rpcUrl: env.SOROBAN_RPC_URL,
};

/** A client that can only build unsigned transactions for a given caller —
 * used for the build-sign-relay-confirm flow where the caller (agent,
 * marketplace, re-executor) signs client-side. Backend never holds their key. */
export function escrowGateFor(publicKey: string) {
  return new EscrowGateClient({
    ...base,
    contractId: env.ESCROW_GATE_CONTRACT_ID,
    publicKey,
  });
}

export function zkRegistryFor(publicKey: string) {
  return new ZkRegistryClient({
    ...base,
    contractId: env.ZK_VERIFIER_REGISTRY_CONTRACT_ID,
    publicKey,
  });
}

/** Verity's own keeper-signed client, for server-initiated calls
 * (finalize sweeps, slash, resolve_challenge) that carry no user key. */
export const escrowGateAsKeeper = new EscrowGateClient({
  ...base,
  contractId: env.ESCROW_GATE_CONTRACT_ID,
  publicKey: keeperPublicKey,
  ...keeperSigner,
});

export const zkRegistryAsKeeper = new ZkRegistryClient({
  ...base,
  contractId: env.ZK_VERIFIER_REGISTRY_CONTRACT_ID,
  publicKey: keeperPublicKey,
  ...keeperSigner,
});
