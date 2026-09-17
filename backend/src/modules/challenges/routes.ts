import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireAuth } from "../../auth/plugin.js";
import { db } from "../../db.js";
import { escrowGateFor } from "../../chain/clients.js";
import { relaySignedXdr } from "../../chain/rpc.js";

export async function challengesRoutes(app: FastifyInstance) {
  app.post("/v1/submissions/:id/challenge", { preHandler: requireAuth }, async (req, reply) => {
    const params = z.object({ id: z.string().uuid() }).parse(req.params);
    const body = z.object({ bond: z.string() }).parse(req.body);
    const challenger = req.stellarAccount!;

    const submission = await db
      .selectFrom("submission")
      .selectAll()
      .where("id", "=", params.id)
      .executeTakeFirst();
    if (!submission?.chain_submission_id) {
      reply.code(404);
      return { error: "submission not found or not yet confirmed on-chain" };
    }

    const client = escrowGateFor(challenger);
    const assembled = await client.open_challenge({
      challenger,
      submission_id: BigInt(submission.chain_submission_id),
      bond: BigInt(body.bond),
    });

    reply.code(201);
    return { unsigned_transaction_xdr: assembled.toXDR() };
  });

  app.post("/v1/submissions/:id/challenge/relay", { preHandler: requireAuth }, async (req, reply) => {
    const params = z.object({ id: z.string().uuid() }).parse(req.params);
    const body = z.object({ signed_transaction_xdr: z.string().min(1) }).parse(req.body);
    const { hash } = await relaySignedXdr(body.signed_transaction_xdr);
    return { tx_hash: hash, note: "chain indexer will reconcile the challenge row from the on-chain event" };
  });
}
