import { startLocalPostgres } from "./local-postgres.js";
import { writeFileSync } from "node:fs";

// usage: dev-postgres-daemon.ts [dataDir] [urlFile] [port]
const { connectionString, stop } = await startLocalPostgres({
  dataDir: process.argv[2] || ".pgdata",
  port: Number(process.argv[4] || process.env.PGPORT || 5433),
});
if (process.argv[3]) writeFileSync(process.argv[3], connectionString);
console.log("READY " + connectionString);

// Shut Postgres down cleanly with the daemon, instead of orphaning it.
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    stop().finally(() => process.exit(0));
  });
}
// keep process alive
setInterval(() => {}, 1 << 30);
