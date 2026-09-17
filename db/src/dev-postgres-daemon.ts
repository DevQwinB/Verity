import { startLocalPostgres } from "./local-postgres.js";
import { writeFileSync } from "node:fs";

const { connectionString } = await startLocalPostgres({ dataDir: process.argv[2] || ".pgdata", port: 5433 });
writeFileSync(process.argv[3] || "/tmp/verity-db-url.txt", connectionString);
console.log("READY " + connectionString);
// keep process alive
setInterval(() => {}, 1 << 30);
