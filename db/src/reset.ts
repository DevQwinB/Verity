import pg from "pg";

/**
 * Wipes the local development database so migrations can rebuild it from
 * scratch. Needed after redeploying EscrowGate: a new contract numbers its
 * submissions from 0 again, which collides with the old contract's rows.
 *
 * Refuses to touch anything that is not a local database.
 */
const connectionString = process.env.DATABASE_URL ?? "postgres://verity:verity@127.0.0.1:5433/verity";
const host = new URL(connectionString).hostname;
if (!["localhost", "127.0.0.1", "::1", "[::1]"].includes(host)) {
  console.error(`[reset] refusing to reset a non-local database (${host})`);
  process.exit(1);
}

const client = new pg.Client({ connectionString });
await client.connect();
await client.query("drop schema public cascade");
await client.query("create schema public");
await client.end();
console.log("[reset] local database wiped — run migrations (pnpm db:migrate, or just pnpm dev) to rebuild it");
