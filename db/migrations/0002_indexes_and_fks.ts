import { Kysely, sql } from "kysely";

export async function up(db: Kysely<any>): Promise<void> {
  await db.schema
    .createIndex("submission_chain_id_uq")
    .on("submission")
    .column("chain_submission_id")
    .unique()
    .where("chain_submission_id", "is not", null)
    .execute();

  await db.schema
    .createIndex("submission_idem_uq")
    .on("submission")
    .column("idempotency_key")
    .unique()
    .where("idempotency_key", "is not", null)
    .execute();

  await db.schema
    .createIndex("submission_marketplace_status_idx")
    .on("submission")
    .columns(["marketplace_id", "status"])
    .execute();

  await db.schema
    .createIndex("submission_agent_idx")
    .on("submission")
    .column("agent_id")
    .execute();

  await db.schema
    .createIndex("submission_scheduler_idx")
    .on("submission")
    .columns(["status", "submitted_at"])
    .execute();

  await sql`
    create index reexecutor_active_stake_idx
      on reexecutor (active, stake_amount desc)
  `.execute(db);

  await db.schema
    .createIndex("replay_submission_reexecutor_uq")
    .on("replay")
    .columns(["submission_id", "reexecutor_id"])
    .unique()
    .execute();

  await db.schema
    .createIndex("replay_submission_idx")
    .on("replay")
    .column("submission_id")
    .execute();

  await db.schema
    .createIndex("spot_check_submission_reexecutor_uq")
    .on("spot_check")
    .columns(["submission_id", "reexecutor_id"])
    .unique()
    .execute();

  await db.schema
    .createIndex("challenge_open_uq")
    .on("challenge")
    .column("submission_id")
    .unique()
    .where("resolved_at", "is", null)
    .execute();

  await db.schema
    .createIndex("zk_proof_submission_idx")
    .on("zk_proof")
    .column("submission_id")
    .execute();

  await db.schema
    .createIndex("attestation_export_submission_idx")
    .on("attestation_export")
    .column("submission_id")
    .execute();

  await db.schema
    .createIndex("slashing_reexecutor_idx")
    .on("slashing_event")
    .column("reexecutor_id")
    .execute();

  await db.schema
    .createIndex("slashing_submission_idx")
    .on("slashing_event")
    .column("submission_id")
    .execute();

  await db.schema
    .createIndex("webhook_delivery_status_idx")
    .on("webhook_delivery")
    .columns(["status", "last_attempt_at"])
    .execute();

  await db.schema
    .createIndex("submission_artifact_submission_idx")
    .on("submission_artifact")
    .column("submission_id")
    .execute();
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.dropIndex("submission_artifact_submission_idx").execute();
  await db.schema.dropIndex("webhook_delivery_status_idx").execute();
  await db.schema.dropIndex("slashing_submission_idx").execute();
  await db.schema.dropIndex("slashing_reexecutor_idx").execute();
  await db.schema.dropIndex("attestation_export_submission_idx").execute();
  await db.schema.dropIndex("zk_proof_submission_idx").execute();
  await db.schema.dropIndex("challenge_open_uq").execute();
  await db.schema.dropIndex("spot_check_submission_reexecutor_uq").execute();
  await db.schema.dropIndex("replay_submission_idx").execute();
  await db.schema.dropIndex("replay_submission_reexecutor_uq").execute();
  await db.schema.dropIndex("reexecutor_active_stake_idx").execute();
  await db.schema.dropIndex("submission_scheduler_idx").execute();
  await db.schema.dropIndex("submission_agent_idx").execute();
  await db.schema.dropIndex("submission_marketplace_status_idx").execute();
  await db.schema.dropIndex("submission_idem_uq").execute();
  await db.schema.dropIndex("submission_chain_id_uq").execute();
}
