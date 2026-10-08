import { sql } from "kysely";
import { db } from "../db.js";
import { env } from "../config/env.js";
import { escrowGateAsKeeper } from "../chain/clients.js";
import {
  consensusOutcome,
  finalizeOnChain,
  readSubmission,
  releaseAttestationLockOnChain,
  resolveChallengeOnChain,
  slashOnChain,
} from "../chain/actions.js";
import { fromChainVerdict } from "../chain/mappers.js";
import { recordTerminalVerdict } from "../modules/submissions/verdict.js";
import { maybeEarlyFinalize } from "./indexer.js";

/** How long settlement waits for the indexer to catch up on a submission's
 * votes before settling with the ones it has. */
const SETTLE_GRACE_S = 600;

/** A finalize() that came back Pending (or failed) is retried after this
 * long, rather than on every tick or never again. */
const FINALIZE_RETRY_S = 60;

/** Sweeps submissions whose challenge window has elapsed with no open
 * challenge, and calls the real, keeper-signed finalize() on each.
 * finalize_attempted_at throttles retries across sweep ticks; finalize()
 * itself is idempotent on-chain regardless (invariant 3). */
export async function sweepOnce(): Promise<number> {
  const due = await db
    .selectFrom("submission")
    .selectAll()
    .where("status", "=", "pending")
    .where("chain_submission_id", "is not", null)
    .where(sql<boolean>`submitted_at + (challenge_window_s || ' seconds')::interval <= now()`)
    .where((eb) =>
      eb.or([
        eb("finalize_attempted_at", "is", null),
        eb("finalize_attempted_at", "<", sql<Date>`now() - (${FINALIZE_RETRY_S} || ' seconds')::interval`),
      ])
    )
    .execute();

  for (const sub of due) {
    await db
      .updateTable("submission")
      .set({ finalize_attempted_at: new Date() })
      .where("id", "=", sub.id)
      .execute();
    try {
      const { status, txHash } = await finalizeOnChain(sub.chain_submission_id!);
      await recordTerminalVerdict(sub.id, status, txHash);
    } catch (err) {
      console.error(`[scheduler] finalize failed for submission ${sub.id}:`, err);
    }
  }
  return due.length;
}

/** Invariant 1's fast path: a pending submission that already has votes may
 * have reached a bonded supermajority. The indexer tries this the moment a
 * vote arrives; this pass is the retry for when that attempt failed or lost
 * a race, so a submission never waits out its whole window needlessly. */
export async function earlyFinalizeOnce(): Promise<number> {
  const candidates = await db
    .selectFrom("submission")
    .select(["submission.id", "submission.chain_submission_id"])
    .where("submission.status", "=", "pending")
    .where("submission.chain_submission_id", "is not", null)
    .where((eb) =>
      eb.exists(
        eb
          .selectFrom("replay")
          .select("replay.id")
          .whereRef("replay.submission_id", "=", "submission.id")
          .where("replay.status", "=", "confirmed_onchain")
      )
    )
    .execute();
  for (const row of candidates) {
    try {
      await maybeEarlyFinalize(row.id, row.chain_submission_id!);
    } catch (err) {
      console.error(`[scheduler] early finalize failed for submission ${row.id}:`, err);
    }
  }
  return candidates.length;
}

/** resolve_challenge is permissionless and only succeeds once the bonded
 * re-execution tally has reached consensus, so the keeper just watches open
 * challenges and submits it the moment the on-chain tally allows. The
 * contract then finalizes and settles in the same transaction. */
export async function resolveChallengesOnce(): Promise<number> {
  const open = await db
    .selectFrom("challenge")
    .innerJoin("submission", "submission.id", "challenge.submission_id")
    .select(["submission.id", "submission.chain_submission_id"])
    .where("challenge.resolved_at", "is", null)
    .where("submission.status", "=", "disputed")
    .where("submission.chain_submission_id", "is not", null)
    .execute();

  let resolved = 0;
  for (const row of open) {
    try {
      const record = await readSubmission(row.chain_submission_id!);
      if (!record || record.finalized || !consensusOutcome(record)) continue;
      const { status, txHash } = await resolveChallengeOnChain(row.chain_submission_id!);
      await recordTerminalVerdict(row.id, status, txHash);
      resolved++;
    } catch (err) {
      console.error(`[scheduler] resolve_challenge failed for submission ${row.id}:`, err);
    }
  }
  return resolved;
}

/** A challenge re-executors never reached consensus on must not freeze the
 * agent's and challenger's bonds forever: one full challenge window after it
 * was opened, finalize() expires it (ExpiredUnverified) and returns both
 * bonds. Until then — or while a consensus exists — finalize() is a no-op. */
export async function expireChallengesOnce(): Promise<number> {
  const stale = await db
    .selectFrom("challenge")
    .innerJoin("submission", "submission.id", "challenge.submission_id")
    .select(["submission.id", "submission.chain_submission_id"])
    .where("challenge.resolved_at", "is", null)
    .where("submission.status", "=", "disputed")
    .where("submission.chain_submission_id", "is not", null)
    .where(sql<boolean>`challenge.opened_at + (submission.challenge_window_s || ' seconds')::interval <= now()`)
    .where((eb) =>
      eb.or([
        eb("submission.finalize_attempted_at", "is", null),
        eb("submission.finalize_attempted_at", "<", sql<Date>`now() - (${FINALIZE_RETRY_S} || ' seconds')::interval`),
      ])
    )
    .execute();

  for (const row of stale) {
    await db.updateTable("submission").set({ finalize_attempted_at: new Date() }).where("id", "=", row.id).execute();
    try {
      const { status, txHash } = await finalizeOnChain(row.chain_submission_id!);
      await recordTerminalVerdict(row.id, status, txHash);
    } catch (err) {
      console.error(`[scheduler] challenge expiry failed for submission ${row.id}:`, err);
    }
  }
  return stale.length;
}

