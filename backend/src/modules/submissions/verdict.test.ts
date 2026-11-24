import assert from "node:assert/strict";
import test from "node:test";
import { Keypair, StrKey } from "@stellar/stellar-sdk";

Object.assign(process.env, {
  SOROBAN_RPC_URL: "https://soroban-testnet.stellar.org",
  NETWORK_PASSPHRASE: "Test SDF Network ; September 2015",
  ESCROW_GATE_CONTRACT_ID: StrKey.encodeContract(Buffer.alloc(32)),
  ZK_VERIFIER_REGISTRY_CONTRACT_ID: StrKey.encodeContract(Buffer.alloc(32)),
  BOND_ASSET_CONTRACT_ID: StrKey.encodeContract(Buffer.alloc(32)),
  DATABASE_URL: "postgres://unused:unused@127.0.0.1:1/unused",
  KEEPER_SECRET_KEY: Keypair.random().secret(),
  JWT_SECRET: "x".repeat(32),
  WEB_AUTH_DOMAIN: "localhost:3001",
  HOME_DOMAIN: "localhost",
});

const { buildVerdictWebhookPayload } = await import("./verdict.js");

test("buildVerdictWebhookPayload creates complete payload for verified consensus verdict", () => {
  const sub = {
    id: "11111111-1111-4111-8111-111111111111",
    chain_submission_id: "42",
    escrow_ref: "escrow-order-123",
    resolution_method: "reexecution_consensus" as const,
  };

  const payload = buildVerdictWebhookPayload(sub, "verified", "0xabc123");

  assert.deepEqual(payload, {
    submission_id: "11111111-1111-4111-8111-111111111111",
    chain_submission_id: "42",
    escrow_ref: "escrow-order-123",
    status: "verified",
    resolution_method: "reexecution_consensus",
    tx_hash: "0xabc123",
  });
});

test("buildVerdictWebhookPayload creates complete payload for slashed verdict with null tx_hash", () => {
  const sub = {
    id: "22222222-2222-4222-8222-222222222222",
    chain_submission_id: "99",
    escrow_ref: "escrow-order-456",
    resolution_method: "window_elapsed" as const,
  };

  const payload = buildVerdictWebhookPayload(sub, "slashed", null);

  assert.deepEqual(payload, {
    submission_id: "22222222-2222-4222-8222-222222222222",
    chain_submission_id: "99",
    escrow_ref: "escrow-order-456",
    status: "slashed",
    resolution_method: "window_elapsed",
    tx_hash: null,
  });
});

test("buildVerdictWebhookPayload handles optional fields when null or undefined", () => {
  const sub = {
    id: "33333333-3333-4333-8333-333333333333",
    chain_submission_id: null,
    escrow_ref: "escrow-order-789",
    resolution_method: null,
  };

  const payload = buildVerdictWebhookPayload(sub, "verified", undefined);

  assert.deepEqual(payload, {
    submission_id: "33333333-3333-4333-8333-333333333333",
    chain_submission_id: null,
    escrow_ref: "escrow-order-789",
    status: "verified",
    resolution_method: null,
    tx_hash: null,
  });
});
