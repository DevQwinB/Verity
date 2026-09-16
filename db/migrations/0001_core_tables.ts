import { Kysely, sql } from "kysely";

export async function up(db: Kysely<any>): Promise<void> {
  await sql`create extension if not exists pgcrypto`.execute(db);

  await db.schema
    .createTable("marketplace")
    .addColumn("id", "uuid", (c) => c.primaryKey().defaultTo(sql`gen_random_uuid()`))
    .addColumn("stellar_account", "text", (c) => c.notNull().unique())
    .addColumn("name", "text", (c) => c.notNull())
    .addColumn("webhook_secret", "text")
    .addColumn("created_at", "timestamptz", (c) => c.notNull().defaultTo(sql`now()`))
    .execute();

  await db.schema
    .createTable("submission")
    .addColumn("id", "uuid", (c) => c.primaryKey().defaultTo(sql`gen_random_uuid()`))
    .addColumn("escrow_ref", "text", (c) => c.notNull())
    .addColumn("marketplace_id", "uuid", (c) => c.notNull().references("marketplace.id"))
    .addColumn("agent_id", "text", (c) => c.notNull())
    .addColumn("task_type", "text", (c) =>
      c.notNull().check(sql`task_type in ('deterministic','retrieval','unverifiable')`)
    )
    .addColumn("input_hash", "text", (c) => c.notNull())
    .addColumn("input_ref", "text")
    .addColumn("function_hash", "text")
    .addColumn("function_ref", "text")
    .addColumn("claimed_output_hash", "text", (c) => c.notNull())
    .addColumn("claimed_output_ref", "text")
    .addColumn("bond_amount", "numeric", (c) => c.notNull().check(sql`bond_amount >= 0`))
    .addColumn("bond_asset", "text", (c) => c.notNull())
    .addColumn("submitted_at", "timestamptz", (c) => c.notNull().defaultTo(sql`now()`))
    .addColumn("challenge_window_s", "integer", (c) => c.notNull())
    .addColumn("status", "text", (c) =>
      c
        .notNull()
        .defaultTo("pending")
        .check(
          sql`status in ('pending','verified','disputed','slashed','expired_unverified')`
        )
    )
    .addColumn("chain_submission_id", "bigint")
    .addColumn("chain_tx_hash", "text")
    .addColumn("idempotency_key", "text")
    .addColumn("finalize_attempted_at", "timestamptz")
    .addColumn("created_at", "timestamptz", (c) => c.notNull().defaultTo(sql`now()`))
    .addColumn("updated_at", "timestamptz", (c) => c.notNull().defaultTo(sql`now()`))
    .execute();

  await db.schema
    .createTable("reexecutor")
    .addColumn("id", "uuid", (c) => c.primaryKey().defaultTo(sql`gen_random_uuid()`))
    .addColumn("stellar_account", "text", (c) => c.notNull().unique())
    .addColumn("stake_amount", "numeric", (c) => c.notNull())
    .addColumn("stake_asset", "text", (c) => c.notNull())
    .addColumn("reputation_score", "numeric", (c) => c.notNull().defaultTo(0))
    .addColumn("active", "boolean", (c) => c.notNull().defaultTo(false))
    .addColumn("slashed_count", "integer", (c) => c.notNull().defaultTo(0))
    .addColumn("chain_stake_tx_hash", "text")
    .addColumn("last_seen_at", "timestamptz")
    .addColumn("joined_at", "timestamptz", (c) => c.notNull().defaultTo(sql`now()`))
    .execute();

  await db.schema
    .createTable("replay")
    .addColumn("id", "uuid", (c) => c.primaryKey().defaultTo(sql`gen_random_uuid()`))
    .addColumn("submission_id", "uuid", (c) =>
      c.notNull().references("submission.id").onDelete("cascade")
    )
    .addColumn("reexecutor_id", "uuid", (c) => c.notNull().references("reexecutor.id"))
    .addColumn("status", "text", (c) =>
      c
        .notNull()
        .defaultTo("assigned")
        .check(sql`status in ('assigned','submitted','confirmed_onchain')`)
    )
    .addColumn("assignment_seed", "text")
    .addColumn("replay_output_hash", "text")
    .addColumn("match", "boolean")
    .addColumn("latency_ms", "integer")
    .addColumn("cost", "numeric")
    .addColumn("tx_hash", "text")
    .addColumn("assigned_at", "timestamptz", (c) => c.notNull().defaultTo(sql`now()`))
    .addColumn("executed_at", "timestamptz")
    .execute();

  await db.schema
    .createTable("spot_check")
    .addColumn("id", "uuid", (c) => c.primaryKey().defaultTo(sql`gen_random_uuid()`))
    .addColumn("submission_id", "uuid", (c) =>
      c.notNull().references("submission.id").onDelete("cascade")
    )
    .addColumn("reexecutor_id", "uuid", (c) => c.notNull().references("reexecutor.id"))
    .addColumn("sampled_at", "timestamptz", (c) => c.notNull().defaultTo(sql`now()`))
    .addColumn("result", "text", (c) =>
      c.check(sql`result in ('match','mismatch','inconclusive')`)
    )
    .addColumn("evidence", "jsonb")
    .execute();

  await db.schema
    .createTable("challenge")
    .addColumn("id", "uuid", (c) => c.primaryKey().defaultTo(sql`gen_random_uuid()`))
    .addColumn("submission_id", "uuid", (c) =>
      c.notNull().references("submission.id").onDelete("cascade")
    )
    .addColumn("challenger_account", "text", (c) => c.notNull())
    .addColumn("challenger_bond", "numeric", (c) => c.notNull())
    .addColumn("opened_at", "timestamptz", (c) => c.notNull().defaultTo(sql`now()`))
    .addColumn("resolved_at", "timestamptz")
    .addColumn("resolution", "text", (c) => c.check(sql`resolution in ('upheld','rejected')`))
    .addColumn("resolution_method", "text", (c) =>
      c.check(
        sql`resolution_method in ('reexecution_consensus','zk_proof','manual_review')`
      )
    )
    .addColumn("chain_tx_hash", "text")
    .execute();

  await db.schema
    .createTable("zk_proof")
    .addColumn("id", "uuid", (c) => c.primaryKey().defaultTo(sql`gen_random_uuid()`))
    .addColumn("submission_id", "uuid", (c) =>
      c.notNull().references("submission.id").onDelete("cascade")
    )
    .addColumn("proof_system", "text")
    .addColumn("verifier_contract", "text")
    .addColumn("proof_blob_ref", "text")
    .addColumn("verified_onchain", "boolean")
    .addColumn("tx_hash", "text")
    .addColumn("cost", "numeric")
    .addColumn("proving_time_ms", "integer")
    .addColumn("created_at", "timestamptz", (c) => c.notNull().defaultTo(sql`now()`))
    .execute();

  await db.schema
    .createTable("attestation_export")
    .addColumn("id", "uuid", (c) => c.primaryKey().defaultTo(sql`gen_random_uuid()`))
    .addColumn("submission_id", "uuid", (c) =>
      c.notNull().references("submission.id").onDelete("cascade")
    )
    .addColumn("target_registry", "text", (c) => c.notNull().defaultTo("stellar-8004"))
    .addColumn("payload", "jsonb", (c) => c.notNull())
    .addColumn("signature", "text", (c) => c.notNull())
    .addColumn("exported_at", "timestamptz", (c) => c.notNull().defaultTo(sql`now()`))
    .execute();

  await db.schema
    .createTable("slashing_event")
    .addColumn("id", "uuid", (c) => c.primaryKey().defaultTo(sql`gen_random_uuid()`))
    .addColumn("reexecutor_id", "uuid", (c) => c.notNull().references("reexecutor.id"))
    .addColumn("submission_id", "uuid", (c) => c.references("submission.id"))
    .addColumn("amount", "numeric", (c) => c.notNull())
    .addColumn("reason", "text", (c) => c.notNull())
    .addColumn("tx_hash", "text")
    .addColumn("created_at", "timestamptz", (c) => c.notNull().defaultTo(sql`now()`))
    .execute();

  await db.schema
    .createTable("submission_artifact")
    .addColumn("id", "uuid", (c) => c.primaryKey().defaultTo(sql`gen_random_uuid()`))
    .addColumn("submission_id", "uuid", (c) =>
      c.notNull().references("submission.id").onDelete("cascade")
    )
    .addColumn("kind", "text", (c) =>
      c.notNull().check(sql`kind in ('input','function','output','request_spec')`)
    )
    .addColumn("content_hash", "text", (c) => c.notNull())
    .addColumn("storage_ref", "text", (c) => c.notNull())
    .addColumn("content_type", "text")
    .addColumn("size_bytes", "integer")
    .addColumn("created_at", "timestamptz", (c) => c.notNull().defaultTo(sql`now()`))
    .execute();

  await db.schema
    .createTable("webhook_subscription")
    .addColumn("id", "uuid", (c) => c.primaryKey().defaultTo(sql`gen_random_uuid()`))
    .addColumn("marketplace_id", "uuid", (c) =>
      c.notNull().references("marketplace.id").onDelete("cascade")
    )
    .addColumn("url", "text", (c) => c.notNull())
    .addColumn("secret", "text", (c) => c.notNull())
    .addColumn("events", sql`text[]`, (c) => c.notNull())
    .addColumn("active", "boolean", (c) => c.notNull().defaultTo(true))
    .addColumn("created_at", "timestamptz", (c) => c.notNull().defaultTo(sql`now()`))
    .execute();

  await db.schema
    .createTable("webhook_delivery")
    .addColumn("id", "uuid", (c) => c.primaryKey().defaultTo(sql`gen_random_uuid()`))
    .addColumn("subscription_id", "uuid", (c) =>
      c.notNull().references("webhook_subscription.id").onDelete("cascade")
    )
    .addColumn("event_type", "text", (c) => c.notNull())
    .addColumn("payload", "jsonb", (c) => c.notNull())
    .addColumn("status", "text", (c) =>
      c.notNull().defaultTo("pending").check(sql`status in ('pending','delivered','failed')`)
    )
    .addColumn("attempts", "integer", (c) => c.notNull().defaultTo(0))
    .addColumn("last_attempt_at", "timestamptz")
    .addColumn("response_code", "integer")
    .addColumn("created_at", "timestamptz", (c) => c.notNull().defaultTo(sql`now()`))
    .execute();

  await db.schema
    .createTable("chain_cursor")
    .addColumn("contract_id", "text", (c) => c.primaryKey())
    .addColumn("last_ledger", "bigint", (c) => c.notNull().defaultTo(0))
    .addColumn("last_paging_token", "text")
    .addColumn("updated_at", "timestamptz", (c) => c.notNull().defaultTo(sql`now()`))
    .execute();
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.dropTable("chain_cursor").execute();
  await db.schema.dropTable("webhook_delivery").execute();
  await db.schema.dropTable("webhook_subscription").execute();
  await db.schema.dropTable("submission_artifact").execute();
  await db.schema.dropTable("slashing_event").execute();
  await db.schema.dropTable("attestation_export").execute();
  await db.schema.dropTable("zk_proof").execute();
  await db.schema.dropTable("challenge").execute();
  await db.schema.dropTable("spot_check").execute();
  await db.schema.dropTable("replay").execute();
  await db.schema.dropTable("reexecutor").execute();
  await db.schema.dropTable("submission").execute();
  await db.schema.dropTable("marketplace").execute();
}
