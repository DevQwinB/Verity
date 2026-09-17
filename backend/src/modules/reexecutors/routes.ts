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
    const body = z.object({ stake_amount: z.string() }).parse(req.body);
    const account = req.stellarAccount!;

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
          stake_amount: body.stake_amount,
          stake_asset: "native",
        })
        .returningAll()
        .executeTakeFirstOrThrow();
    }

    const client = escrowGateFor(account);
    const assembled = await client.register_reexecutor({
      reexecutor: account,
      stake_amount: BigInt(body.stake_amount),
    });

    reply.code(201);
    return { reexecutor: row, unsigned_transaction_xdr: assembled.toXDR() };
  });

  app.post("/v1/reexecutors/:id/relay", { preHandler: requireAuth }, async (req, reply) => {
    const params = z.object({ id: z.string().uuid() }).parse(req.params);
    const body = z.object({ signed_transaction_xdr: z.string().min(1) }).parse(req.body);
    const { hash } = await relaySignedXdr(body.signed_transaction_xdr);

    const row = await db.selectFrom("reexecutor").selectAll().where("id", "=", params.id).executeTakeFirstOrThrow();
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
      .execute();
    const spotCheckAssignments = await db
      .selectFrom("spot_check")
      .innerJoin("submission", "submission.id", "spot_check.submission_id")
      .selectAll("spot_check")
      .select(["submission.claimed_output_ref", "submission.chain_submission_id"])
      .where("spot_check.reexecutor_id", "=", params.id)
      .where("spot_check.result", "is", null)
      .execute();
    return { replay_assignments: replayAssignments, spot_check_assignments: spotCheckAssignments };
  });
}
