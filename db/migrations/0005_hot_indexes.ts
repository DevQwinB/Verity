import { Kysely, sql } from "kysely";

export async function up(db: Kysely<any>): Promise<void> {
  await db.schema
    .createIndex("replay_reexecutor_status_idx")
    .on("replay")
    .columns(["reexecutor_id", "status"])
    .execute();

  await db.schema
    .createIndex("spot_check_reexecutor_idx")
    .on("spot_check")
    .column("reexecutor_id")
    .execute();

  await sql`
    create index challenge_opened_at_idx
      on challenge (opened_at desc, id)
  `.execute(db);
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.dropIndex("challenge_opened_at_idx").execute();
  await db.schema.dropIndex("spot_check_reexecutor_idx").execute();
  await db.schema.dropIndex("replay_reexecutor_status_idx").execute();
}
