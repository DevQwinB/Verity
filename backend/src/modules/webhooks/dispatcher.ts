import { createHmac } from "node:crypto";
import { sql, type Kysely, type Transaction } from "kysely";
import type { Database } from "@verity/db";
import { db } from "../../db.js";
import { resolvePublicTarget } from "./url-guard.js";
import { postPinned } from "./post-pinned.js";

type DbHandle = Kysely<Database> | Transaction<Database>;

export function getUrlOrigin(rawUrl: string): string {
  try {
    const parsed = new URL(rawUrl);
    return parsed.origin;
  } catch {
    return "unknown";
  }
}

export function describeError(err: unknown): string {
  if (!err || typeof err !== "object") {
    return String(err);
  }

  const e = err as { message?: string; name?: string; cause?: unknown };
  const message = e.message || e.name || "unknown error";

  if (!e.cause) {
    return message;
  }

  const cause = e.cause as { code?: string; message?: string; errors?: unknown[] };
  if (Array.isArray(cause.errors) && cause.errors.length > 0) {
    const errorCodes = cause.errors
      .map((subErr) => {
        if (subErr && typeof subErr === "object") {
          const item = subErr as { code?: string; message?: string };
          return item.code || item.message;
        }
        return String(subErr);
      })
      .filter(Boolean);

    if (errorCodes.length > 0) {
      return `${message} (${errorCodes.join(", ")})`;
    }
  }

  const causeDetail = cause.code || cause.message;
  if (causeDetail) {
    return `${message} (${causeDetail})`;
  }

  return message;
}

export const DELIVERY_TIMEOUT_MS = 5_000;

/** Give up after this many attempts. With the backoff below the attempts
 * span roughly a day, so a receiver mid-deploy is retried but not forever. */
export const MAX_DELIVERY_ATTEMPTS = 8;

/** Exponential backoff: the n-th attempt waits BASE * 2^(n-1), capped. */
export const RETRY_BASE_DELAY_MS = 5 * 60_000;
export const RETRY_MAX_DELAY_MS = 6 * 60 * 60_000;

/** A crash can leave a row `pending`; it is retried once it is this old. */
export const PENDING_RETRY_AFTER_MS = 5 * 60_000;

/** Per-tick bounds so one scheduler tick cannot fire an unbounded number of
 * outbound POSTs, and overlapping ticks cannot double-send. */
export const RETRY_TICK_LIMIT = 25;
export const RETRY_TICK_CONCURRENCY = 5;

export interface WebhookSubscriptionRecord {
  id: string;
  marketplace_id: string;
  url: string;
  secret: string;
  events: string[];
  active: boolean;
}

export interface WebhookDeliveryRecord {
  id: string;
  subscription_id: string;
  event_type: string;
  payload: unknown;
  status: "pending" | "delivered" | "failed";
  attempts: number;
  last_attempt_at: Date | null;
  response_code: number | null;
  next_attempt_at: Date | null;
  created_at: Date;
}

/** Delay before the next attempt after `attemptsJustMade` attempts. */
export function backoffDelayMs(attemptsJustMade: number): number {
  const n = Math.max(1, Math.floor(attemptsJustMade));
  return Math.min(RETRY_BASE_DELAY_MS * 2 ** (n - 1), RETRY_MAX_DELAY_MS);
}

/** 5xx, 408, 429 and transport failures (null code) are worth retrying.
 * Other 4xx are a definitive no from the receiver, and redirects are never
 * followed, so a 3xx is also a no — retrying those forever would just hammer
 * a misconfigured endpoint. */
export function isRetryableResponse(code: number | null): boolean {
  if (code === null) return true;
  if (code === 408 || code === 429) return true;
  return code >= 500 && code < 600;
}

export interface RetryPlan {
  /** Whether another attempt should be scheduled. */
  retry: boolean;
  /** When the next attempt is due; null when no attempt is scheduled. */
  nextAttemptAt: Date | null;
  /** True when the delivery is finished for good (delivered, unretryable
   * response, or attempts exhausted). */
  terminal: boolean;
}

/** Decide what happens to a delivery after an attempt that made
 * `attempts` total and saw `responseCode` (null = transport error/timeout). */
export function planNextAttempt(opts: { attempts: number; responseCode: number | null; now?: Date }): RetryPlan {
  const now = opts.now ?? new Date();
  if (opts.attempts >= MAX_DELIVERY_ATTEMPTS) {
    return { retry: false, nextAttemptAt: null, terminal: true };
  }
  if (!isRetryableResponse(opts.responseCode)) {
    return { retry: false, nextAttemptAt: null, terminal: true };
  }
  return { retry: true, nextAttemptAt: new Date(now.getTime() + backoffDelayMs(opts.attempts)), terminal: false };
}

