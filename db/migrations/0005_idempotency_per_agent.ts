import { Kysely } from "kysely";

export async function up(db: Kysely<any>): Promise<void> {
  // Replace the global idempotency_key unique index with a composite unique
  // index on (agent_id, idempotency_key) so different agents can reuse the same
  // key independently without colliding.
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
  // Revert back to global idempotency key uniqueness.
  // Note: this will fail if multiple agents have already used the same idempotency_key.
  await db.schema
    .createIndex("submission_idem_uq")
    .on("submission")
    .column("idempotency_key")
    .unique()
    .where("idempotency_key", "is not", null)
    .execute();

  await db.schema.dropIndex("submission_agent_idem_uq").execute();
}
