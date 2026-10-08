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
  /** Force a full replay quorum even for a retrieval task — used when a
   * spot-check mismatches or a challenge is opened, where a single sampled
   * vote can never reach on-chain consensus on its own. */
  fullQuorum?: boolean;
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

  if (params.taskType === "deterministic" || params.fullQuorum) {
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

/** Escalates a submission to a full replay quorum. Idempotent: re-executors
 * that already hold a replay row (assigned or attested) are left untouched. */
export async function escalateToFullReplay(submissionId: string) {
  const sub = await db
    .selectFrom("submission")
    .selectAll()
    .where("id", "=", submissionId)
    .executeTakeFirst();
  if (!sub?.chain_submission_id) return;
  await assignReplayJobs({
    submissionId: sub.id,
    chainSubmissionId: sub.chain_submission_id,
    taskType: sub.task_type,
    fullQuorum: true,
  });
}

/** PRD §5: a spot-check mismatch "flags every other unverified submission
 * from that agent for review" — here, review means a full replay quorum
 * instead of the sampled spot-check they would otherwise have received. */
export async function escalateAgentPendingSubmissions(agentId: string, exceptSubmissionId: string) {
  const others = await db
    .selectFrom("submission")
    .select(["id"])
    .where("agent_id", "=", agentId)
    .where("status", "=", "pending")
    .where("chain_submission_id", "is not", null)
    .where("id", "!=", exceptSubmissionId)
    .execute();
  for (const other of others) {
    await escalateToFullReplay(other.id);
  }
}
