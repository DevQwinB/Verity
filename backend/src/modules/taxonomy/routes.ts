import type { FastifyInstance } from "fastify";

/** PRD §3/§5: v1 covers deterministic-replayable and statistically
 * spot-checkable retrieval tasks only. Open-ended/subjective tasks are
 * explicitly out of scope until a consistent scoring rubric exists. */
export async function taxonomyRoutes(app: FastifyInstance) {
  app.get("/v1/taxonomy", async () => ({
    version: 1,
    task_types: [
      {
        type: "deterministic",
        verification_method: "replay",
        description:
          "A pure function over content-addressed inputs (data transform, formatted API call, deterministic computation). Verified by re-executing the same declared function against the same input in a sandboxed runner and comparing output hashes.",
      },
      {
        type: "retrieval",
        verification_method: "statistical_spot_check",
        description:
          "A scraping/retrieval task against a declared, egress-locked endpoint. Verified by re-issuing a random 10-20% sample of requests and comparing extracted results.",
      },
      {
        type: "unverifiable",
        verification_method: "manual_review",
        description:
          "Open-ended, subjective, or creative tasks with no consistent scoring rubric. Not auto-verified on-chain in Phase 1 — routed for record-keeping only.",
      },
    ],
  }));
}
