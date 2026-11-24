import assert from "node:assert/strict";
import test from "node:test";
import { Keypair, StrKey } from "@stellar/stellar-sdk";

const keeper = Keypair.random();
const attestor = Keypair.random();
const passphrase = "Test SDF Network ; September 2015";

Object.assign(process.env, {
  SOROBAN_RPC_URL: "https://soroban-testnet.stellar.org",
  NETWORK_PASSPHRASE: passphrase,
  ESCROW_GATE_CONTRACT_ID: StrKey.encodeContract(Buffer.alloc(32)),
  ZK_VERIFIER_REGISTRY_CONTRACT_ID: StrKey.encodeContract(Buffer.alloc(32)),
  BOND_ASSET_CONTRACT_ID: StrKey.encodeContract(Buffer.alloc(32)),
  DATABASE_URL: "postgres://unused:unused@127.0.0.1:1/unused",
  KEEPER_SECRET_KEY: keeper.secret(),
  ATTESTATION_SIGNING_SECRET: attestor.secret(),
  JWT_SECRET: "a".repeat(32),
  WEB_AUTH_DOMAIN: "localhost:3001",
  HOME_DOMAIN: "localhost",
});

const { escrowGateAsKeeper } = await import("../../chain/clients.js");
const { attestationSigningKey } = await import("../attestations/export.js");
const { buildApp } = await import("../../app.js");

const mockGateConfig = {
  min_stake_floor: 5000000000n,
  quorum_min_reexecutors: 3,
  quorum_supermajority_bps: 6600,
  agent_bond_min_bps: 500,
  challenger_bond_min_bps: 500,
  window_tier_small_ceiling: 1000000000000n,
  window_tier_small_s: 600n,
  window_tier_large_s: 600n,
  slash_split_challenger_bps: 2000,
  reexecutor_slash_bps: 1000,
  reexecutor_allowlist: true,
};

// Mock get_config on escrowGateAsKeeper
(escrowGateAsKeeper as any).get_config = async () => ({
  result: mockGateConfig,
});

test("/v1/config returns attestation_signing_key matching configured attestor", async () => {
  const app = buildApp();
  const res = await app.inject({
    method: "GET",
    url: "/v1/config",
  });

  assert.equal(res.statusCode, 200);
  const data = res.json();
  assert.equal(data.attestation_signing_key, attestor.publicKey());
  assert.equal(data.attestation_signing_key, attestationSigningKey);
});

test("stellar.toml includes VERITY_ATTESTATION_SIGNING_KEY", async () => {
  const app = buildApp();
  const res = await app.inject({
    method: "GET",
    url: "/.well-known/stellar.toml",
  });

  assert.equal(res.statusCode, 200);
  assert.ok(
    res.body.includes(`VERITY_ATTESTATION_SIGNING_KEY="${attestor.publicKey()}"`),
    "stellar.toml must contain VERITY_ATTESTATION_SIGNING_KEY with configured key"
  );
});
