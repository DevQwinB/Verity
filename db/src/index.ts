import { Kysely, PostgresDialect } from "kysely";
import pg from "pg";
import type { Database } from "./types.js";

export * from "./types.js";

function intFromEnv(name: string, fallback: number): number {
  const val = process.env[name];
  if (val === undefined || val.trim() === "") return fallback;
  const parsed = Number(val);
  if (!Number.isInteger(parsed) || parsed < 0) return fallback;
  return parsed;
}

export function createDb(connectionString: string): Kysely<Database> {
  const max = Math.max(1, intFromEnv("DB_POOL_MAX", 10));
  const statement_timeout = intFromEnv("DB_STATEMENT_TIMEOUT_MS", 30_000);

  const pool = new pg.Pool({
    connectionString,
    max,
    connectionTimeoutMillis: 10_000,
    statement_timeout,
  });

  // Attach an error listener to prevent idle client errors (such as database
  // restarts or dropped connections) from emitting unhandled 'error' events that
  // crash the process. The pool automatically discards the failed client and
  // reconnects on the next query.
  // Note: createDb is also used by db/src/migrate.ts; setting DB_STATEMENT_TIMEOUT_MS=0
  // allows operators to run long migrations without timing out.
  pool.on("error", (err: Error) => {
    console.error("[db] idle client error:", err.message);
  });

  const dialect = new PostgresDialect({
    pool,
  });
  return new Kysely<Database>({ dialect });
}
