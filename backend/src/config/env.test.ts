import assert from "node:assert/strict";
import test from "node:test";
import { Keypair, StrKey } from "@stellar/stellar-sdk";

const keeper = Keypair.random();
const attestor = Keypair.random();
const sep10 = Keypair.random();
const contractId = StrKey.encodeContract(Buffer.alloc(32));

const baseConfig = {
  SOROBAN_RPC_URL: "https://soroban-testnet.stellar.org",
  NETWORK_PASSPHRASE: "Test SDF Network ; September 2015",
  ESCROW_GATE_CONTRACT_ID: contractId,
  ZK_VERIFIER_REGISTRY_CONTRACT_ID: contractId,
  BOND_ASSET_CONTRACT_ID: contractId,
  DATABASE_URL: "postgres://verity:verity@localhost:5432/verity",
  KEEPER_SECRET_KEY: keeper.secret(),
  JWT_SECRET: "a".repeat(32),
  WEB_AUTH_DOMAIN: "localhost:3001",
  HOME_DOMAIN: "localhost:3001",
};

Object.assign(process.env, baseConfig);

const { preprocessedSchema } = await import("./env.js");

test("empty-string optional env values parse to their defaults", () => {
  const parsed = preprocessedSchema.parse({
    ...baseConfig,
    ATTESTATION_SIGNING_SECRET: "",
    SEP10_SIGNING_SECRET: "",
    PUBLIC_SCHEME: "",
    PORT: "",
    DEPLOYMENT_NAME: "",
    ARTIFACT_STORAGE_DIR: "",
    ARTIFACT_MAX_BYTES: "",
    ARTIFACT_MAX_TOTAL_BYTES: "",
    ARTIFACT_UPLOADS_PER_MINUTE: "",
    RUN_WORKERS: "",
    TRUST_PROXY: "",
    RATE_LIMIT_PER_MINUTE: "",
    REEXECUTOR_LIVENESS_S: "",
    REPLAY_OVERASSIGN: "",
    REPLAY_REASSIGN_AFTER_S: "",
    DRAFT_TTL_S: "",
  });

  assert.equal(parsed.ATTESTATION_SIGNING_SECRET, undefined);
  assert.equal(parsed.SEP10_SIGNING_SECRET, undefined);
  assert.equal(parsed.PUBLIC_SCHEME, "http");
  assert.equal(parsed.PORT, 3001);
  assert.equal(parsed.DEPLOYMENT_NAME, "testnet");
  assert.equal(parsed.ARTIFACT_STORAGE_DIR, "./.artifacts");
  assert.equal(parsed.ARTIFACT_MAX_BYTES, 262144);
  assert.equal(parsed.ARTIFACT_MAX_TOTAL_BYTES, 10737418240);
  assert.equal(parsed.ARTIFACT_UPLOADS_PER_MINUTE, 30);
  assert.equal(parsed.RUN_WORKERS, true);
  assert.equal(parsed.TRUST_PROXY, false);
  assert.equal(parsed.RATE_LIMIT_PER_MINUTE, 300);
  assert.equal(parsed.REEXECUTOR_LIVENESS_S, 60);
  assert.equal(parsed.REPLAY_OVERASSIGN, 1);
  assert.equal(parsed.REPLAY_REASSIGN_AFTER_S, 120);
  assert.equal(parsed.DRAFT_TTL_S, 3600);
});

test("custom optional values are preserved", () => {
  const parsed = preprocessedSchema.parse({
    ...baseConfig,
    ATTESTATION_SIGNING_SECRET: attestor.secret(),
    SEP10_SIGNING_SECRET: sep10.secret(),
    PORT: "4000",
    RUN_WORKERS: "false",
    RATE_LIMIT_PER_MINUTE: "500",
  });

  assert.equal(parsed.ATTESTATION_SIGNING_SECRET, attestor.secret());
  assert.equal(parsed.SEP10_SIGNING_SECRET, sep10.secret());
  assert.equal(parsed.PORT, 4000);
  assert.equal(parsed.RUN_WORKERS, false);
  assert.equal(parsed.RATE_LIMIT_PER_MINUTE, 500);
});

test("empty string for required key fails validation", () => {
  assert.throws(() => {
    preprocessedSchema.parse({
      ...baseConfig,
      KEEPER_SECRET_KEY: "",
    });
  });
});
