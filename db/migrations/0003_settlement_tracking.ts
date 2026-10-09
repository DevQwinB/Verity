import { Kysely, sql } from "kysely";

export async function up(db: Kysely<any>): Promise<void> {
  // Post-finalize keeper work (slashing wrong-side re-executors, releasing
  // attestation locks) is tracked per row so it is retryable and never redone.
  await db.schema.alterTable("submission").addColumn("settled_at", "timestamptz").execute();
  await db.schema.alterTable("replay").addColumn("slash_tx_hash", "text").execute();
  await db.schema.alterTable("replay").addColumn("lock_released_at", "timestamptz").execute();

  // Indexer handlers must be safe to replay: one row per on-chain event.
  await db.schema
    .createIndex("slashing_event_tx_reexecutor_uq")
    .on("slashing_event")
    .columns(["tx_hash", "reexecutor_id"])
    .unique()
    .where(sql.ref("tx_hash"), "is not", null)
    .execute();

  await db.schema
    .createIndex("challenge_chain_tx_uq")
    .on("challenge")
    .column("chain_tx_hash")
    .unique()
    .where(sql.ref("chain_tx_hash"), "is not", null)
    .execute();

  await db.schema
    .createIndex("attestation_export_submission_registry_uq")
    .on("attestation_export")
    .columns(["submission_id", "target_registry"])
    .unique()
    .execute();
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.dropIndex("attestation_export_submission_registry_uq").execute();
  await db.schema.dropIndex("challenge_chain_tx_uq").execute();
  await db.schema.dropIndex("slashing_event_tx_reexecutor_uq").execute();
  await db.schema.alterTable("replay").dropColumn("lock_released_at").execute();
  await db.schema.alterTable("replay").dropColumn("slash_tx_hash").execute();
  await db.schema.alterTable("submission").dropColumn("settled_at").execute();
}
