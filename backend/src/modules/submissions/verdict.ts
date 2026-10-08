import { db } from "../../db.js";
import { exportAttestation } from "../attestations/export.js";
import { dispatchWebhook } from "../webhooks/dispatcher.js";

/** Single writer for "this submission reached a terminal on-chain verdict".
 * Called from every place a verdict can first be observed (the Finalized
 * event, the keeper's own finalize/resolve calls, the chain reconcile pass)
 * and safe to call repeatedly: the attestation export is insert-once, and
 * the webhook only fires alongside that first insert. */
export async function recordTerminalVerdict(submissionRowId: string, status: string, txHash?: string | null) {
  if (status === "pending" || status === "disputed") return;
  const sub = await db
    .updateTable("submission")
    .set({ status: status as any, updated_at: new Date() })
    .where("id", "=", submissionRowId)
    .returningAll()
    .executeTakeFirst();
  if (!sub) return;
  if (status === "expired_unverified") {
    // The challenge lapsed without a resolution; close it out off-chain too.
    await db
      .updateTable("challenge")
      .set({ resolved_at: new Date() })
      .where("submission_id", "=", sub.id)
      .where("resolved_at", "is", null)
      .execute();
    return;
  }
  if (status !== "verified" && status !== "slashed") return;

  const firstTime = await exportAttestation(sub.id).catch((err) => {
    console.error("[verdict] attestation export failed:", err);
    return false;
  });
  if (firstTime) {
    await dispatchWebhook(sub.marketplace_id, `submission.${status}`, {
      submission_id: sub.id,
      status,
      tx_hash: txHash ?? null,
    }).catch((err) => console.error("[verdict] webhook dispatch failed:", err));
  }
}
