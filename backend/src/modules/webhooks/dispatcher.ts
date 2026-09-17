import { createHmac } from "node:crypto";
import { db } from "../../db.js";

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
    try {
      const res = await fetch(sub.url, {
        method: "POST",
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
    } catch {
      await db
        .updateTable("webhook_delivery")
        .set({ status: "failed", attempts: 1, last_attempt_at: new Date() })
        .where("id", "=", delivery.id)
        .execute();
    }
  }
}
