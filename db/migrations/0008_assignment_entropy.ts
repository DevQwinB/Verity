import { Kysely, sql } from "kysely";

export async function up(db: Kysely<any>): Promise<void> {
  // submission.assignment_entropy stores the ledger hash of the submit transaction
  // to ensure assignment seeds cannot be predicted or manipulated by agents.
  await db.schema.alterTable("submission").addColumn("assignment_entropy", "text").execute();

  // spot_check.assignment_seed stores the seed used to assign the spot-checker,
  // making spot-check assignments reproducible and auditable.
  await db.schema.alterTable("spot_check").addColumn("assignment_seed", "text").execute();

  // Store the ranked candidate accounts (JSON array of stellar accounts) at assignment time.
  await db.schema.alterTable("replay").addColumn("candidate_accounts", "jsonb").execute();
  await db.schema.alterTable("spot_check").addColumn("candidate_accounts", "jsonb").execute();
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.alterTable("spot_check").dropColumn("candidate_accounts").execute();
  await db.schema.alterTable("replay").dropColumn("candidate_accounts").execute();
  await db.schema.alterTable("spot_check").dropColumn("assignment_seed").execute();
  await db.schema.alterTable("submission").dropColumn("assignment_entropy").execute();
}
