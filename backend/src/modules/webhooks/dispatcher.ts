import { createHmac } from "node:crypto";
import type { Kysely, Transaction, Selectable } from "kysely";
import type { Database, WebhookDeliveryTable } from "@verity/db";
import { db } from "../../db.js";
import { resolvePublicTarget } from "./url-guard.js";
import { postPinned } from "./post-pinned.js";

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

export interface EnqueuedWebhook {
  delivery: Selectable<WebhookDeliveryTable>;
  subscription: WebhookSubscriptionRecord;
}

/**
 * Enqueues pending webhook_delivery rows in the provided database transaction.
 * Resolves active subscriptions matching the event type and inserts pending delivery records.
 */
export async function enqueueWebhook(
  trx: Kysely<Database> | Transaction<Database>,
  marketplaceId: string,
  eventType: string,
  payload: unknown
): Promise<EnqueuedWebhook[]> {
  const subs = await trx
    .selectFrom("webhook_subscription")
    .selectAll()
    .where("marketplace_id", "=", marketplaceId)
    .where("active", "=", true)
    .execute();

  const matching = subs.filter((sub) => sub.events.includes(eventType));
  if (matching.length === 0) {
    return [];
  }

  const results: EnqueuedWebhook[] = [];
  for (const sub of matching) {
    const delivery = await trx
      .insertInto("webhook_delivery")
      .values({
        subscription_id: sub.id,
        event_type: eventType,
        payload: payload as any,
        status: "pending",
      })
      .returningAll()
      .executeTakeFirstOrThrow();
    results.push({ delivery, subscription: sub });
  }
  return results;
}

/**
 * Attempts delivery for an already-enqueued webhook_delivery record.
 * Handles SSRF guard checking with the checked address pinned for the request,
 * an overall per-request timeout, and database status tracking.
 */
export async function attemptDelivery(
  delivery: Selectable<WebhookDeliveryTable>,
  subscription?: WebhookSubscriptionRecord
): Promise<void> {
  let sub = subscription;
  if (!sub) {
    const found = await db
      .selectFrom("webhook_subscription")
      .selectAll()
      .where("id", "=", delivery.subscription_id)
      .executeTakeFirst();
    if (!found) {
      console.error(`[webhook] subscription ${delivery.subscription_id} not found for delivery ${delivery.id}`);
      return;
    }
    sub = found;
  }

  const eventType = delivery.event_type;
  const payload = delivery.payload;
  const body = JSON.stringify({ event: eventType, data: payload });
  const origin = getUrlOrigin(sub.url);
  const deliveryId = delivery.id;

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

    await db
      .updateTable("webhook_delivery")
      .set({
        status: isOk ? "delivered" : "failed",
        attempts: 1,
        last_attempt_at: new Date(),
        response_code: statusCode,
      })
      .where("id", "=", deliveryId)
      .execute();

    if (!isOk) {
      console.error(
        `[webhook] delivery ${deliveryId} (${eventType}) to ${origin} failed: ${statusCode}`
      );
    }
  } catch (err) {
    try {
      await db
        .updateTable("webhook_delivery")
        .set({ status: "failed", attempts: 1, last_attempt_at: new Date() })
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
  }
}

/**
 * Delivers a single webhook event to a subscription.
 * Used for direct delivery or backward compatibility.
 */
export async function deliver(
  sub: WebhookSubscriptionRecord,
  eventType: string,
  payload: unknown
): Promise<void> {
  let delivery: Selectable<WebhookDeliveryTable>;
  try {
    delivery = await db
      .insertInto("webhook_delivery")
      .values({ subscription_id: sub.id, event_type: eventType, payload: payload as any, status: "pending" })
      .returningAll()
      .executeTakeFirstOrThrow();
  } catch (insertErr) {
    const origin = getUrlOrigin(sub.url);
    console.error(
      `[webhook] failed to create delivery record for subscription ${sub.id} (${eventType}) to ${origin}:`,
      insertErr
    );
    return;
  }

  await attemptDelivery(delivery, sub);
}

/**
 * Dispatches webhook events for a marketplace without blocking caller loops.
 *
 * Enqueues delivery rows transactionally, then kicks off all deliveries concurrently
 * in the background. Webhook deliveries run with a short per-request timeout (5s)
 * and release their connection bodies.
 */
export async function dispatchWebhook(marketplaceId: string, eventType: string, payload: unknown): Promise<void> {
  const enqueued = await db.transaction().execute((trx) => enqueueWebhook(trx, marketplaceId, eventType, payload));
  if (enqueued.length === 0) {
    return;
  }

  // Trigger deliveries concurrently without awaiting network completion
  void Promise.allSettled(
    enqueued.map((item) =>
      attemptDelivery(item.delivery, item.subscription).catch((err) => {
        console.error(`[webhook] unhandled error delivering event ${eventType} to subscription ${item.subscription.id}:`, err);
      })
    )
  );
}
