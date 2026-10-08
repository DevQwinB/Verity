import type { FastifyInstance } from "fastify";
import { sql } from "kysely";
import { z } from "zod";
import { db } from "../../db.js";

export async function reportsRoutes(app: FastifyInstance) {
  app.get("/v1/reports/verification-rates", async (req) => {
    const query = z.object({ marketplace_id: z.string().uuid().optional() }).parse(req.query);
    let qb = db
      .selectFrom("submission")
      .innerJoin("marketplace", "marketplace.id", "submission.marketplace_id")
      .select([
        "submission.marketplace_id",
        "marketplace.name as marketplace_name",
        "marketplace.stellar_account as marketplace_account",
        "submission.task_type",
        "submission.status",
        sql<string>`count(*)`.as("count"),
      ])
      // A draft whose submit() was never signed does not exist on-chain and
      // is not a submission; counting it would disagree with every list.
      .where("submission.chain_submission_id", "is not", null)
      .groupBy(["submission.marketplace_id", "marketplace.name", "marketplace.stellar_account", "submission.task_type", "submission.status"]);
    if (query.marketplace_id) {
      qb = qb.where("submission.marketplace_id", "=", query.marketplace_id);
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
