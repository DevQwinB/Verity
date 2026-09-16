import EmbeddedPostgres from "embedded-postgres";

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
  const pg = new EmbeddedPostgres({
    databaseDir: opts?.dataDir ?? ".pgdata",
    user: opts?.user ?? "verity",
    password: opts?.password ?? "verity",
    port: opts?.port ?? 5433,
    persistent: true,
  });

  await pg.initialise();
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
