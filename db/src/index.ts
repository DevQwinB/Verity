import { Kysely, PostgresDialect } from "kysely";
import pg from "pg";
import type { Database } from "./types.js";

export * from "./types.js";

function intFromEnv(name: string, fallback: number, min = 0): number {
  const val = process.env[name];
  if (val === undefined || val.trim() === "") return fallback;
  const parsed = Number(val);
  if (!Number.isInteger(parsed) || parsed < min) return fallback;
  return parsed;
}

// Idle client error listener: when Postgres restarts or a network drop occurs,
// node-postgres emits an 'error' event on the pool for any idle client.
// Without a listener, Node terminates the process with an uncaught exception.
// Migrations also go through createDb, so an operator running a long migration
// can set DB_STATEMENT_TIMEOUT_MS=0 to disable the statement timeout.
export function createDb(connectionString: string): Kysely<Database> {
  const max = intFromEnv("DB_POOL_MAX", 10, 1);
  const statement_timeout = intFromEnv("DB_STATEMENT_TIMEOUT_MS", 30_000, 0);
  const pool = new pg.Pool({
    connectionString,
    max,
    connectionTimeoutMillis: 10_000,
    statement_timeout,
  });

  pool.on("error", (err) => console.error("[db] idle client error:", err.message));

  const dialect = new PostgresDialect({ pool });
  return new Kysely<Database>({ dialect });
}
