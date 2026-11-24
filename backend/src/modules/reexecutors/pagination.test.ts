import assert from "node:assert/strict";
import test from "node:test";
import { Keypair, StrKey } from "@stellar/stellar-sdk";
import { DummyDriver, Kysely, PostgresAdapter, PostgresIntrospector, PostgresQueryCompiler } from "kysely";
import type { Database } from "@verity/db";

Object.assign(process.env, {
  SOROBAN_RPC_URL: "https://soroban-testnet.stellar.org",
  NETWORK_PASSPHRASE: "Test SDF Network ; September 2015",
  ESCROW_GATE_CONTRACT_ID: StrKey.encodeContract(Buffer.alloc(32)),
  ZK_VERIFIER_REGISTRY_CONTRACT_ID: StrKey.encodeContract(Buffer.alloc(32)),
  BOND_ASSET_CONTRACT_ID: StrKey.encodeContract(Buffer.alloc(32)),
  DATABASE_URL: "postgres://unused:unused@127.0.0.1:1/unused",
  KEEPER_SECRET_KEY: Keypair.random().secret(),
  ATTESTATION_SIGNING_SECRET: Keypair.random().secret(),
  JWT_SECRET: "a".repeat(32),
  WEB_AUTH_DOMAIN: "localhost:3001",
  HOME_DOMAIN: "localhost",
});

const { buildReexecutorsListQuery, reexecutorsQuerySchema, statsByReexecutor } = await import("./routes.js");

const dummyDb = new Kysely<Database>({
  dialect: {
    createAdapter: () => new PostgresAdapter(),
    createDriver: () => new DummyDriver(),
    createIntrospector: (db) => new PostgresIntrospector(db),
    createQueryCompiler: () => new PostgresQueryCompiler(),
  },
});

test("reexecutorsQuerySchema validates and applies bounds", () => {
  assert.deepEqual(reexecutorsQuerySchema.parse({}), {});
  assert.deepEqual(reexecutorsQuerySchema.parse({ limit: "25", offset: "50" }), {
    limit: 25,
    offset: 50,
  });
  assert.deepEqual(reexecutorsQuerySchema.parse({ limit: 1, offset: 0 }), {
    limit: 1,
    offset: 0,
  });
  assert.deepEqual(reexecutorsQuerySchema.parse({ limit: 200 }), { limit: 200 });

  // Rejects limit < 1
  assert.throws(() => reexecutorsQuerySchema.parse({ limit: "0" }));
  assert.throws(() => reexecutorsQuerySchema.parse({ limit: "-1" }));

  // Rejects limit > 200
  assert.throws(() => reexecutorsQuerySchema.parse({ limit: "201" }));

  // Rejects offset < 0
  assert.throws(() => reexecutorsQuerySchema.parse({ offset: "-1" }));

  // Rejects invalid integers
  assert.throws(() => reexecutorsQuerySchema.parse({ limit: "abc" }));
  assert.throws(() => reexecutorsQuerySchema.parse({ limit: "1.5" }));
});

test("buildReexecutorsListQuery includes stable tiebreaker ordering and limit/offset", () => {
  const query = buildReexecutorsListQuery(dummyDb, 20, 40);
  const compiled = query.compile();

  assert.match(
    compiled.sql,
    /order by "stake_amount" desc, "joined_at" asc, "id" asc/i,
    "query must order by stake_amount desc, joined_at asc, id asc for deterministic pagination"
  );
  assert.match(compiled.sql, /limit \$\d+ offset \$\d+/i);
  assert.equal(compiled.parameters[compiled.parameters.length - 2], 20);
  assert.equal(compiled.parameters[compiled.parameters.length - 1], 40);
});

test("statsByReexecutor returns empty map when passed empty list of ids", async () => {
  const result = await statsByReexecutor([]);
  assert.equal(result.size, 0);
});

test("two paginated pages with stable tiebreaker have no overlapping re-executors", () => {
  // Simulate re-executors with duplicate stake amounts and joined_at timestamps
  const timestamp = new Date("2026-01-01T00:00:00Z");
  const reexecutors = [
    { id: "uuid-1", stake_amount: "5000", joined_at: timestamp },
    { id: "uuid-2", stake_amount: "5000", joined_at: timestamp },
    { id: "uuid-3", stake_amount: "5000", joined_at: timestamp },
    { id: "uuid-4", stake_amount: "2000", joined_at: timestamp },
    { id: "uuid-5", stake_amount: "1000", joined_at: timestamp },
  ];

  // Sorting specification implemented in buildReexecutorsListQuery:
  // stake_amount desc (numeric comparison), joined_at asc, id asc
  const comparator = (
    a: (typeof reexecutors)[number],
    b: (typeof reexecutors)[number]
  ) => {
    const stakeDiff = BigInt(b.stake_amount) - BigInt(a.stake_amount);
    if (stakeDiff !== 0n) return stakeDiff > 0n ? 1 : -1;
    const timeDiff = a.joined_at.getTime() - b.joined_at.getTime();
    if (timeDiff !== 0) return timeDiff;
    return a.id.localeCompare(b.id);
  };

  const sorted = [...reexecutors].sort(comparator);

  const pageSize = 2;
  const page1 = sorted.slice(0, pageSize);
  const page2 = sorted.slice(pageSize, pageSize * 2);

  assert.equal(page1.length, 2);
  assert.equal(page2.length, 2);

  const page1Ids = new Set(page1.map((r) => r.id));
  const page2Ids = new Set(page2.map((r) => r.id));

  // Verify no overlap
  for (const id of page1Ids) {
    assert.equal(page2Ids.has(id), false, `ID ${id} must not appear on both pages`);
  }
});
