import { createHmac } from "node:crypto";
import { db } from "../../db.js";
import { assertPublicHttpUrl } from "./url-guard.js";

function getOrigin(urlStr: string): string {
  try {
    return new URL(urlStr).origin;
  } catch {
    return "<invalid-url>";
  }
}

function describeError(err: unknown): string {
  if (err instanceof Error) {
    const parts: string[] = [err.message];
    const cause: any = err.cause;
    if (cause) {
      if (typeof cause.code === "string") {
        parts.push(cause.code);
      } else if (typeof cause.message === "string") {
        parts.push(cause.message);
      }
      if (Array.isArray(cause.errors)) {
        const codes = cause.errors
          .map((e: any) => e?.code ?? e?.message)
          .filter(Boolean);
        if (codes.length > 0) {
          parts.push(codes.join(", "));
        }
      }
    }
    if (err instanceof AggregateError && Array.isArray(err.errors)) {
      const codes = err.errors
        .map((e: any) => e?.code ?? e?.message)
        .filter(Boolean);
      if (codes.length > 0) {
        parts.push(codes.join(", "));
      }
    }
    return parts.join(": ");
  }
  return String(err);
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
    const origin = getOrigin(sub.url);
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
        console.error(`[webhook] delivery ${delivery.id} (${eventType}) to ${origin} failed: ${res.status}`);
      }
    } catch (err) {
      await db
        .updateTable("webhook_delivery")
        .set({ status: "failed", attempts: 1, last_attempt_at: new Date() })
        .where("id", "=", delivery.id)
        .execute();
      try {
        const reason = describeError(err);
        console.error(`[webhook] delivery ${delivery.id} (${eventType}) to ${origin} failed: ${reason}`);
      } catch {
        // do not let logging throw
      }
    }
  }
}
