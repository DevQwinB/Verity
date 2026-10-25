import { Kysely } from "kysely";

export async function up(db: Kysely<any>): Promise<void> {
  // When the relay endpoint last broadcast this draft's signed transaction.
  // A retry of POST /v1/submissions with the same idempotency key rebuilds the
  // transaction (new hash); while a broadcast one is still unresolved that
  // would orphan it, so the retry is held back until it has landed or expired.
  await db.schema.alterTable("submission").addColumn("relay_started_at", "timestamptz").execute();
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.alterTable("submission").dropColumn("relay_started_at").execute();
}
