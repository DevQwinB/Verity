import { createRequire } from "node:module";
import { mkdtempSync, rmSync, promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import * as net from "node:net";
import * as path from "node:path";
import { sql } from "kysely";
import { Migrator, FileMigrationProvider } from "kysely/migration";
import type { Kysely } from "kysely";
import type { Database } from "@verity/db";

const require = createRequire(import.meta.url);

/** All tables, so reset() gives every test a clean database. */
const TABLES = [
  "webhook_delivery",
  "webhook_subscription",
  "attestation_export",
  "slashing_event",
  "submission_artifact",
  "zk_proof",
  "spot_check",
  "challenge",
  "replay",
  "submission",
  "reexecutor",
  "marketplace",
  "chain_cursor",
];

/** A free TCP port on localhost, handed to the embedded Postgres. */
async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const address = srv.address();
      if (!address || typeof address === "string") return reject(new Error("no port"));
      srv.close(() => resolve(address.port));
    });
  });
}

export interface TestDbHandle {
  connectionString: string;
  db: Kysely<Database>;
  /** Truncates every table; call between tests for isolation. */
  reset: () => Promise<void>;
  stop: () => Promise<void>;
}

/**
 * Starts a real, throw-away Postgres via the db package's embedded-postgres
 * (no docker), migrates it to latest with the Kysely Migrator against
 * db/migrations, and points process.env.DATABASE_URL at it — so it must run
 * BEFORE any backend module that reads env (db.ts, config/env.ts) is imported.
 */
export async function startTestDb(): Promise<TestDbHandle> {
  const { startLocalPostgres } = await import("@verity/db/src/local-postgres.js");
  const { createDb } = await import("@verity/db");

  const dataDir = mkdtempSync(path.join(tmpdir(), "verity-db-test-"));
  const port = await freePort();
  const pg = await startLocalPostgres({
    dataDir,
    port,
    user: "verity",
    password: "verity",
    database: "verity_test",
  });
  process.env.DATABASE_URL = pg.connectionString;

  const db = createDb(pg.connectionString);

  const dbPackageJson = require.resolve("@verity/db/package.json");
  const migrationFolder = path.join(path.dirname(dbPackageJson), "migrations");
  const migrator = new Migrator({
    db,
    provider: new FileMigrationProvider({ fs, path, migrationFolder }),
  });
  const { error, results } = await migrator.migrateToLatest();
  if (error) {
    await db.destroy();
    await pg.stop();
    rmSync(dataDir, { recursive: true, force: true });
    throw new Error(`migrations failed: ${String(error)} (ran ${results?.length ?? 0})`);
  }

  const reset = async () => {
    await db.executeQuery(sql.raw(`truncate ${TABLES.join(", ")} restart identity cascade`).compile(db));
  };

  const stop = async () => {
    await db.destroy();
    await pg.stop();
    rmSync(dataDir, { recursive: true, force: true });
  };

  return { connectionString: pg.connectionString, db, reset, stop };
}
