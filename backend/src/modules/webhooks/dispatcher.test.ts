import test from "node:test";
import assert from "node:assert/strict";
import { Keypair, StrKey } from "@stellar/stellar-sdk";
import {
  DummyDriver,
  Kysely,
  PostgresAdapter,
  PostgresIntrospector,
  PostgresQueryCompiler,
  type CompiledQuery,
  type DatabaseConnection,
  type Driver,
  type QueryResult,
} from "kysely";
import type { Database } from "@verity/db";

Object.assign(process.env, {
  SOROBAN_RPC_URL: "https://soroban-testnet.stellar.org", // never contacted
  NETWORK_PASSPHRASE: "Test SDF Network ; September 2015",
  ESCROW_GATE_CONTRACT_ID: StrKey.encodeContract(Buffer.alloc(32)),
  ZK_VERIFIER_REGISTRY_CONTRACT_ID: StrKey.encodeContract(Buffer.alloc(32)),
  BOND_ASSET_CONTRACT_ID: StrKey.encodeContract(Buffer.alloc(32)),
  DATABASE_URL: "postgres://unused:unused@127.0.0.1:1/unused", // pool is lazy
  KEEPER_SECRET_KEY: Keypair.random().secret(),
  JWT_SECRET: "x".repeat(32),
  WEB_AUTH_DOMAIN: "localhost:3001",
  HOME_DOMAIN: "localhost",
});

const {
  backoffDelayMs,
  isRetryableResponse,
  planNextAttempt,
  retryWebhooksOnce,
  MAX_DELIVERY_ATTEMPTS,
  RETRY_BASE_DELAY_MS,
  RETRY_MAX_DELAY_MS,
  PENDING_RETRY_AFTER_MS,
} = await import("./dispatcher.js");

test("backoffDelayMs doubles per attempt and is capped", () => {
  assert.equal(backoffDelayMs(1), RETRY_BASE_DELAY_MS);
  assert.equal(backoffDelayMs(2), RETRY_BASE_DELAY_MS * 2);
  assert.equal(backoffDelayMs(3), RETRY_BASE_DELAY_MS * 4);
  // strictly increasing until the cap
  const schedule = Array.from({ length: MAX_DELIVERY_ATTEMPTS }, (_, i) => backoffDelayMs(i + 1));
  for (let i = 1; i < schedule.length; i++) {
    assert.ok(schedule[i] >= schedule[i - 1], `schedule must not decrease at attempt ${i + 1}`);
  }
  assert.equal(backoffDelayMs(50), RETRY_MAX_DELAY_MS, "huge attempt counts hit the cap");
  // the whole schedule stays within ~a day, so give-up is bounded
  const total = schedule.reduce((a, b) => a + b, 0);
  assert.ok(total <= 24 * 60 * 60_000, `total backoff ${total}ms must stay within a day`);
  // degenerate input still yields the base delay, never zero or negative
  assert.equal(backoffDelayMs(0), RETRY_BASE_DELAY_MS);
  assert.equal(backoffDelayMs(-3), RETRY_BASE_DELAY_MS);
});

test("isRetryableResponse retries 5xx/408/429/transport errors but not other 4xx or 3xx", () => {
  assert.equal(isRetryableResponse(null), true, "timeout/transport failure");
  assert.equal(isRetryableResponse(500), true);
  assert.equal(isRetryableResponse(503), true);
  assert.equal(isRetryableResponse(408), true);
  assert.equal(isRetryableResponse(429), true);
  assert.equal(isRetryableResponse(400), false);
  assert.equal(isRetryableResponse(401), false);
  assert.equal(isRetryableResponse(403), false);
  assert.equal(isRetryableResponse(404), false);
  assert.equal(isRetryableResponse(422), false);
  assert.equal(isRetryableResponse(301), false, "redirects are never followed, so not retryable");
  assert.equal(isRetryableResponse(204), false, "2xx is delivered, not retried");
});

test("planNextAttempt schedules a backoff retry after a retryable failure", () => {
  const now = new Date("2026-11-22T12:00:00Z");
  const plan = planNextAttempt({ attempts: 1, responseCode: 500, now });
  assert.equal(plan.retry, true);
  assert.equal(plan.terminal, false);
  assert.equal(plan.nextAttemptAt!.getTime(), now.getTime() + RETRY_BASE_DELAY_MS);

  const third = planNextAttempt({ attempts: 3, responseCode: null, now });
  assert.equal(third.nextAttemptAt!.getTime(), now.getTime() + RETRY_BASE_DELAY_MS * 4);
});

