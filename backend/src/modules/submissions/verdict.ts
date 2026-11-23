import type { SubmissionStatus } from "@verity/db";
import { db as defaultDb } from "../../db.js";
import { readSubmission as defaultReadSubmission } from "../../chain/actions.js";
import { fromChainResolutionMethod } from "../../chain/mappers.js";
import {
  attemptDelivery as defaultAttemptDelivery,
  enqueueWebhook as defaultEnqueueWebhook,
  type EnqueuedWebhook,
} from "../webhooks/dispatcher.js";

const TERMINAL: SubmissionStatus[] = ["verified", "slashed", "expired_unverified"];

export interface VerdictDeps {
  db?: typeof defaultDb;
  enqueueWebhook?: typeof defaultEnqueueWebhook;
  attemptDelivery?: typeof defaultAttemptDelivery;
  readSubmission?: typeof defaultReadSubmission;
}

/** Single writer for "this submission reached a terminal on-chain verdict".
 * Called from every place a verdict can first be observed (the Finalized
 * event, the keeper's own finalize/resolve calls, the chain reconcile pass)
 * and safe to call repeatedly: the webhook fires only on the call that
 * actually moves the row into its terminal status.
 *
 * Transactional outbox: the status transition and creation of its
 * webhook_delivery rows commit together in a single transaction.
 * Delivery attempts happen after commit.
 *
 * How the verdict was reached is read back from the contract, never assumed —
 * a window that elapsed without consensus must not be recorded as consensus.
 * The chain read is kept outside the transaction so no connection is held across RPC. */
export async function recordTerminalVerdict(
  submissionRowId: string,
  status: string,
  txHash?: string | null,
  deps: VerdictDeps = {}
) {
  if (!TERMINAL.includes(status as SubmissionStatus)) return;
  const terminal = status as SubmissionStatus;

  const db = deps.db ?? defaultDb;
  const enqueueWebhook = deps.enqueueWebhook ?? defaultEnqueueWebhook;
  const attemptDelivery = deps.attemptDelivery ?? defaultAttemptDelivery;
  const readSubmission = deps.readSubmission ?? defaultReadSubmission;

  const { transitioned, sub, enqueued } = await db.transaction().execute(async (trx) => {
    const transitioned = await trx
      .updateTable("submission")
      .set({ status: terminal, updated_at: new Date() })
      .where("id", "=", submissionRowId)
      .where("status", "!=", terminal)
      .returningAll()
      .executeTakeFirst();

    const sub =
      transitioned ??
      (await trx.selectFrom("submission").selectAll().where("id", "=", submissionRowId).executeTakeFirst());
    if (!sub) return { transitioned: undefined, sub: undefined, enqueued: [] };

    let enqueued: EnqueuedWebhook[] = [];
    if (transitioned && (terminal === "verified" || terminal === "slashed")) {
      enqueued = await enqueueWebhook(trx, sub.marketplace_id, `submission.${terminal}`, {
        submission_id: sub.id,
        status: terminal,
        tx_hash: txHash ?? null,
      });
    }

    if (terminal === "expired_unverified") {
      // A challenge that lapsed without a resolution is closed out off-chain too.
      await trx
        .updateTable("challenge")
        .set({ resolved_at: new Date() })
        .where("submission_id", "=", sub.id)
        .where("resolved_at", "is", null)
        .execute();
    }

    return { transitioned, sub, enqueued };
  });

  if (!sub) return;

  // Dispatched after transaction commits: delivery attempts are fire-and-forget
  for (const item of enqueued) {
    void attemptDelivery(item.delivery, item.subscription).catch((err) =>
      console.error("[verdict] webhook delivery attempt failed:", err)
    );
  }

  // Filled in whenever they are still missing, so a call that knows the
  // finalize transaction can complete a row first written by one that did not.
  // Note: readSubmission is kept OUTSIDE the transaction so no DB connection
  // is held across an RPC call.
  if (!sub.resolution_method || (txHash && !sub.finalize_tx_hash)) {
    const record = sub.chain_submission_id ? await readSubmission(sub.chain_submission_id) : null;
    await db
      .updateTable("submission")
      .set({
        resolution_method: sub.resolution_method ?? (record ? fromChainResolutionMethod(record.resolution_method) : null),
        finalize_tx_hash: sub.finalize_tx_hash ?? txHash ?? null,
      })
      .where("id", "=", sub.id)
      .execute();
  }
}