/** Inserts the delivery row. Split from the network attempt so the retry
 * pass can re-attempt the same row (same id, so receivers can deduplicate
 * on `x-verity-delivery`). */
export async function createDelivery(
  dbh: DbHandle,
  sub: WebhookSubscriptionRecord,
  eventType: string,
  payload: unknown
): Promise<WebhookDeliveryRecord | undefined> {
  try {
    return (await dbh
      .insertInto("webhook_delivery")
      .values({ subscription_id: sub.id, event_type: eventType, payload: payload as any })
      .returningAll()
      .executeTakeFirstOrThrow()) as WebhookDeliveryRecord;
  } catch (insertErr) {
    console.error(
      `[webhook] failed to create delivery record for subscription ${sub.id} (${eventType}) to ${getUrlOrigin(sub.url)}:`,
      insertErr
    );
    return undefined;
  }
}

/** One signed POST against the pinned, re-checked target, then the row is
 * updated with the outcome: attempts + 1, last_attempt_at, response_code,
 * and either `delivered` or `failed` with next_attempt_at from the backoff
 * plan (null when the attempt is terminal). Every attempt is re-signed with
 * a fresh timestamp. */
export async function attemptDelivery(
  dbh: DbHandle,
  sub: WebhookSubscriptionRecord,
  row: WebhookDeliveryRecord
): Promise<void> {
  const origin = getUrlOrigin(sub.url);
  const body = JSON.stringify({ event: row.event_type, data: row.payload });

  // Signed over timestamp, delivery id and body so a captured request cannot
  // be replayed later or under another delivery id. Fresh timestamp per
  // attempt: a retry must not reuse a stale signature.
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = createHmac("sha256", sub.secret)
    .update(`${timestamp}.${row.id}.${body}`)
    .digest("hex");

  try {
    // Re-checked at send time: the host may resolve somewhere else now than
    // it did when the subscription was created. The request then connects to
    // the address that was checked, so it cannot resolve elsewhere in between.
    // No redirects, for the same reason.
    const target = await resolvePublicTarget(sub.url);
    const res = await postPinned(target, {
      headers: {
        "content-type": "application/json",
        "x-verity-delivery": row.id,
        "x-verity-timestamp": timestamp,
        "x-verity-signature": signature,
      },
      body,
      timeoutMs: DELIVERY_TIMEOUT_MS,
    });

    const statusCode = res.status;
    const isOk = statusCode >= 200 && statusCode < 300;
    const attempts = row.attempts + 1;
    const plan = isOk
      ? { retry: false, nextAttemptAt: null as Date | null, terminal: true }
      : planNextAttempt({ attempts, responseCode: statusCode });

    await dbh
      .updateTable("webhook_delivery")
      .set({
        status: isOk ? "delivered" : "failed",
        attempts,
        last_attempt_at: new Date(),
        response_code: statusCode,
        next_attempt_at: plan.nextAttemptAt,
      })
      .where("id", "=", row.id)
      .execute();

    if (!isOk) {
      console.error(
        `[webhook] delivery ${row.id} (${row.event_type}) to ${origin} failed: ${statusCode}` +
          (plan.retry ? `, retrying at ${plan.nextAttemptAt!.toISOString()}` : ", giving up")
      );
    }
  } catch (err) {
    const attempts = row.attempts + 1;
    const plan = planNextAttempt({ attempts, responseCode: null });
    try {
      await dbh
        .updateTable("webhook_delivery")
        .set({
          status: "failed",
          attempts,
          last_attempt_at: new Date(),
          response_code: null,
          next_attempt_at: plan.nextAttemptAt,
        })
        .where("id", "=", row.id)
        .execute();
    } catch (dbErr) {
      console.error(`[webhook] failed to record failure for delivery ${row.id}:`, dbErr);
    }

    try {
      const reason = describeError(err);
      console.error(
        `[webhook] delivery ${row.id} (${row.event_type}) to ${origin} failed: ${reason}` +
          (plan.retry ? `, retrying at ${plan.nextAttemptAt!.toISOString()}` : ", giving up")
      );
    } catch (logErr) {
      console.error(`[webhook] delivery ${row.id} (${row.event_type}) to ${origin} failed: logging error`, logErr);
    }
  }
}

/**
 * Delivers a single webhook event to a subscription: creates the delivery
 * row, then makes the first attempt. Handles SSRF guard checking with the
 * checked address pinned for the request, an overall per-request timeout,
 * and database status tracking. Later attempts happen in retryWebhooksOnce.
 */
