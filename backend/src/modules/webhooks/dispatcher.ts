import { createHmac } from "node:crypto";
import { db } from "../../db.js";
import { assertPublicHttpUrl } from "./url-guard.js";

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
 * Delivers a single webhook event to a subscription.
 * Handles SSRF guard checking, per-request timeout, response body cancellation,
 * and database status tracking with robust error handling.
 */
export async function deliver(
  sub: WebhookSubscriptionRecord,
  eventType: string,
  payload: unknown
): Promise<void> {
  const body = JSON.stringify({ event: eventType, data: payload });
  const signature = createHmac("sha256", sub.secret).update(body).digest("hex");
  const origin = getUrlOrigin(sub.url);

  let deliveryId: string | undefined;
  try {
    const delivery = await db
      .insertInto("webhook_delivery")
      .values({ subscription_id: sub.id, event_type: eventType, payload: payload as any })
      .returningAll()
      .executeTakeFirstOrThrow();
    deliveryId = delivery.id;
  } catch (insertErr) {
    console.error(
      `[webhook] failed to create delivery record for subscription ${sub.id} (${eventType}) to ${origin}:`,
      insertErr
    );
    return;
  }

  try {
    // Re-checked at send time: the host may resolve somewhere else now than
    // it did when the subscription was created. No redirects, for the same reason.
    await assertPublicHttpUrl(sub.url);
    const res = await fetch(sub.url, {
      method: "POST",
      redirect: "error",
      headers: { "content-type": "application/json", "x-verity-signature": signature },
      body,
      signal: AbortSignal.timeout(DELIVERY_TIMEOUT_MS),
    });

    const isOk = res.ok;
    const statusCode = res.status;

    // Release connection immediately so it doesn't leak or wait on GC
    await res.body?.cancel().catch(() => {});

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
 * Dispatches webhook events for a marketplace without blocking caller loops.
 *
 * It awaits loading the active subscriptions for the marketplace, then kicks off
 * all matching deliveries concurrently in the background. Webhook deliveries run
 * with a short per-request timeout (5s) and release their connection bodies.
 *
 * If the process exits while deliveries are in flight, their rows stay `pending`
 * (webhooks are delivered once with no retry).
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
