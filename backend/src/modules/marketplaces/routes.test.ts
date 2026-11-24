import test from "node:test";
import assert from "node:assert/strict";
import { Keypair, StrKey } from "@stellar/stellar-sdk";

Object.assign(process.env, {
  SOROBAN_RPC_URL: "https://soroban-testnet.stellar.org",
  NETWORK_PASSPHRASE: "Test SDF Network ; September 2015",
  ESCROW_GATE_CONTRACT_ID: StrKey.encodeContract(Buffer.alloc(32)),
  ZK_VERIFIER_REGISTRY_CONTRACT_ID: StrKey.encodeContract(Buffer.alloc(32)),
  BOND_ASSET_CONTRACT_ID: StrKey.encodeContract(Buffer.alloc(32)),
  DATABASE_URL: "postgres://unused:unused@127.0.0.1:1/unused",
  KEEPER_SECRET_KEY: Keypair.random().secret(),
  ATTESTATION_SIGNING_SECRET: Keypair.random().secret(),
  JWT_SECRET: "x".repeat(32),
  WEB_AUTH_DOMAIN: "localhost:3001",
  HOME_DOMAIN: "localhost",
});

const Fastify = (await import("fastify")).default;
const { ZodError } = await import("zod");
const { issueJwt } = await import("../../auth/sep10.js");
const {
  marketplaceBodySchema,
  marketplacesRoutes,
  setMarketplaceName,
  findOrCreateMarketplaceForAccount,
} = await import("./routes.js");

function createMockDb() {
  const store = new Map<string, { id: string; stellar_account: string; name: string; webhook_secret: string | null; created_at: Date }>();
  let nextId = 1;

  return {
    store,
    selectFrom(table: string) {
      let selectedAccount: string | undefined;
      return {
        select() {
          return this;
        },
        selectAll() {
          return this;
        },
        where(col: string, op: string, val: string) {
          if (col === "stellar_account" && op === "=") {
            selectedAccount = val;
          }
          return this;
        },
        async executeTakeFirst() {
          return selectedAccount ? store.get(selectedAccount) : undefined;
        },
        async executeTakeFirstOrThrow() {
          const row = selectedAccount ? store.get(selectedAccount) : undefined;
          if (!row) throw new Error("Row not found");
          return row;
        },
      };
    },
    insertInto(table: string) {
      let vals: { stellar_account: string; name: string };
      let onConflictDoUpdate = false;
      return {
        values(v: { stellar_account: string; name: string }) {
          vals = v;
          return this;
        },
        onConflict(cb: (oc: any) => any) {
          const oc = {
            column: () => ({
              doNothing: () => {
                onConflictDoUpdate = false;
              },
              doUpdateSet: () => {
                onConflictDoUpdate = true;
              },
            }),
          };
          cb(oc);
          return this;
        },
        returningAll() {
          return this;
        },
        async executeTakeFirst() {
          const existing = store.get(vals.stellar_account);
          if (existing) {
            if (onConflictDoUpdate) {
              existing.name = vals.name;
              return existing;
            }
            return undefined;
          }
          const row = {
            id: `uuid-${nextId++}`,
            stellar_account: vals.stellar_account,
            name: vals.name,
            webhook_secret: null,
            created_at: new Date(),
          };
          store.set(vals.stellar_account, row);
          return row;
        },
        async executeTakeFirstOrThrow() {
          const res = await this.executeTakeFirst();
          if (!res) throw new Error("Insert conflict");
          return res;
        },
      };
    },
  };
}

test("marketplaceBodySchema validation", () => {
  assert.equal(marketplaceBodySchema.parse({ name: "hello" }).name, "hello");
  assert.equal(marketplaceBodySchema.parse({ name: "   trimmed name   " }).name, "trimmed name");
  assert.equal(marketplaceBodySchema.parse({ name: "a".repeat(100) }).name, "a".repeat(100));

  assert.equal(marketplaceBodySchema.safeParse({ name: "" }).success, false);
  assert.equal(marketplaceBodySchema.safeParse({ name: "    " }).success, false);
  assert.equal(marketplaceBodySchema.safeParse({ name: "a".repeat(101) }).success, false);
  assert.equal(marketplaceBodySchema.safeParse({}).success, false);
});