export async function deliver(
  sub: WebhookSubscriptionRecord,
  eventType: string,
  payload: unknown
): Promise<void> {
  const row = await createDelivery(db, sub, eventType, payload);
  if (!row) return;
  await attemptDelivery(db, sub, row);
}

/** Scheduler pass: attempts every delivery that is due — `failed` with
 * next_attempt_at <= now and attempts left, plus `pending` rows orphaned by
 * a crash once they are PENDING_RETRY_AFTER_MS old. Rows are locked with
 * `for update skip locked` inside one transaction, so an overlapping tick
 * (or a second worker) cannot double-send the same delivery. Subscriptions
 * that are no longer active are skipped and their rows parked. Per-tick
 * work is bounded by RETRY_TICK_LIMIT rows at RETRY_TICK_CONCURRENCY
 * concurrent POSTs. Returns how many deliveries were attempted. */
export async function retryWebhooksOnce(
  opts: { limit?: number; concurrency?: number; now?: Date; db?: DbHandle } = {}
): Promise<number> {
  const limit = opts.limit ?? RETRY_TICK_LIMIT;
  const concurrency = Math.max(1, opts.concurrency ?? RETRY_TICK_CONCURRENCY);
  const now = opts.now ?? new Date();
  const dbh = opts.db ?? db;

  return dbh.transaction().execute(async (trx) => {
    const due = (await trx
      .selectFrom("webhook_delivery")
      .selectAll()
      .where((eb) =>
        eb.or([
          eb.and([
            eb("status", "=", "failed"),
            eb("next_attempt_at", "is not", null),
            eb("next_attempt_at", "<=", now),
            eb("attempts", "<", MAX_DELIVERY_ATTEMPTS),
          ]),
          eb.and([
            eb("status", "=", "pending"),
            eb("attempts", "<", MAX_DELIVERY_ATTEMPTS),
            eb("created_at", "<=", new Date(now.getTime() - PENDING_RETRY_AFTER_MS)),
          ]),
        ])
      )
      .orderBy(sql`coalesce(next_attempt_at, created_at)`, "asc")
      .limit(limit)
      .forUpdate()
      .skipLocked()
      .execute()) as WebhookDeliveryRecord[];

    if (due.length === 0) return 0;

    const subIds = [...new Set(due.map((r) => r.subscription_id))];
    const subs = (await trx
      .selectFrom("webhook_subscription")
      .selectAll()
      .where("id", "in", subIds)
      .execute()) as WebhookSubscriptionRecord[];

    let attempted = 0;
    for (let i = 0; i < due.length; i += concurrency) {
      const chunk = due.slice(i, i + concurrency);
      await Promise.all(
        chunk.map(async (row) => {
          const sub = subs.find((s) => s.id === row.subscription_id);
          if (!sub || !sub.active) {
            // Deactivated (or gone) between event and retry: park the row so
            // no tick picks it up again, and do not send.
            await trx
              .updateTable("webhook_delivery")
              .set({ status: "failed", next_attempt_at: null, last_attempt_at: now })
              .where("id", "=", row.id)
              .execute();
            console.warn(
              `[webhook] skipping delivery ${row.id} (${row.event_type}): subscription ${row.subscription_id} is no longer active`
            );
            return;
          }
          await attemptDelivery(trx, sub, row);
          attempted++;
        })
      );
    }
    return attempted;
  });
}

/**
 * Dispatches webhook events for a marketplace without blocking caller loops.
 *
 * It awaits loading the active subscriptions for the marketplace, then kicks off
 * all matching deliveries concurrently in the background. Webhook deliveries run
 * with a short per-request timeout (5s) and release their connection bodies.
 *
 * If the process exits while deliveries are in flight, their rows stay `pending`;
 * the scheduler's retryWebhooksOnce pass picks those up again after a few minutes,
 * as it does failed deliveries on their backoff schedule.
 */
export async function dispatchWebhook(marketplaceId: string, eventType: string, payload: unknown): Promise<void> {
  const subs = await db
    .selectFrom("webhook_subscription")
    .selectAll()
    .where("marketplace_id", "=", marketplaceId)
    .where("active", "=", true)
    .execute();

  const matching = subs.filter((sub) => sub.events.includes(eventType));
  if (matching.length === 0) {
    return;
  }

  // Trigger deliveries concurrently without awaiting network completion
  void Promise.allSettled(
    matching.map((sub) =>
      deliver(sub, eventType, payload).catch((err) => {
        console.error(`[webhook] unhandled error delivering event ${eventType} to subscription ${sub.id}:`, err);
      })
    )
  );
}
