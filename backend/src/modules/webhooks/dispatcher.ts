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

export async function dispatchWebhook(marketplaceId: string, eventType: string, payload: unknown) {
  const subs = await db
    .selectFrom("webhook_subscription")
    .selectAll()
    .where("marketplace_id", "=", marketplaceId)
    .where("active", "=", true)
    .execute();

  for (const sub of subs) {
    if (!sub.events.includes(eventType)) continue;
    const body = JSON.stringify({ event: eventType, data: payload });
    const signature = createHmac("sha256", sub.secret).update(body).digest("hex");
    const delivery = await db
      .insertInto("webhook_delivery")
      .values({ subscription_id: sub.id, event_type: eventType, payload: payload as any })
      .returningAll()
      .executeTakeFirstOrThrow();
    const origin = getUrlOrigin(sub.url);
    try {
      // Re-checked at send time: the host may resolve somewhere else now than
      // it did when the subscription was created. No redirects, for the same reason.
      await assertPublicHttpUrl(sub.url);
      const res = await fetch(sub.url, {
        method: "POST",
        redirect: "error",
        headers: { "content-type": "application/json", "x-verity-signature": signature },
        body,
      });
      await db
        .updateTable("webhook_delivery")
        .set({
          status: res.ok ? "delivered" : "failed",
          attempts: 1,
          last_attempt_at: new Date(),
          response_code: res.status,
        })
        .where("id", "=", delivery.id)
        .execute();
      if (!res.ok) {
        console.error(
          `[webhook] delivery ${delivery.id} (${eventType}) to ${origin} failed: ${res.status}`
        );
      }
    } catch (err) {
      await db
        .updateTable("webhook_delivery")
        .set({ status: "failed", attempts: 1, last_attempt_at: new Date() })
        .where("id", "=", delivery.id)
        .execute();
      try {
        const reason = describeError(err);
        console.error(
          `[webhook] delivery ${delivery.id} (${eventType}) to ${origin} failed: ${reason}`
        );
      } catch (logErr) {
        console.error(`[webhook] delivery ${delivery.id} (${eventType}) to ${origin} failed: logging error`, logErr);
      }
    }
  }
}
