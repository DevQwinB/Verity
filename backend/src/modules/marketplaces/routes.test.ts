import assert from "node:assert/strict";
import test from "node:test";
import { Keypair, StrKey } from "@stellar/stellar-sdk";

// routes.ts imports db.ts -> env.ts at module load time. Set every required
// field before its first dynamic import so a developer's backend/.env is never used.
Object.assign(process.env, {
  SOROBAN_RPC_URL: "https://soroban-testnet.stellar.org", // never contacted
  NETWORK_PASSPHRASE: "Test SDF Network ; September 2015",
  ESCROW_GATE_CONTRACT_ID: StrKey.encodeContract(Buffer.alloc(32)),
  ZK_VERIFIER_REGISTRY_CONTRACT_ID: StrKey.encodeContract(Buffer.alloc(32)),
  BOND_ASSET_CONTRACT_ID: StrKey.encodeContract(Buffer.alloc(32)),
  DATABASE_URL: "postgres://unused:unused@127.0.0.1:1/unused",
  KEEPER_SECRET_KEY: Keypair.random().secret(),
  JWT_SECRET: "a".repeat(32),
  WEB_AUTH_DOMAIN: "localhost:3001",
  HOME_DOMAIN: "localhost",
});

const { WEBHOOK_EVENTS, createWebhookBody } = await import("./routes.js");

const validBase = {
  url: "https://example.org/verity-webhook",
  secret: "super-secret-token",
};

test("WEBHOOK_EVENTS includes submission.expired_unverified alongside the other events", () => {
  assert.deepEqual([...WEBHOOK_EVENTS], [
    "submission.verified",
    "submission.slashed",
    "submission.expired_unverified",
    "submission.disputed",
  ]);
});

test("createWebhookBody accepts submission.expired_unverified alone or with other events", () => {
  const single = createWebhookBody.parse({
    ...validBase,
    events: ["submission.expired_unverified"],
  });
  assert.deepEqual(single.events, ["submission.expired_unverified"]);

  const all = createWebhookBody.parse({
    ...validBase,
    events: [
      "submission.verified",
      "submission.slashed",
      "submission.expired_unverified",
      "submission.disputed",
    ],
  });
  assert.equal(all.events.length, 4);
});

test("createWebhookBody rejects unknown event names and empty event lists", () => {
  assert.throws(() =>
    createWebhookBody.parse({ ...validBase, events: ["submission.pending"] })
  );
  assert.throws(() =>
    createWebhookBody.parse({ ...validBase, events: ["submission.unknown"] })
  );
  assert.throws(() => createWebhookBody.parse({ ...validBase, events: [] }));
});