test("POST /v1/marketplaces creates (201) and renames (200)", async () => {
  const mockDb = createMockDb();
  const app = Fastify();
  app.setErrorHandler((err: unknown, _req, reply) => {
    if (err instanceof ZodError) {
      return reply.code(400).send({ error: err.issues.map((i) => i.message).join("; ") });
    }
    return reply.code(500).send({ error: "internal error" });
  });
  await marketplacesRoutes(app, mockDb);

  const account = Keypair.random().publicKey();
  const token = issueJwt(account);

  // 1. Validation errors return 400
  const blankRes = await app.inject({
    method: "POST",
    url: "/v1/marketplaces",
    headers: { authorization: `Bearer ${token}` },
    payload: { name: "   " },
  });
  assert.equal(blankRes.statusCode, 400);

  const tooLongRes = await app.inject({
    method: "POST",
    url: "/v1/marketplaces",
    headers: { authorization: `Bearer ${token}` },
    payload: { name: "a".repeat(101) },
  });
  assert.equal(tooLongRes.statusCode, 400);

  // 2. Explicit creation returns 201
  const createRes = await app.inject({
    method: "POST",
    url: "/v1/marketplaces",
    headers: { authorization: `Bearer ${token}` },
    payload: { name: "  My Initial Store  " },
  });
  assert.equal(createRes.statusCode, 201);
  const createdBody = JSON.parse(createRes.payload);
  assert.equal(createdBody.name, "My Initial Store");
  assert.equal(createdBody.stellar_account, account);

  // 3. Rename returns 200 with new name
  const renameRes = await app.inject({
    method: "POST",
    url: "/v1/marketplaces",
    headers: { authorization: `Bearer ${token}` },
    payload: { name: "Renamed Marketplace" },
  });
  assert.equal(renameRes.statusCode, 200);
  const renamedBody = JSON.parse(renameRes.payload);
  assert.equal(renamedBody.name, "Renamed Marketplace");
  assert.equal(renamedBody.stellar_account, account);
  assert.equal(renamedBody.id, createdBody.id);

  // 4. Submitting work afterwards does not reset the name
  const workMarketplace = await findOrCreateMarketplaceForAccount(account, mockDb);
  assert.equal(workMarketplace.name, "Renamed Marketplace");
});

test("POST with a new name on an auto-created marketplace returns 200 with the new name", async () => {
  const mockDb = createMockDb();
  const app = Fastify();
  app.setErrorHandler((err: unknown, _req, reply) => {
    if (err instanceof ZodError) {
      return reply.code(400).send({ error: err.issues.map((i) => i.message).join("; ") });
    }
    return reply.code(500).send({ error: "internal error" });
  });
  await marketplacesRoutes(app, mockDb);

  const account = Keypair.random().publicKey();
  const token = issueJwt(account);

  // Auto-created marketplace via work submission
  const autoCreated = await findOrCreateMarketplaceForAccount(account, mockDb);
  assert.equal(autoCreated.name, account);

  // Renaming auto-created marketplace returns 200
  const renameRes = await app.inject({
    method: "POST",
    url: "/v1/marketplaces",
    headers: { authorization: `Bearer ${token}` },
    payload: { name: "Custom Name" },
  });
  assert.equal(renameRes.statusCode, 200);
  const renamedBody = JSON.parse(renameRes.payload);
  assert.equal(renamedBody.name, "Custom Name");

  // Subsequent submission keeps custom name
  const workMarketplace = await findOrCreateMarketplaceForAccount(account, mockDb);
  assert.equal(workMarketplace.name, "Custom Name");
});
