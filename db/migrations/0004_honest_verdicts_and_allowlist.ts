import { Kysely, sql } from "kysely";

export async function up(db: Kysely<any>): Promise<void> {
  // How a terminal verdict was reached is a property of the submission, not
  // only of a challenge: a window that elapsed without consensus must never
  // be shown as re-execution consensus. Mirrored from the chain record.
  await db.schema
    .alterTable("submission")
    .addColumn("resolution_method", "text", (c) =>
      c.check(sql`resolution_method in ('reexecution_consensus','window_elapsed','zk_proof')`)
    )
    .execute();
  // The transaction that finalized it (distinct from chain_tx_hash, the submit).
  await db.schema.alterTable("submission").addColumn("finalize_tx_hash", "text").execute();
  // Declared escrow value and the challenger bond floor the contract derived
  // from it, so the dashboard can say what a challenge costs before one is built.
  await db.schema.alterTable("submission").addColumn("escrow_value", "numeric").execute();
  await db.schema.alterTable("submission").addColumn("min_challenger_bond", "numeric").execute();

  // Mirrors ReexecutorInfo.approved (EscrowGate::set_reexecutor_approved).
  await db.schema
    .alterTable("reexecutor")
    .addColumn("approved", "boolean", (c) => c.notNull().defaultTo(false))
    .execute();

  // An assignment its re-executor never answered is kept as 'missed' rather
  // than deleted — it is the only record that they were asked.
  await sql`alter table replay drop constraint if exists replay_status_check`.execute(db);
  await sql`alter table replay add constraint replay_status_check check (status in ('assigned','submitted','confirmed_onchain','missed'))`.execute(db);

  // slash_tx_hash holds a transaction hash or nothing. Earlier keeper code
  // wrote a sentinel string into it when no slash transaction was sent.
  await sql`update replay set slash_tx_hash = null where slash_tx_hash = 'already-slashed'`.execute(db);

  // Attestations are signed and stored, not delivered to any registry. The
  // old default named a registry nothing was ever sent to.
  await sql`alter table attestation_export alter column target_registry set default 'none'`.execute(db);
  await sql`update attestation_export set target_registry = 'none' where target_registry = 'stellar-8004'`.execute(db);
}

export async function down(db: Kysely<any>): Promise<void> {
  await sql`alter table attestation_export alter column target_registry set default 'stellar-8004'`.execute(db);
  await sql`update replay set status = 'assigned' where status = 'missed'`.execute(db);
  await sql`alter table replay drop constraint if exists replay_status_check`.execute(db);
  await sql`alter table replay add constraint replay_status_check check (status in ('assigned','submitted','confirmed_onchain'))`.execute(db);
  await db.schema.alterTable("reexecutor").dropColumn("approved").execute();
  await db.schema.alterTable("submission").dropColumn("min_challenger_bond").execute();
  await db.schema.alterTable("submission").dropColumn("escrow_value").execute();
  await db.schema.alterTable("submission").dropColumn("finalize_tx_hash").execute();
  await db.schema.alterTable("submission").dropColumn("resolution_method").execute();
}
