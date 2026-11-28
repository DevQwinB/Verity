import { createHmac } from "node:crypto";
import { sql } from "kysely";
import { db } from "../../db.js";
import { resolvePublicTarget } from "./url-guard.js";
import { postPinned } from "./post-pinned.js";
import { backoffMs, MAX_DELIVERY_ATTEMPTS, shouldRetry } from "./retry-policy.js";

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

export interface WebhookSubscriptionRecord {
  id: string;
  marketplace_id: string;
  url: string;
  secret: string;
  events: string[];
  active: boolean;
}

/**
 * Creates a webhook delivery record without sending it.
 * Returns the delivery ID.
 */
export async function createDelivery(
  sub: WebhookSubscriptionRecord,
  eventType: string,
  payload: unknown
): Promise<string> {
  const delivery = await db
    .insertInto("webhook_delivery")
    .values({ subscription_id: sub.id, event_type: eventType, payload: payload as any })
    .returningAll()
    .executeTakeFirstOrThrow();
  return delivery.id;
}

/**
 * Attempts a single delivery of a webhook. The delivery row must already exist.
 * Returns true if the delivery was accepted (2xx), false if it should be retried,
 * and throws if the subscription is inactive (so it won't be retried).
 */
export async function attemptDelivery(
  deliveryId: string,
  sub: WebhookSubscriptionRecord,
  eventType: string,
  payload: unknown
): Promise<boolean> {
  // Re-check subscription is still active
  const currentSub = await db
    .selectFrom("webhook_subscription")
    .select(["id", "active"])
    .where("id", "=", sub.id)
    .executeTakeFirst();

  if (!currentSub || !currentSub.active) {
    throw new Error("subscription inactive");
  }

  const body = JSON.stringify({ event: eventType, data: payload });
  const origin = getUrlOrigin(sub.url);

  // Signed over timestamp, delivery id and body so a captured request cannot be
  // replayed later or under another delivery id.
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = createHmac("sha256", sub.secret)
    .update(`${timestamp}.${deliveryId}.${body}`)
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
        "x-verity-delivery": deliveryId,
        "x-verity-timestamp": timestamp,
        "x-verity-signature": signature,
      },
      body,
      timeoutMs: DELIVERY_TIMEOUT_MS,
    });

    const statusCode = res.status;
    const isOk = statusCode >= 200 && statusCode < 300;

    const nextAttempt = isOk ? 0 : (await getAttempts(deliveryId)) + 1;
    const nextAttemptAt = isOk || !shouldRetry(statusCode) || nextAttempt >= MAX_DELIVERY_ATTEMPTS
      ? null
      : new Date(Date.now() + backoffMs(nextAttempt));

    await db
      .updateTable("webhook_delivery")
      .set({
        status: isOk ? "delivered" : "failed",
        attempts: sql<number>`attempts + 1`,
        last_attempt_at: new Date(),
        response_code: statusCode,
        next_attempt_at: nextAttemptAt,
      })
      .where("id", "=", deliveryId)
      .execute();

    if (!isOk) {
      console.error(
        `[webhook] delivery ${deliveryId} (${eventType}) to ${origin} failed: ${statusCode}`
      );
    }
    return isOk;
  } catch (err) {
    try {
      const currentAttempts = await getAttempts(deliveryId);
      const nextAttempt = currentAttempts + 1;
      const nextAttemptAt = shouldRetry(null) && nextAttempt < MAX_DELIVERY_ATTEMPTS
        ? new Date(Date.now() + backoffMs(nextAttempt))
        : null;

      await db
        .updateTable("webhook_delivery")
        .set({
          status: "failed",
          attempts: nextAttempt,
          last_attempt_at: new Date(),
          next_attempt_at: nextAttemptAt,
        })
        .where("id", "=", deliveryId)
        .execute();
    } catch (dbErr) {
      console.error(`[webhook] failed to record failure for delivery ${deliveryId}:`, dbErr);
    }

    try {
      const reason = describeError(err);
      console.error(
        `[webhook] delivery ${deliveryId} (${eventType}) to ${origin} failed: ${reason}`
      );
    } catch (logErr) {
      console.error(`[webhook] delivery ${deliveryId} (${eventType}) to ${origin} failed: logging error`, logErr);
    }
    return false;
  }
}

async function getAttempts(deliveryId: string): Promise<number> {
  const row = await db
    .selectFrom("webhook_delivery")
    .select(["attempts"])
    .where("id", "=", deliveryId)
    .executeTakeFirst();
  return row?.attempts ?? 1;
}

