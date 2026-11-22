import { Kysely, sql } from "kysely";

export async function up(db: Kysely<any>): Promise<void> {
  // When a failed (or crash-orphaned `pending`) delivery may be attempted
  // again. Null means no further attempt: delivered, terminally failed
  // (unretryable status code), or attempts exhausted.
  await db.schema.alterTable("webhook_delivery").addColumn("next_attempt_at", "timestamptz").execute();
  await db.schema
    .createIndex("webhook_delivery_retry_idx")
    .on("webhook_delivery")
    .column("next_attempt_at")
    .where(sql<boolean>`status in ('pending', 'failed')`)
    .execute();
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.dropIndex("webhook_delivery_retry_idx").execute();
  await db.schema.alterTable("webhook_delivery").dropColumn("next_attempt_at").execute();
}
