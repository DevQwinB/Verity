import * as path from "node:path";
import { promises as fs } from "node:fs";
import { fileURLToPath } from "node:url";
import { Migrator, FileMigrationProvider } from "kysely/migration";

import { createDb } from "./index.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

async function main() {
  const direction = process.argv[2] === "down" ? "down" : "up";
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error("DATABASE_URL is required to run migrations");
  }

  const db = createDb(connectionString);
  const migrator = new Migrator({
    db,
    provider: new FileMigrationProvider({
      fs,
      path,
      migrationFolder: path.join(__dirname, "..", "migrations"),
    }),
  });

  const { error, results } =
    direction === "up" ? await migrator.migrateToLatest() : await migrator.migrateDown();

  for (const result of results ?? []) {
    if (result.status === "Success") {
      console.log(`[migrate] ${result.direction} ${result.migrationName}: OK`);
    } else if (result.status === "Error") {
      console.error(`[migrate] ${result.direction} ${result.migrationName}: FAILED`);
    }
  }

  await db.destroy();

  if (error) {
    console.error("[migrate] failed:", error);
    process.exit(1);
  }
}

main();
