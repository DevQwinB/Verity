import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireAuth } from "../../auth/plugin.js";
import { db } from "../../db.js";
import { escrowGateFor, escrowGateAsKeeper } from "../../chain/clients.js";
import { relaySignedXdr } from "../../chain/rpc.js";

export async function reexecutorsRoutes(app: FastifyInstance) {
  // Permissionless registration: ANY real Stellar account may stake in, from
  // day one — no special-cased bootstrap path. Build-sign-relay-confirm: we
  // never touch the caller's key, only build the unsigned stake transaction.
  app.post("/v1/reexecutors", { preHandler: requireAuth }, async (req, reply) => {
    const body = z.object({ stake_amount: z.string().regex(/^[1-9]\d*$/, "must be a positive integer amount in stroops") }).parse(req.body);
    const account = req.stellarAccount!;

    // Build (and simulate) before touching the DB, so a stake the contract
    // would reject never leaves a phantom re-executor row behind.
    const client = escrowGateFor(account);
    const assembled = await client.register_reexecutor({
      reexecutor: account,
      stake_amount: BigInt(body.stake_amount),
    });
    const unsignedXdr = assembled.toXDR();

    let row = await db
      .selectFrom("reexecutor")
      .selectAll()
      .where("stellar_account", "=", account)
      .executeTakeFirst();
    if (!row) {
      row = await db
        .insertInto("reexecutor")
        .values({
          stellar_account: account,
          // Nothing is staked until the signed transaction lands; the
          // relay step (and the indexer) fill in the real on-chain amount.
          stake_amount: "0",
          stake_asset: "native",
        })
        .returningAll()
        .executeTakeFirstOrThrow();
    }

    reply.code(201);
    return { reexecutor: row, unsigned_transaction_xdr: unsignedXdr };
  });

  // An account that staked directly on-chain (e.g. scripts/bootstrap_reexecutors.sh),
  // or before this backend's event-retention horizon, has no row here yet.
  // This mirrors its real on-chain stake into Postgres — it reads the chain,
  // it never moves funds.
  app.post("/v1/reexecutors/sync", { preHandler: requireAuth }, async (req, reply) => {
    const account = req.stellarAccount!;
    const onChain = await escrowGateAsKeeper.reexecutor_info({ reexecutor: account });
    const info = onChain.result;
    if (!info) {
      reply.code(404);
      return { error: "this account has no stake on EscrowGate — register via POST /v1/reexecutors first" };
    }
    const row = await db
      .insertInto("reexecutor")
      .values({
        stellar_account: account,
        stake_amount: info.stake_amount.toString(),
        stake_asset: "native",
        active: info.active,
        last_seen_at: new Date(),
      })
      .onConflict((oc) =>
        oc.column("stellar_account").doUpdateSet({
          stake_amount: info.stake_amount.toString(),
          active: info.active,
          last_seen_at: new Date(),
        })
      )
      .returningAll()
      .executeTakeFirstOrThrow();
    return { reexecutor: row };
  });

  app.post("/v1/reexecutors/:id/relay", { preHandler: requireAuth }, async (req, reply) => {
    const params = z.object({ id: z.string().uuid() }).parse(req.params);
    const body = z.object({ signed_transaction_xdr: z.string().min(1) }).parse(req.body);
    const row = await db.selectFrom("reexecutor").selectAll().where("id", "=", params.id).executeTakeFirst();
    if (!row || row.stellar_account !== req.stellarAccount) {
      reply.code(403);
      return { error: "forbidden" };
    }
    const { hash } = await relaySignedXdr(body.signed_transaction_xdr);
    const onChain = await escrowGateAsKeeper.reexecutor_info({ reexecutor: row.stellar_account });
    const info = onChain.result;

    const updated = await db
      .updateTable("reexecutor")
      .set({
        active: info?.active ?? false,
        stake_amount: info ? info.stake_amount.toString() : row.stake_amount,
        chain_stake_tx_hash: hash,
      })
      .where("id", "=", params.id)
      .returningAll()
      .executeTakeFirstOrThrow();

    return { reexecutor: updated, tx_hash: hash };
  });

  app.get("/v1/reexecutors/:id", async (req, reply) => {
    const params = z.object({ id: z.string().uuid() }).parse(req.params);
    const row = await db.selectFrom("reexecutor").selectAll().where("id", "=", params.id).executeTakeFirst();
    if (!row) {
      reply.code(404);
      return { error: "not found" };
    }
    const slashes = await db
      .selectFrom("slashing_event")
      .selectAll()
      .where("reexecutor_id", "=", params.id)
      .execute();
    return { reexecutor: row, slashing_events: slashes };
  });

  app.get("/v1/reexecutors", async () => {
    return db.selectFrom("reexecutor").selectAll().orderBy("stake_amount", "desc").execute();
  });

  // Internal addition (beyond the PRD's literal §9 list): lets a
  // reexecutor-agent worker poll for work assigned to it, authenticated as
  // itself via the same SEP-10 JWT.
  app.get("/v1/reexecutors/:id/assignments", { preHandler: requireAuth }, async (req, reply) => {
    const params = z.object({ id: z.string().uuid() }).parse(req.params);
    const row = await db.selectFrom("reexecutor").selectAll().where("id", "=", params.id).executeTakeFirst();
    if (!row || row.stellar_account !== req.stellarAccount) {
      reply.code(403);
      return { error: "forbidden" };
    }
    const replayAssignments = await db
      .selectFrom("replay")
      .innerJoin("submission", "submission.id", "replay.submission_id")
      .selectAll("replay")
      .select(["submission.task_type", "submission.input_ref", "submission.function_ref", "submission.claimed_output_hash", "submission.chain_submission_id"])
      .where("replay.reexecutor_id", "=", params.id)
      .where("replay.status", "=", "assigned")
      .where("submission.status", "in", ["pending", "disputed"])
      .execute();
    await db.updateTable("reexecutor").set({ last_seen_at: new Date() }).where("id", "=", params.id).execute();
    const spotCheckAssignments = await db
      .selectFrom("spot_check")
      .innerJoin("submission", "submission.id", "spot_check.submission_id")
      .selectAll("spot_check")
      .select(["submission.task_type", "submission.input_ref", "submission.function_ref", "submission.claimed_output_hash", "submission.chain_submission_id"])
      .where("submission.status", "in", ["pending", "disputed"])
      .where("spot_check.reexecutor_id", "=", params.id)
      .where("spot_check.result", "is", null)
      .execute();
    return { replay_assignments: replayAssignments, spot_check_assignments: spotCheckAssignments };
  });
}
