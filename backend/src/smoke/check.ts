import { createDb } from "@verity/db";
const db = createDb("postgres://verity:verity@localhost:5433/verity");
const rows = await db
  .selectFrom("submission")
  .select(["id", "status", "chain_submission_id", "chain_tx_hash", "updated_at"])
  .orderBy("submitted_at")
  .execute();
console.log(JSON.stringify(rows, null, 2));
await db.destroy();
