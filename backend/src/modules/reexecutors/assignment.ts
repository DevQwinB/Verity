import { createHash } from "node:crypto";
import { db } from "../../db.js";
import { escrowGateAsKeeper } from "../../chain/clients.js";

/**
 * Deterministic, auditable re-executor selection: rank active re-executors
 * by sha256(seed + account) and take the top N, where N is the live
 * on-chain quorum_min_reexecutors. The seed is recorded on each replay row
 * so anyone can reproduce the exact selection later.
 *
 * Simplification vs. the full plan: ranking is uniform over active,
 * sufficiently-staked accounts rather than stake-weighted (e.g. sqrt(stake)
 * probability). Real and deterministic, just not weighted yet — documented
 * here rather than silently different from the design.
 */
export async function assignReplayJobs(params: {
  submissionId: string;
  chainSubmissionId: string;
  taskType: "deterministic" | "retrieval" | "unverifiable";
}) {
  if (params.taskType === "unverifiable") return;

  const cfgTx = await escrowGateAsKeeper.get_config();
  const cfg = cfgTx.result;
  const quorum = cfg ? Number(cfg.quorum_min_reexecutors) : 3;

  const active = await db
    .selectFrom("reexecutor")
    .selectAll()
    .where("active", "=", true)
    .execute();
  if (active.length === 0) return;

  const seed = createHash("sha256")
    .update(`${params.submissionId}|${params.chainSubmissionId}`)
    .digest("hex");

  const ranked = active
    .map((r) => ({
      r,
      rank: createHash("sha256").update(`${seed}|${r.stellar_account}`).digest("hex"),
    }))
    .sort((a, b) => (a.rank < b.rank ? -1 : a.rank > b.rank ? 1 : 0))
    .slice(0, Math.min(quorum, active.length));

  if (params.taskType === "deterministic") {
    for (const { r } of ranked) {
      await db
        .insertInto("replay")
        .values({ submission_id: params.submissionId, reexecutor_id: r.id, assignment_seed: seed })
        .onConflict((oc) => oc.columns(["submission_id", "reexecutor_id"]).doNothing())
        .execute();
    }
  } else {
    // Retrieval tasks: statistical spot-check on a random subset (10-20%),
    // not full replay by every quorum member.
    const sampleSize = Math.max(1, Math.round(ranked.length * 0.2));
    for (const { r } of ranked.slice(0, sampleSize)) {
      await db
        .insertInto("spot_check")
        .values({ submission_id: params.submissionId, reexecutor_id: r.id })
        .onConflict((oc) => oc.columns(["submission_id", "reexecutor_id"]).doNothing())
        .execute();
    }
  }
}
