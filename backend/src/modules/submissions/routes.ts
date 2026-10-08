import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireAuth } from "../../auth/plugin.js";
import { db } from "../../db.js";
import { escrowGateFor } from "../../chain/clients.js";
import { readSubmission } from "../../chain/actions.js";
import { env } from "../../config/env.js";
import { relaySignedXdr } from "../../chain/rpc.js";
import { bufFromHex, sha256Bytes, toChainTaskType } from "../../chain/mappers.js";
import { findOrCreateMarketplaceForAccount } from "../marketplaces/routes.js";

const sha256Hex = z.string().regex(/^[0-9a-f]{64}$/, "must be a lowercase hex sha256 digest");
const stroops = z.string().regex(/^\d+$/, "must be an integer amount in stroops");

const submitBody = z.object({
  escrow_ref: z.string().min(1),
  // "unverifiable" is in the taxonomy but has no on-chain path in Phase 1 —
  // the contract rejects it, so it is rejected here with a clear message.
  task_type: z.enum(["deterministic", "retrieval"]),
  input_hash: sha256Hex,
  claimed_output_hash: sha256Hex,
  input_ref: z.string().optional(),
  function_hash: z.string().optional(),
  function_ref: z.string().optional(),
  claimed_output_ref: z.string().optional(),
  escrow_value: stroops,
  bond_amount: stroops,
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
        include_drafts: z.enum(["true", "false"]).optional(),
      })
      .parse(req.query);
    let qb = db.selectFrom("submission").selectAll().orderBy("submitted_at", "desc");
    // A draft is a row whose submit() transaction was built but never signed
    // and relayed — it does not exist on-chain, so it is not listed by default.
    if (query.include_drafts !== "true") qb = qb.where("chain_submission_id", "is not", null);
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

    if (body.task_type === "deterministic" && (!body.function_ref || !body.input_ref)) {
      reply.code(400);
      return { error: "deterministic submissions need function_ref and input_ref artifacts for re-executors to replay" };
    }
    if (body.task_type === "retrieval" && !body.input_ref) {
      reply.code(400);
      return { error: "retrieval submissions need an input_ref artifact holding the request spec" };
    }

    // Build (and simulate) first: a submission the contract would reject —
    // bond too low, insufficient balance — fails here with the contract's own
    // error and never leaves an orphan row behind.
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
    const unsignedXdr = assembled.toXDR();

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
        // A transaction's hash does not cover its signatures, so the hash of
        // what we just built is the hash it will have on-chain. The indexer
        // uses it to tie the SubmissionCreated event back to this exact row.
        chain_tx_hash: Buffer.from(assembled.built!.hash()).toString("hex"),
        idempotency_key: body.idempotency_key,
      })
      .returningAll()
      .executeTakeFirstOrThrow();

    reply.code(201);
    return {
      submission: row,
      unsigned_transaction_xdr: unsignedXdr,
      network_passphrase: env.NETWORK_PASSPHRASE,
    };
  });

  // Build-sign-relay-confirm step 2: relay the agent-signed XDR to real
  // testnet and reconcile the row with the real on-chain result. The chain
  // indexer independently reconciles the same event, so this is an
  // optimistic fast-path for the caller's own response, not the sole writer.
  app.post("/v1/submissions/:id/relay", { preHandler: requireAuth }, async (req, reply) => {
    const params = z.object({ id: z.string().uuid() }).parse(req.params);
    const body = z.object({ signed_transaction_xdr: z.string().min(1) }).parse(req.body);
    const draft = await db.selectFrom("submission").selectAll().where("id", "=", params.id).executeTakeFirst();
    if (!draft) {
      reply.code(404);
      return { error: "not found" };
    }
    if (draft.agent_id !== req.stellarAccount) {
      reply.code(403);
      return { error: "only the submitting agent can relay this submission" };
    }
    if (draft.chain_submission_id) return { submission: draft, tx_hash: draft.chain_tx_hash };

    const { hash, returnValue } = await relaySignedXdr(body.signed_transaction_xdr);
    if (hash !== draft.chain_tx_hash) {
      reply.code(400);
      return { error: "signed transaction is not the one built for this submission" };
    }
    const chainSubmissionId = String(returnValue);
    const onChain = await readSubmission(chainSubmissionId);

    const row = await db
      .updateTable("submission")
      .set({
        chain_submission_id: chainSubmissionId,
        chain_tx_hash: hash,
        challenge_window_s: onChain ? Number(onChain.challenge_window_s) : 0,
        submitted_at: onChain ? new Date(Number(onChain.submitted_at) * 1000) : undefined,
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