/** After a terminal verdict: slash every re-executor whose recorded vote the
 * verdict proved wrong (invariant 2 — the contract itself checks the vote),
 * and release every attester's stake lock so honest re-executors are free to
 * withdraw. settled_at is only stamped once every step has succeeded, so a
 * partial failure is simply retried on the next tick. */
export async function settleOnce(): Promise<number> {
  const unsettled = await db
    .selectFrom("submission")
    .selectAll()
    .where("status", "in", ["verified", "slashed", "expired_unverified"])
    .where("chain_submission_id", "is not", null)
    .where("settled_at", "is", null)
    .execute();

  let settled = 0;
  for (const sub of unsettled) {
    try {
      const votes = await db
        .selectFrom("replay")
        .innerJoin("reexecutor", "reexecutor.id", "replay.reexecutor_id")
        .select([
          "replay.id",
          "replay.match",
          "replay.slash_tx_hash",
          "replay.lock_released_at",
          "reexecutor.stellar_account",
        ])
        .where("replay.submission_id", "=", sub.id)
        .where("replay.status", "=", "confirmed_onchain")
        .execute();

      // Wait until the indexer has recorded every on-chain vote, or a late
      // one would be left with its stake lock never released.
      // Vote events can be lost for good (RPC retention, a skipped event), so
      // after a grace period settle the votes we do know about rather than
      // leaving every one of them locked.
      const record = await readSubmission(sub.chain_submission_id!);
      if (!record) continue;
      const onChainVotes = record.match_votes + record.mismatch_votes;
      if (votes.length < onChainVotes) {
        const waitedS = (Date.now() - new Date(sub.updated_at).getTime()) / 1000;
        if (waitedS < SETTLE_GRACE_S) continue;
        console.warn(
          `[scheduler] settling submission ${sub.id} with ${votes.length}/${onChainVotes} votes indexed; the rest can be released by anyone via release_attestation_lock()`
        );
      }

      // Only a verified/slashed verdict proves a vote wrong; an expired
      // challenge proves nothing, so nobody is slashable for it.
      const slashable = sub.status !== "expired_unverified";
      const wrongVote = sub.status === "slashed"; // voted "matched" on a slashed submission
      for (const vote of votes) {
        if (slashable && vote.match === wrongVote && !vote.slash_tx_hash && env.REEXECUTOR_SLASH_BPS > 0) {
          const info = await escrowGateAsKeeper.reexecutor_info({ reexecutor: vote.stellar_account });
          const stake = info.result?.stake_amount ?? 0n;
          const amount = (stake * BigInt(env.REEXECUTOR_SLASH_BPS)) / 10000n;
          const hash = amount > 0n ? await slashOnChain(sub.chain_submission_id!, vote.stellar_account, amount) : null;
          await db
            .updateTable("replay")
            .set({ slash_tx_hash: hash ?? "already-slashed" })
            .where("id", "=", vote.id)
            .execute();
        }
        if (!vote.lock_released_at) {
          await releaseAttestationLockOnChain(sub.chain_submission_id!, vote.stellar_account);
          await db
            .updateTable("replay")
            .set({ lock_released_at: new Date() })
            .where("id", "=", vote.id)
            .execute();
        }
      }

      // Assignments nobody completed can no longer be attested (the
      // contract rejects votes on a finalized submission) — drop them so
      // re-executor agents stop being handed dead work.
      await db
        .deleteFrom("replay")
        .where("submission_id", "=", sub.id)
        .where("status", "=", "assigned")
        .execute();

      await db
        .updateTable("submission")
        .set({ settled_at: new Date(), updated_at: new Date() })
        .where("id", "=", sub.id)
        .execute();
      settled++;
    } catch (err) {
      console.error(`[scheduler] settlement failed for submission ${sub.id}:`, err);
    }
  }
  return settled;
}

/** The chain is the source of truth and events can be missed (RPC event
 * retention is ~7 days; anyone may call finalize()/resolve_challenge()
 * directly). Re-read every still-open submission and adopt any terminal
 * verdict the contract already holds. */
export async function reconcileOnce(): Promise<number> {
  const open = await db
    .selectFrom("submission")
    .select(["id", "chain_submission_id", "status"])
    .where("status", "in", ["pending", "disputed"])
    .where("chain_submission_id", "is not", null)
    .execute();

  let changed = 0;
  for (const row of open) {
    try {
      const record = await readSubmission(row.chain_submission_id!);
      if (!record?.finalized) continue;
      const status = fromChainVerdict(record.verdict);
      if (status === row.status) continue;
      await recordTerminalVerdict(row.id, status);
      changed++;
    } catch (err) {
      console.error(`[scheduler] reconcile failed for submission ${row.id}:`, err);
    }
  }
  return changed;
}

export function startScheduler(intervalMs = 10000): { stop: () => void } {
  let stopped = false;
  let timer: NodeJS.Timeout | undefined;
  const step = async (name: string, fn: () => Promise<number>) => {
    try {
      await fn();
    } catch (err) {
      console.error(`[scheduler] ${name} failed:`, err);
    }
  };
  const tick = async () => {
    if (stopped) return;
    await step("reconcile", reconcileOnce);
    await step("early-finalize", earlyFinalizeOnce);
    await step("sweep", sweepOnce);
    await step("resolve-challenges", resolveChallengesOnce);
    await step("expire-challenges", expireChallengesOnce);
    await step("settle", settleOnce);
    if (!stopped) timer = setTimeout(tick, intervalMs);
  };
  timer = setTimeout(tick, intervalMs);
  return { stop: () => { stopped = true; if (timer) clearTimeout(timer); } };
}
