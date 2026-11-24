import type { SubmissionResolutionMethod, SubmissionStatus } from "@verity/db";
import { db } from "../../db.js";
import { readSubmission } from "../../chain/actions.js";
import { fromChainResolutionMethod } from "../../chain/mappers.js";
import { dispatchWebhook } from "../webhooks/dispatcher.js";

const TERMINAL: SubmissionStatus[] = ["verified", "slashed", "expired_unverified"];

export interface VerdictWebhookPayload {
  submission_id: string;
  chain_submission_id: string | null;
  escrow_ref: string;
  status: "verified" | "slashed";
  resolution_method: SubmissionResolutionMethod | null;
  tx_hash: string | null;
}

export function buildVerdictWebhookPayload(
  sub: {
    id: string;
    chain_submission_id: string | null;
    escrow_ref: string;
    resolution_method: SubmissionResolutionMethod | null;
  },
  status: "verified" | "slashed",
  txHash?: string | null
): VerdictWebhookPayload {
  return {
    submission_id: sub.id,
    chain_submission_id: sub.chain_submission_id,
    escrow_ref: sub.escrow_ref,
    status,
    resolution_method: sub.resolution_method,
    tx_hash: txHash ?? null,
  };
}

/** Single writer for "this submission reached a terminal on-chain verdict".
 * Called from every place a verdict can first be observed (the Finalized
 * event, the keeper's own finalize/resolve calls, the chain reconcile pass)
 * and safe to call repeatedly: the webhook fires only on the call that
 * actually moves the row into its terminal status.
 *
 * How the verdict was reached is read back from the contract, never assumed —
 * a window that elapsed without consensus must not be recorded as consensus.
 * The resolution_method is read before transitioning so that the terminal
 * status and resolution_method are written in the same atomic update, and
 * the webhook payload includes resolution_method. If the chain read fails,
 * it throws before transitioning so the caller's retry path handles it. */
export async function recordTerminalVerdict(submissionRowId: string, status: string, txHash?: string | null) {
  if (!TERMINAL.includes(status as SubmissionStatus)) return;
  const terminal = status as SubmissionStatus;

  const sub = await db
    .selectFrom("submission")
    .selectAll()
    .where("id", "=", submissionRowId)
    .executeTakeFirst();
  if (!sub) return;

  let resolutionMethod = sub.resolution_method;
  if (!resolutionMethod && sub.chain_submission_id) {
    const record = await readSubmission(sub.chain_submission_id);
    if (record) {
      resolutionMethod = fromChainResolutionMethod(record.resolution_method);
    }
  }

  const finalizeTxHash = sub.finalize_tx_hash ?? txHash ?? null;

  const transitioned = await db
    .updateTable("submission")
    .set({
      status: terminal,
      resolution_method: resolutionMethod,
      finalize_tx_hash: finalizeTxHash,
      updated_at: new Date(),
    })
    .where("id", "=", submissionRowId)
    .where("status", "!=", terminal)
    .returningAll()
    .executeTakeFirst();

  if (!transitioned && (!sub.resolution_method || (!sub.finalize_tx_hash && finalizeTxHash))) {
    await db
      .updateTable("submission")
      .set({
        resolution_method: sub.resolution_method ?? resolutionMethod,
        finalize_tx_hash: sub.finalize_tx_hash ?? finalizeTxHash,
      })
      .where("id", "=", sub.id)
      .execute();
  }

  const currentSub = transitioned ?? {
    ...sub,
    resolution_method: sub.resolution_method ?? resolutionMethod,
    finalize_tx_hash: sub.finalize_tx_hash ?? finalizeTxHash,
  };

  if (transitioned && (terminal === "verified" || terminal === "slashed")) {
    const payload = buildVerdictWebhookPayload(currentSub, terminal, txHash);
    await dispatchWebhook(currentSub.marketplace_id, `submission.${terminal}`, payload)
      .catch((err) => console.error("[verdict] webhook dispatch failed:", err));
  }

  if (terminal === "expired_unverified") {
    // A challenge that lapsed without a resolution is closed out off-chain too.
    await db
      .updateTable("challenge")
      .set({ resolved_at: new Date() })
      .where("submission_id", "=", sub.id)
      .where("resolved_at", "is", null)
      .execute();
  }
}
