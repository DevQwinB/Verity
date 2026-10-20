import { Kysely } from "kysely";

export async function up(db: Kysely<any>): Promise<void> {
  // Replace the global unique constraint on idempotency_key with a per-agent unique index.
  await db.schema
    .createIndex("submission_agent_idem_uq")
    .on("submission")
    .columns(["agent_id", "idempotency_key"])
    .unique()
    .where("idempotency_key", "is not", null)
    .execute();

  await db.schema.dropIndex("submission_idem_uq").execute();
}

export async function down(db: Kysely<any>): Promise<void> {
  // Revert back to global unique constraint on idempotency_key.
  // Note: down will fail if two different agents already share an idempotency_key.
  await db.schema
    .createIndex("submission_idem_uq")
    .on("submission")
    .column("idempotency_key")
    .unique()
    .where("idempotency_key", "is not", null)
    .execute();

  await db.schema.dropIndex("submission_agent_idem_uq").execute();
}
