import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireAuth } from "../../auth/plugin.js";
import { db } from "../../db.js";

export async function marketplacesRoutes(app: FastifyInstance) {
  app.post("/v1/marketplaces", { preHandler: requireAuth }, async (req, reply) => {
    const body = z.object({ name: z.string().min(1) }).parse(req.body);
    const account = req.stellarAccount!;
    const existing = await db
      .selectFrom("marketplace")
      .selectAll()
      .where("stellar_account", "=", account)
      .executeTakeFirst();
    if (existing) return existing;
    const row = await db
      .insertInto("marketplace")
      .values({ stellar_account: account, name: body.name })
      .returningAll()
      .executeTakeFirstOrThrow();
    reply.code(201);
    return row;
  });

  app.post("/v1/marketplaces/:id/webhooks", { preHandler: requireAuth }, async (req, reply) => {
    const params = z.object({ id: z.string().uuid() }).parse(req.params);
    const body = z
      .object({ url: z.string().url(), secret: z.string().min(8), events: z.array(z.string()).min(1) })
      .parse(req.body);
    const row = await db
      .insertInto("webhook_subscription")
      .values({
        marketplace_id: params.id,
        url: body.url,
        secret: body.secret,
        events: body.events,
      })
      .returningAll()
      .executeTakeFirstOrThrow();
    reply.code(201);
    return row;
  });
}

export async function findOrCreateMarketplaceForAccount(account: string) {
  const existing = await db
    .selectFrom("marketplace")
    .selectAll()
    .where("stellar_account", "=", account)
    .executeTakeFirst();
  if (existing) return existing;
  return db
    .insertInto("marketplace")
    .values({ stellar_account: account, name: account })
    .returningAll()
    .executeTakeFirstOrThrow();
}
