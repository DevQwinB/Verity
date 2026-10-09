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
          "A retrieval task against a declared public URL. Verified by one sampled re-executor re-fetching it and comparing the extracted result; a mismatch escalates the submission, and the agent's other pending submissions, to a full replay quorum.",
      },
      {
        type: "unverifiable",
        verification_method: "manual_review",
        description:
          "Open-ended, subjective, or creative tasks with no consistent scoring rubric. Not accepted for submission in Phase 1: the contract has no way to verify them.",
      },
    ],
  }));
}
