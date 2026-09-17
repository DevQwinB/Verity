import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireAuth } from "../../auth/plugin.js";
import { db } from "../../db.js";
import { escrowGateFor, escrowGateAsKeeper } from "../../chain/clients.js";
import { relaySignedXdr } from "../../chain/rpc.js";
import { bufFromHex, sha256Bytes, toChainTaskType } from "../../chain/mappers.js";
import { findOrCreateMarketplaceForAccount } from "../marketplaces/routes.js";

const submitBody = z.object({
  escrow_ref: z.string().min(1),
  task_type: z.enum(["deterministic", "retrieval", "unverifiable"]),
  input_hash: z.string().length(64),
  claimed_output_hash: z.string().length(64),
  input_ref: z.string().optional(),
  function_hash: z.string().optional(),
  function_ref: z.string().optional(),
  claimed_output_ref: z.string().optional(),
  escrow_value: z.string(),
  bond_amount: z.string(),
  idempotency_key: z.string().min(1),
});

export async function submissionsRoutes(app: FastifyInstance) {
  // Read-only list addition (beyond the PRD's literal §9 list, which only
  // specifies a per-id GET) — the dashboard has nothing to render a
  // submissions feed from without it, and faking one client-side would
  // violate the no-mocked-data requirement.
  app.get("/v1/submissions", async (req) => {
    const query = z
      .object({
        marketplace_id: z.string().uuid().optional(),
        agent_id: z.string().optional(),
        status: z
          .enum(["pending", "verified", "disputed", "slashed", "expired_unverified"])
          .optional(),
        limit: z.coerce.number().int().min(1).max(200).optional(),
      })
      .parse(req.query);
    let qb = db.selectFrom("submission").selectAll().orderBy("submitted_at", "desc");
    if (query.marketplace_id) qb = qb.where("marketplace_id", "=", query.marketplace_id);
    if (query.agent_id) qb = qb.where("agent_id", "=", query.agent_id);
    if (query.status) qb = qb.where("status", "=", query.status);
    return qb.limit(query.limit ?? 50).execute();
  });

  // Build-sign-relay-confirm step 1: create a pending row and hand back
  // unsigned XDR for the agent to sign with their own key. Verity never
  // holds the agent's signing key.
  app.post("/v1/submissions", { preHandler: requireAuth }, async (req, reply) => {
    const body = submitBody.parse(req.body);
    const agent = req.stellarAccount!;
    const marketplace = await findOrCreateMarketplaceForAccount(agent);

    const existing = await db
      .selectFrom("submission")
      .selectAll()
      .where("idempotency_key", "=", body.idempotency_key)
      .executeTakeFirst();
    if (existing) {
      reply.code(200);
      return existing;
    }

    const row = await db
      .insertInto("submission")
      .values({
        escrow_ref: body.escrow_ref,
        marketplace_id: marketplace.id,
        agent_id: agent,
        task_type: body.task_type,
        input_hash: body.input_hash,
        input_ref: body.input_ref ?? null,
        function_hash: body.function_hash ?? null,
        function_ref: body.function_ref ?? null,
        claimed_output_hash: body.claimed_output_hash,
        claimed_output_ref: body.claimed_output_ref ?? null,
        bond_amount: body.bond_amount,
        bond_asset: "native",
        challenge_window_s: 0, // set by the contract at submit() time; filled in on relay confirm
        idempotency_key: body.idempotency_key,
      })
      .returningAll()
      .executeTakeFirstOrThrow();

    const client = escrowGateFor(agent);
    const assembled = await client.submit({
      agent,
      escrow_ref: sha256Bytes(body.escrow_ref),
      escrow_value: BigInt(body.escrow_value),
      task_type: toChainTaskType(body.task_type),
      input_hash: bufFromHex(body.input_hash),
      output_hash: bufFromHex(body.claimed_output_hash),
      bond: BigInt(body.bond_amount),
    });

    reply.code(201);
    return {
      submission: row,
      unsigned_transaction_xdr: assembled.toXDR(),
      network_passphrase: process.env.NETWORK_PASSPHRASE,
    };
  });

  // Build-sign-relay-confirm step 2: relay the agent-signed XDR to real
  // testnet and reconcile the row with the real on-chain result. The chain
  // indexer independently reconciles the same event, so this is an
  // optimistic fast-path for the caller's own response, not the sole writer.
  app.post("/v1/submissions/:id/relay", { preHandler: requireAuth }, async (req, reply) => {
    const params = z.object({ id: z.string().uuid() }).parse(req.params);
    const body = z.object({ signed_transaction_xdr: z.string().min(1) }).parse(req.body);
    const { hash, returnValue } = await relaySignedXdr(body.signed_transaction_xdr);
    const chainSubmissionId = String(returnValue);

    const assembled = await escrowGateAsKeeper.get_submission({ id: BigInt(chainSubmissionId) });
    const onChain = assembled.result;

    const row = await db
      .updateTable("submission")
      .set({
        chain_submission_id: chainSubmissionId,
        chain_tx_hash: hash,
        challenge_window_s: onChain ? Number(onChain.challenge_window_s) : 0,
        updated_at: new Date(),
      })
      .where("id", "=", params.id)
      .returningAll()
      .executeTakeFirstOrThrow();

    return { submission: row, tx_hash: hash };
  });

  app.get("/v1/submissions/:id", async (req, reply) => {
    const params = z.object({ id: z.string().uuid() }).parse(req.params);
    const submission = await db
      .selectFrom("submission")
      .selectAll()
      .where("id", "=", params.id)
      .executeTakeFirst();
    if (!submission) {
      reply.code(404);
      return { error: "not found" };
    }
    const replays = await db
      .selectFrom("replay")
      .selectAll()
      .where("submission_id", "=", params.id)
      .execute();
    const spotChecks = await db
      .selectFrom("spot_check")
      .selectAll()
      .where("submission_id", "=", params.id)
      .execute();
    const challenge = await db
      .selectFrom("challenge")
      .selectAll()
      .where("submission_id", "=", params.id)
      .executeTakeFirst();
    return { submission, replays, spot_checks: spotChecks, challenge: challenge ?? null };
  });

  app.get("/v1/submissions/:id/proof", async (req, reply) => {
    const params = z.object({ id: z.string().uuid() }).parse(req.params);
    const proof = await db
      .selectFrom("zk_proof")
      .selectAll()
      .where("submission_id", "=", params.id)
      .executeTakeFirst();
    if (proof) return proof;
    // Honest by construction: ZKVerifierRegistry ships with zero registered
    // verifiers in this deployment, so there is never a fabricated proof here.
    return {
      available: false,
      phase: 1,
      reason:
        "No ZK verifier is registered on this deployment's ZKVerifierRegistry; Phase 2 selective ZK proving is not active. This submission's verdict (if any) was reached by economic re-execution consensus, not cryptographic proof.",
    };
  });
}
