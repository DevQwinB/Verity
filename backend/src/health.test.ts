import assert from "node:assert/strict";
import test from "node:test";
import { Keypair, StrKey } from "@stellar/stellar-sdk";

const keeper = Keypair.random();
const serverKey = Keypair.random();

Object.assign(process.env, {
  SOROBAN_RPC_URL: "https://soroban-testnet.stellar.org",
  NETWORK_PASSPHRASE: "Test SDF Network ; September 2015",
  ESCROW_GATE_CONTRACT_ID: StrKey.encodeContract(Buffer.alloc(32)),
  ZK_VERIFIER_REGISTRY_CONTRACT_ID: StrKey.encodeContract(Buffer.alloc(32)),
  BOND_ASSET_CONTRACT_ID: StrKey.encodeContract(Buffer.alloc(32)),
  DATABASE_URL: "postgres://unused:unused@127.0.0.1:1/unused",
  KEEPER_SECRET_KEY: keeper.secret(),
  SEP10_SIGNING_SECRET: serverKey.secret(),
  JWT_SECRET: "a".repeat(32),
  WEB_AUTH_DOMAIN: "localhost:3001",
  HOME_DOMAIN: "localhost",
});

const { buildApp } = await import("./app.js");

test("GET /health/live returns { ok: true }", async () => {
  const app = buildApp();
  const res = await app.inject({ method: "GET", url: "/health/live" });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json(), { ok: true });
});

test("GET /health includes checks, keeper_balance_stroops, and reexecutors_online", async () => {
  const app = buildApp();
  const res = await app.inject({ method: "GET", url: "/health" });
  const body = res.json();
  assert.equal(typeof body.ok, "boolean");
  assert.equal(typeof body.deployment, "string");
  assert.ok("checks" in body);
  assert.ok("database" in body.checks);
  assert.ok("rpc" in body.checks);
  assert.ok("indexer" in body.checks);
  assert.ok("indexer_lag_ledgers" in body.checks);
  assert.ok("keeper_balance_stroops" in body);
  assert.ok("reexecutors_online" in body);
  assert.equal(typeof body.reexecutors_online, "number");
});
