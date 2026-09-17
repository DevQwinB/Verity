import EmbeddedPostgres from "embedded-postgres";
import { existsSync } from "node:fs";
import * as path from "node:path";

/**
 * Runs a real Postgres server as a plain user process (no docker, no root)
 * by downloading and executing the actual Postgres binary. Used for local
 * dev/CI in environments without docker — this is a genuine Postgres
 * instance, not an in-memory fake; docker-compose.yml remains the intended
 * path wherever docker is available.
 */
export async function startLocalPostgres(opts?: {
  port?: number;
  dataDir?: string;
  user?: string;
  password?: string;
  database?: string;
}) {
  const dataDir = opts?.dataDir ?? ".pgdata";
  const pg = new EmbeddedPostgres({
    databaseDir: dataDir,
    user: opts?.user ?? "verity",
    password: opts?.password ?? "verity",
    port: opts?.port ?? 5433,
    persistent: true,
  });

  // A previously-initialised cluster (PG_VERSION present) must be started
  // as-is, never re-initialised — initdb refuses to run against a non-empty
  // directory, which otherwise breaks the ordinary "restart with existing
  // data" workflow every time.
  const alreadyInitialised = existsSync(path.join(dataDir, "PG_VERSION"));
  if (!alreadyInitialised) {
    await pg.initialise();
  }
  await pg.start();

  const dbName = opts?.database ?? "verity";
  try {
    await pg.createDatabase(dbName);
  } catch {
    // already exists
  }

  const connectionString = `postgres://${opts?.user ?? "verity"}:${opts?.password ?? "verity"}@localhost:${opts?.port ?? 5433}/${dbName}`;

  return {
    connectionString,
    stop: () => pg.stop(),
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  startLocalPostgres().then(({ connectionString }) => {
    console.log(`[local-postgres] listening, DATABASE_URL=${connectionString}`);
    console.log("[local-postgres] press Ctrl+C to stop");
  });
}
