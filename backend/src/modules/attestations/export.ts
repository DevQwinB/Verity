import { db } from "../../db.js";
import { keeperKeypair } from "../../chain/keeper.js";

/**
 * Stellar 8004's real ingestion schema is not published (PRD §16 open
 * question 3) — this is a versioned, swappable payload we control, signed
 * with Verity's own key, stored regardless of delivery outcome. Delivery
 * itself is a NullPublisher: persist + expose via the DB/API, never a
 * fabricated "successfully pushed to 8004" claim, since no real 8004
 * attestor registration exists yet for this deployment.
 */
export async function exportAttestation(submissionId: string) {
  const submission = await db
    .selectFrom("submission")
    .selectAll()
    .where("id", "=", submissionId)
    .executeTakeFirstOrThrow();
  if (submission.status !== "verified" && submission.status !== "slashed") return;

  const replays = await db
    .selectFrom("replay")
    .select(["id"])
    .where("submission_id", "=", submissionId)
    .where("status", "=", "confirmed_onchain")
    .execute();

  const payload = {
    schema: "verity.attestation.v1",
    attestor: { type: "verity-verification-layer", stellar_account: keeperKeypair.publicKey() },
    subject: {
      agent_stellar_account: submission.agent_id,
      escrow_ref: submission.escrow_ref,
      submission_id: submission.id,
    },
    claim: {
      task_type: submission.task_type,
      verdict: submission.status,
      resolution_method: "reexecution_consensus",
      evidence_refs: replays.map((r) => `replay:${r.id}`),
    },
    issued_at: new Date().toISOString(),
    tx_hash: submission.chain_tx_hash,
  };

  const canonical = JSON.stringify(payload);
  const signature = Buffer.from(keeperKeypair.sign(Buffer.from(canonical))).toString("base64");

  await db
    .insertInto("attestation_export")
    .values({
      submission_id: submissionId,
      target_registry: "stellar-8004",
      payload,
      signature,
    })
    .execute();
}