test("planNextAttempt gives up on 4xx (other than 408/429) without scheduling", () => {
  const now = new Date("2026-11-22T12:00:00Z");
  for (const code of [400, 401, 404, 301]) {
    const plan = planNextAttempt({ attempts: 1, responseCode: code, now });
    assert.equal(plan.retry, false, `code ${code}`);
    assert.equal(plan.nextAttemptAt, null);
    assert.equal(plan.terminal, true);
  }
  // 408/429 are retried
  assert.equal(planNextAttempt({ attempts: 1, responseCode: 429, now }).retry, true);
  assert.equal(planNextAttempt({ attempts: 1, responseCode: 408, now }).retry, true);
});

test("planNextAttempt stops after MAX_DELIVERY_ATTEMPTS even for 5xx", () => {
  const now = new Date("2026-11-22T12:00:00Z");
  const last = planNextAttempt({ attempts: MAX_DELIVERY_ATTEMPTS - 1, responseCode: 500, now });
  assert.equal(last.retry, true, "the last allowed attempt is still scheduled");
  const over = planNextAttempt({ attempts: MAX_DELIVERY_ATTEMPTS, responseCode: 500, now });
  assert.equal(over.retry, false);
  assert.equal(over.nextAttemptAt, null);
  assert.equal(over.terminal, true);
});

/** A driver that never touches a socket but records every compiled SQL
 * statement, so tests can assert on the query shape. Queries run through
 * the connection, so the recording happens there. */
class RecordingConnection implements DatabaseConnection {
  constructor(readonly statements: string[]) {}
  async executeQuery<R>(compiledQuery: CompiledQuery): Promise<QueryResult<R>> {
    this.statements.push(compiledQuery.sql);
    return { rows: [] } as QueryResult<R>;
  }
  async *streamQuery<R>(): AsyncIterableIterator<QueryResult<R>> {
    // never used by these tests
  }
}

class RecordingDriver extends DummyDriver implements Driver {
  constructor(readonly statements: string[]) {
    super();
  }
  override async acquireConnection(): Promise<DatabaseConnection> {
    return new RecordingConnection(this.statements);
  }
}

function dummyDb(statements: string[]): Kysely<Database> {
  return new Kysely<Database>({
    dialect: {
      createAdapter: () => new PostgresAdapter(),
      createDriver: () => new RecordingDriver(statements),
      createIntrospector: (db) => new PostgresIntrospector(db),
      createQueryCompiler: () => new PostgresQueryCompiler(),
    },
  });
}

test("retryWebhooksOnce selects due rows with for update skip locked and is a no-op when none are due", async () => {
  const statements: string[] = [];
  const testDb = dummyDb(statements);
  const attempted = await retryWebhooksOnce({ db: testDb, now: new Date("2026-11-22T12:00:00Z") });
  assert.equal(attempted, 0, "dummy driver returns no rows, so nothing is attempted");

  const select = statements.find((s) => s.includes("webhook_delivery") && s.toLowerCase().includes("select"));
  assert.ok(select, "a select against webhook_delivery must run");
  assert.match(select!, /for update/i);
  assert.match(select!, /skip locked/i, "overlapping ticks must not double-send");
  assert.match(select!, /next_attempt_at/i, "failed rows are picked by their scheduled retry time");
  assert.match(select!, /created_at/i, "crash-orphaned pending rows are picked by age");
  assert.match(select!, /attempts/i, "rows with exhausted attempts are never picked");
  assert.match(select!, /limit/i, "per-tick work is bounded");
});

test("retryWebhooksOnce bounds per-tick work by the limit option", async () => {
  const statements: string[] = [];
  const testDb = dummyDb(statements);
  await retryWebhooksOnce({ db: testDb, limit: 7, now: new Date() });
  const select = statements.find((s) => s.toLowerCase().includes("select") && s.includes("webhook_delivery"));
  assert.match(select!, /limit \$?\d+/i);
  assert.ok(select!.includes("7"), `expected limit 7 in: ${select}`);
});

test("PENDING_RETRY_AFTER_MS is a few minutes, not seconds and not hours", () => {
  assert.ok(PENDING_RETRY_AFTER_MS >= 60_000, "at least a minute");
  assert.ok(PENDING_RETRY_AFTER_MS <= 30 * 60_000, "at most half an hour");
});
