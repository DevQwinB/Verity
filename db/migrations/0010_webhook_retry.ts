import { Kysely, sql } from "kysely";

export async function up(db: Kysely<any>): Promise<void> {
  // Add next_attempt_at column for webhook retry scheduling
  await db.schema
    .alterTable("webhook_delivery")
    .addColumn("next_attempt_at", "timestamptz")
    .execute();

  // Partial index for efficient retry scheduling
  await db.schema
    .createIndex("webhook_delivery_retry_idx")
    .on("webhook_delivery")
    .columns(["status", "next_attempt_at"])
    .where((eb) => eb("status", "in", ["pending", "failed"]))
    .execute();
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.dropIndex("webhook_delivery_retry_idx").execute();
  await db.schema.alterTable("webhook_delivery").dropColumn("next_attempt_at").execute();
}