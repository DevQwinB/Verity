import type { FastifyInstance } from "fastify";
import { sql } from "kysely";
import { db } from "../../db.js";

export async function reportsRoutes(app: FastifyInstance) {
  app.get("/v1/reports/verification-rates", async (req) => {
    const query = req.query as { marketplace_id?: string };
    let qb = db
      .selectFrom("submission")
      .select(["marketplace_id", "task_type", "status", sql<string>`count(*)`.as("count")])
      .groupBy(["marketplace_id", "task_type", "status"]);
    if (query.marketplace_id) {
      qb = qb.where("marketplace_id", "=", query.marketplace_id);
    }
    const rows = await qb.execute();

    const slashCount = await db
      .selectFrom("slashing_event")
      .select(sql<string>`count(*)`.as("count"))
      .executeTakeFirst();

    return {
      by_marketplace_task_status: rows,
      slashing_events_total: Number(slashCount?.count ?? 0),
      // The PRD's false-accept-rate metric depends on a manual audit sample
      // against real-world ground truth — it is not something this system
      // can compute on its own, so it is reported here as null rather than
      // fabricated, pending a manual audit workflow.
      false_accept_rate: null,
    };
  });
}