/**
 * Delivers a single webhook event to a subscription.
 * Handles SSRF guard checking with the checked address pinned for the request,
 * an overall per-request timeout, and database status tracking.
 * This is the original single-attempt delivery; it now uses the retry infrastructure.
 */
export async function deliver(
  sub: WebhookSubscriptionRecord,
  eventType: string,
  payload: unknown
): Promise<void> {
  const deliveryId = await createDelivery(sub, eventType, payload);
  await attemptDelivery(deliveryId, sub, eventType, payload);
}

/**
 * Retries pending and failed webhook deliveries that are due.
 * Picks failed rows where next_attempt_at <= now, and pending rows older than
 * a lease cutoff (created_at < now - 5 minutes). Claims rows atomically by
 * setting a short lease (next_attempt_at = now + 60s) inside a transaction
 * with FOR UPDATE SKIP LOCKED, then attempts delivery outside the transaction.
 */
export async function retryWebhooksOnce(): Promise<number> {
  const now = new Date();
  const leaseMs = 60_000;
  const pendingCutoff = new Date(now.getTime() - 5 * 60 * 1000);

  // Claim due rows atomically: update next_attempt_at to a short lease timestamp
  // for rows that are due for retry, using FOR UPDATE SKIP LOCKED to avoid
  // overlapping ticks. Only pick:
  // - failed rows with next_attempt_at <= now
  // - pending rows created more than 5 minutes ago (orphaned)
  const claimed = await db.transaction().execute(async (trx) => {
    const rows = await trx
      .selectFrom("webhook_delivery")
      .innerJoin(
        "webhook_subscription",
        "webhook_subscription.id",
        "webhook_delivery.subscription_id"
      )
      .select([
        "webhook_delivery.id",
        "webhook_delivery.subscription_id",
        "webhook_delivery.event_type",
        "webhook_delivery.payload",
        "webhook_delivery.attempts",
        "webhook_subscription.url",
        "webhook_subscription.secret",
        "webhook_subscription.active",
        "webhook_subscription.events",
        "webhook_subscription.marketplace_id",
      ])
      .where("webhook_delivery.status", "in", ["pending", "failed"])
      .where((eb) =>
        eb.or([
          eb.and([
            eb("webhook_delivery.status", "=", "failed"),
            eb("webhook_delivery.next_attempt_at", "<=", now),
          ]),
          eb.and([
            eb("webhook_delivery.status", "=", "pending"),
            eb("webhook_delivery.created_at", "<", pendingCutoff),
          ]),
        ])
      )
      .where("webhook_subscription.active", "=", true)
      .where("webhook_delivery.attempts", "<", MAX_DELIVERY_ATTEMPTS)
      .forUpdate(["webhook_delivery"])
      .skipLocked()
      .limit(50)
      .execute();

    if (rows.length === 0) return [];

    const leaseUntil = new Date(Date.now() + leaseMs);
    await trx
      .updateTable("webhook_delivery")
      .set({ next_attempt_at: leaseUntil })
      .where(
        "id",
        "in",
        rows.map((r) => r.id)
      )
      .execute();

    return rows;
  });

  let retried = 0;
  for (const row of claimed) {
    try {
      const sub: WebhookSubscriptionRecord = {
        id: row.subscription_id,
        marketplace_id: row.marketplace_id,
        url: row.url,
        secret: row.secret,
        events: row.events,
        active: row.active,
      };
      await attemptDelivery(row.id, sub, row.event_type, row.payload);
      retried++;
    } catch (err) {
      if ((err as Error).message === "subscription inactive") {
        continue; // Don't retry inactive subscriptions
      }
      console.error(`[webhook] retry failed for delivery ${row.id}:`, err);
    }
  }
  return retried;
}

export interface DispatchWebhookDeps {
  db?: typeof db;
  deliver?: typeof deliver;
}

/**
 * Dispatches webhook events for a marketplace without blocking caller loops.
 *
 * It awaits loading the active subscriptions for the marketplace, then kicks off
 * all matching deliveries concurrently in the background. Webhook deliveries run
 * with a short per-request timeout (5s) and release their connection bodies.
 *
 * If the process exits while deliveries are in flight, their rows stay `pending`
 * and will be retried by the retry worker.
 */
export async function dispatchWebhook(
  marketplaceId: string,
  eventType: string,
  payload: unknown,
  deps: DispatchWebhookDeps = {}
): Promise<void> {
  const database = deps.db ?? db;
  const send = deps.deliver ?? deliver;
  const subs = await database
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
      send(sub, eventType, payload).catch((err) => {
        console.error(`[webhook] unhandled error delivering event ${eventType} to subscription ${sub.id}:`, err);
      })
    )
  );
}
