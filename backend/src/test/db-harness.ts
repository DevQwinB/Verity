import "./env-setup.js";
import { createServer } from "node:net";
import { promises as fs, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { sql } from "kysely";
import { Migrator, FileMigrationProvider } from "kysely/migration";
import type { Kysely } from "kysely";
import type { Database } from "@verity/db";
import { startLocalPostgres, createDb } from "@verity/db";
import { setDb } from "../db.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const isDbTestEnabled = process.env.VERITY_DB_TESTS === "1";

let pgInstance: { connectionString: string; stop: () => Promise<void> } | null = null;
let testDb: Kysely<Database> | null = null;
let tmpDir: string | null = null;

export async function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.listen(0, "127.0.0.1", () => {
      const port = (srv.address() as any).port;
      srv.close((err) => (err ? reject(err) : resolve(port)));
    });
  });
}

export async function setupTestDb(): Promise<{
  db: Kysely<Database>;
  reset: () => Promise<void>;
  teardown: () => Promise<void>;
}> {
  if (testDb) {
    return {
      db: testDb,
      reset: resetTestDb,
      teardown: teardownTestDb,
    };
  }

  const port = await getFreePort();
  tmpDir = mkdtempSync(path.join(tmpdir(), "verity-db-test-"));

  pgInstance = await startLocalPostgres({
    port,
    dataDir: tmpDir,
    user: "verity_test",
    password: "verity_test_password",
    database: "verity_test",
  });

  process.env.DATABASE_URL = pgInstance.connectionString;
  testDb = createDb(pgInstance.connectionString);
  setDb(testDb);

  const migrator = new Migrator({
    db: testDb,
    provider: {
      async getMigrations() {
        const migrations: Record<string, any> = {};
        const migrationFolder = path.resolve(__dirname, "../../../db/migrations");
        const files = await fs.readdir(migrationFolder);
        for (const file of files.sort()) {
          if ((file.endsWith(".ts") || file.endsWith(".js")) && !file.endsWith(".d.ts")) {
            const { pathToFileURL } = await import("node:url");
            const fileUrl = pathToFileURL(path.join(migrationFolder, file)).href;
            const migration = await import(fileUrl);
            const migrationKey = file.substring(0, file.lastIndexOf("."));
            migrations[migrationKey] = migration;
          }
        }
        return migrations;
      },
    },
  });

  const { error } = await migrator.migrateToLatest();
  if (error) {
    throw error;
  }

  return {
    db: testDb,
    reset: resetTestDb,
    teardown: teardownTestDb,
  };
}

export async function resetTestDb(): Promise<void> {
  if (!testDb) return;
  await sql`
    TRUNCATE TABLE
      webhook_delivery,
      webhook_subscription,
      slashing_event,
      attestation_export,
      zk_proof,
      challenge,
      spot_check,
      replay,
      submission_artifact,
      submission,
      reexecutor,
      chain_cursor,
      marketplace
    RESTART IDENTITY CASCADE
  `.execute(testDb);
}

export async function teardownTestDb(): Promise<void> {
  if (testDb) {
    setDb(null);
    await testDb.destroy();
    testDb = null;
  }
  if (pgInstance) {
    await pgInstance.stop();
    pgInstance = null;
  }
  if (tmpDir) {
    try {
      rmSync(tmpDir, { recursive: true, force: true });
    } catch {}
    tmpDir = null;
  }
}

export const db: Kysely<Database> = new Proxy({} as Kysely<Database>, {
  get(_target, prop) {
    if (!testDb) {
      throw new Error("Test database not initialized. Call await setupTestDb() before accessing db.");
    }
    const val = (testDb as any)[prop];
    if (typeof val === "function") {
      return val.bind(testDb);
    }
    return val;
  },
});

export const reset = resetTestDb;

