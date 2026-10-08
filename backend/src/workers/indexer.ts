import { scValToNative } from "@stellar/stellar-sdk";
import { db } from "../db.js";
import { server } from "../chain/rpc.js";
import { env } from "../config/env.js";
import { fromChainVerdict, fromChainResolution, fromChainResolutionMethod } from "../chain/mappers.js";
import {
  assignReplayJobs,
  escalateAgentPendingSubmissions,
  escalateToFullReplay,
} from "../modules/reexecutors/assignment.js";
import { escrowGateAsKeeper } from "../chain/clients.js";
import { consensusOutcome, finalizeOnChain, readSubmission } from "../chain/actions.js";
import { dispatchWebhook } from "../modules/webhooks/dispatcher.js";
import { recordTerminalVerdict } from "../modules/submissions/verdict.js";

const CONTRACT_ID = env.ESCROW_GATE_CONTRACT_ID;

const PAGE_SIZE = 100;

interface Cursor {
  /** RPC paging cursor from the previous getEvents response; null on the
   * very first poll (or after a retention reset), when startLedger is used. */
  pagingToken: string | null;
  ledger: number;
}

async function getCursor(): Promise<Cursor> {
  const row = await db
    .selectFrom("chain_cursor")
    .selectAll()
    .where("contract_id", "=", CONTRACT_ID)
    .executeTakeFirst();
  if (row) return { pagingToken: row.last_paging_token, ledger: Number(row.last_ledger) };
  const latest = await server.getLatestLedger();
  const start = Math.max(latest.sequence - 100, 1);
  await db
    .insertInto("chain_cursor")
    .values({ contract_id: CONTRACT_ID, last_ledger: start })
    .onConflict((oc) => oc.column("contract_id").doNothing())
    .execute();
  return { pagingToken: null, ledger: start };
}

async function setCursor(ledger: number, pagingToken: string | null) {
  await db
    .updateTable("chain_cursor")
    .set({ last_ledger: ledger, last_paging_token: pagingToken, updated_at: new Date() })
    .where("contract_id", "=", CONTRACT_ID)
    .execute();
}

/** An RPC paging cursor is "<toid>-<index>", where the TOID's high 32 bits
 * are the ledger sequence. */
function ledgerOfPagingToken(token: string): number {
  return Number(BigInt(token.split("-")[0]) >> 32n);
}

/** Idempotent by construction: every handler upserts on a unique key derived
 * from on-chain identity (chain_submission_id, (submission,reexecutor) pair,
 * etc.), so replaying the same event twice (e.g. after a restart) is safe. */
async function handleEvent(topic: unknown[], value: unknown, ledger: number, txHash: string) {
  const kind = topic[0] as string;

  switch (kind) {
    case "submission_created": {
      const chainSubmissionId = String(topic[1]);
      const v = value as { agent: string; escrow_ref: Buffer; escrow_value: bigint; bond: bigint };
      let row = await db
        .selectFrom("submission")
        .selectAll()
        .where("chain_submission_id", "=", chainSubmissionId)
        .executeTakeFirst();
      if (!row) {
        // POST /v1/submissions records the hash of the transaction it built
        // (a tx hash does not depend on its signatures), so the draft row
        // this event belongs to is identified exactly. A submit() made
        // directly on-chain with no draft has no off-chain artifacts to
        // replay and is intentionally not tracked here.
        row = await db
          .selectFrom("submission")
          .selectAll()
          .where("chain_tx_hash", "=", txHash)
          .where("chain_submission_id", "is", null)
          .executeTakeFirst();
      }
      if (row) {
        const sub = await readSubmission(chainSubmissionId);
        await db
          .updateTable("submission")
          .set({
            chain_submission_id: chainSubmissionId,
            chain_tx_hash: txHash,
            challenge_window_s: sub ? Number(sub.challenge_window_s) : row.challenge_window_s,
            // The challenge window runs on ledger time, not on when our row
            // was first drafted — align so the countdown and sweep are exact.
            submitted_at: sub ? new Date(Number(sub.submitted_at) * 1000) : undefined,
            updated_at: new Date(),
          })
          .where("id", "=", row.id)
          .execute();
        await assignReplayJobs({
          submissionId: row.id,
          chainSubmissionId,
          taskType: row.task_type,
        });
      }
      break;
    }

    case "reexecutor_registered": {
      const account = topic[1] as string;
      const v = value as { active: boolean; stake_amount: bigint };
      const existing = await db
        .selectFrom("reexecutor")
        .selectAll()
        .where("stellar_account", "=", account)
        .executeTakeFirst();
      if (existing) {
        await db
          .updateTable("reexecutor")
          .set({ active: v.active, stake_amount: v.stake_amount.toString(), last_seen_at: new Date() })
          .where("id", "=", existing.id)
          .execute();
      } else {
        await db
          .insertInto("reexecutor")
          .values({
            stellar_account: account,
            stake_amount: v.stake_amount.toString(),
            stake_asset: "native",
            active: v.active,
          })
          .execute();
      }
      break;
    }

    case "replay_attested": {
      const chainSubmissionId = String(topic[1]);
      const v = value as { reexecutor: string; output_hash: Buffer; matched: boolean };
      const sub = await db
        .selectFrom("submission")
        .selectAll()
        .where("chain_submission_id", "=", chainSubmissionId)
        .executeTakeFirst();
      const rex = await db
        .selectFrom("reexecutor")
        .selectAll()
        .where("stellar_account", "=", v.reexecutor)
        .executeTakeFirst();
      if (sub && rex) {
        const existing = await db
          .selectFrom("replay")
          .selectAll()
          .where("submission_id", "=", sub.id)
          .where("reexecutor_id", "=", rex.id)
          .executeTakeFirst();
        const patch = {
          status: "confirmed_onchain" as const,
          replay_output_hash: v.output_hash.toString("hex"),
          match: v.matched,
          tx_hash: txHash,
          executed_at: new Date(),
        };
        if (existing) {
          await db.updateTable("replay").set(patch).where("id", "=", existing.id).execute();
        } else {
          await db
            .insertInto("replay")
            .values({ submission_id: sub.id, reexecutor_id: rex.id, ...patch })
            .execute();
        }
        // If this re-executor was the sampled spot-checker, their on-chain
        // vote IS the spot-check result — recorded from the chain event, not
        // from a self-reported API call.
        const spotCheck = await db
          .updateTable("spot_check")
          .set({
            result: v.matched ? "match" : "mismatch",
            evidence: JSON.stringify({ replay_output_hash: patch.replay_output_hash, tx_hash: txHash, ledger }),
          })
          .where("submission_id", "=", sub.id)
          .where("reexecutor_id", "=", rex.id)
          .where("result", "is", null)
          .returningAll()
          .executeTakeFirst();
        if (spotCheck && !v.matched) {
          await escalateToFullReplay(sub.id);
          await escalateAgentPendingSubmissions(sub.agent_id, sub.id);
        }
        // Opportunistic: the vote above is already recorded, and the
        // scheduler retries early finalization on its own, so a failure
        // here must never cost us the event.
        await maybeEarlyFinalize(sub.id, chainSubmissionId).catch((err) =>
          console.error(`[indexer] early finalize of submission #${chainSubmissionId} failed, scheduler will retry:`, err)
        );
      }
      break;
    }

    case "challenge_opened": {
      const chainSubmissionId = String(topic[1]);
      const v = value as { challenger: string; bond: bigint };
      const sub = await db
        .selectFrom("submission")
        .selectAll()
        .where("chain_submission_id", "=", chainSubmissionId)
        .executeTakeFirst();
      if (sub) {
        await db
          .insertInto("challenge")
          .values({
            submission_id: sub.id,
            challenger_account: v.challenger,
            challenger_bond: v.bond.toString(),
            chain_tx_hash: txHash,
          })
          .onConflict((oc) => oc.doNothing())
          .returningAll()
          .executeTakeFirst()
          .then(async (inserted) => {
            if (!inserted) return;
            await dispatchWebhook(sub.marketplace_id, "submission.disputed", {
              submission_id: sub.id,
              status: "disputed",
              tx_hash: txHash,
            }).catch((err) => console.error("[indexer] webhook dispatch failed:", err));
          });
        await db
          .updateTable("submission")
          .set({ status: "disputed", updated_at: new Date() })
          .where("id", "=", sub.id)
          .where("status", "=", "pending")
          .execute();
        // A challenge is only ever resolved by bonded re-execution consensus,
        // so make sure a full quorum is actually working on it.
        await escalateToFullReplay(sub.id);
      }
      break;
    }

    case "challenge_resolved": {
      const chainSubmissionId = String(topic[1]);
      const v = value as { resolution: unknown; method: unknown };
      const sub = await db
        .selectFrom("submission")
        .selectAll()
        .where("chain_submission_id", "=", chainSubmissionId)
        .executeTakeFirst();
      if (sub) {
        await db
          .updateTable("challenge")
          .set({
            resolution: fromChainResolution(v.resolution),
            resolution_method: fromChainResolutionMethod(v.method),
            resolved_at: new Date(),
          })
          .where("submission_id", "=", sub.id)
          .where("resolved_at", "is", null)
          .execute();
      }
      break;
    }

    case "finalized": {
      const chainSubmissionId = String(topic[1]);
      const v = value as { verdict: unknown };
      const sub = await db
        .selectFrom("submission")
        .select(["id"])
        .where("chain_submission_id", "=", chainSubmissionId)
        .executeTakeFirst();
      if (sub) await recordTerminalVerdict(sub.id, fromChainVerdict(v.verdict), txHash);
      break;
    }

    case "slashed": {
      const chainSubmissionId = String(topic[1]);
      const v = value as { reexecutor: string; amount: bigint };
      const sub = await db
        .selectFrom("submission")
        .selectAll()
        .where("chain_submission_id", "=", chainSubmissionId)
        .executeTakeFirst();
      const rex = await db
        .selectFrom("reexecutor")
        .selectAll()
        .where("stellar_account", "=", v.reexecutor)
        .executeTakeFirst();
      if (rex) {
        await db
          .insertInto("slashing_event")
          .values({
            reexecutor_id: rex.id,
            submission_id: sub?.id ?? null,
            amount: v.amount.toString(),
            reason: "provable replay/challenge mismatch",
            tx_hash: txHash,
          })
          .onConflict((oc) => oc.doNothing())
          .returningAll()
          .executeTakeFirst()
          .then(async (inserted) => {
            if (!inserted) return; // event already recorded on an earlier pass
            const info = await escrowGateAsKeeper.reexecutor_info({ reexecutor: v.reexecutor });
            await db
              .updateTable("reexecutor")
              .set({
                slashed_count: rex.slashed_count + 1,
                stake_amount: info.result ? info.result.stake_amount.toString() : rex.stake_amount,
                active: info.result?.active ?? rex.active,
              })
              .where("id", "=", rex.id)
              .execute();
          });
      }
      break;
    }
  }
}

/** Mirrors invariant 1 off-chain: as soon as a fresh replay tally implies a
 * bonded supermajority, proactively call the real keeper-signed finalize()
 * rather than waiting for the challenge window to elapse. A disputed
 * submission is skipped here — the scheduler resolves its challenge instead. */
export async function maybeEarlyFinalize(submissionRowId: string, chainSubmissionId: string) {
  const sub = await db
    .selectFrom("submission")
    .selectAll()
    .where("id", "=", submissionRowId)
    .executeTakeFirst();
  if (!sub || sub.status !== "pending") return;
  const record = await readSubmission(chainSubmissionId);
  if (!record || record.finalized || !consensusOutcome(record)) return;

  const { status, txHash } = await finalizeOnChain(chainSubmissionId);
  await recordTerminalVerdict(submissionRowId, status, txHash);
}

/** Consecutive failures on the same event, so one permanently unprocessable
 * event cannot wedge the indexer forever (transient RPC/DB errors retry). */
let stuckEvent: { id: string; failures: number } | null = null;
const MAX_EVENT_RETRIES = 5;

export async function pollOnce(): Promise<number> {
  const cursor = await getCursor();
  const filters = [{ type: "contract" as const, contractIds: [CONTRACT_ID] }];

  let res;
  try {
    res = await server.getEvents(
      cursor.pagingToken
        ? { filters, cursor: cursor.pagingToken, limit: PAGE_SIZE }
        : { filters, startLedger: cursor.ledger, limit: PAGE_SIZE }
    );
  } catch (err) {
    // The RPC only retains ~7 days of events. A cursor older than that (the
    // backend was down for a while) is rejected outright on every poll, so
    // restart from the oldest retained ledger; the scheduler's on-chain
    // reconcile pass repairs any verdicts whose events were missed.
    const health = await server.getHealth();
    if (cursor.ledger < health.oldestLedger || cursor.ledger > health.latestLedger) {
      const restart = Math.min(Math.max(cursor.ledger, health.oldestLedger + 10), health.latestLedger);
      console.warn(`[indexer] cursor ledger ${cursor.ledger} outside RPC retention, restarting from ${restart}`);
      await setCursor(restart, null);
      return 0;
    }
    throw err;
  }

  let processed = 0;
  for (const ev of res.events) {
    const topic = ev.topic.map((t) => scValToNative(t));
    const value = scValToNative(ev.value);
    try {
      await handleEvent(topic, value, ev.ledger, ev.txHash);
      stuckEvent = null;
    } catch (err) {
      const failures = stuckEvent?.id === ev.id ? stuckEvent.failures + 1 : 1;
      stuckEvent = { id: ev.id, failures };
      if (failures < MAX_EVENT_RETRIES) throw err;
      console.error(`[indexer] skipping event ${ev.id} (${String(topic[0])}) after ${failures} failures:`, err);
      stuckEvent = null;
    }
    // Persist per event: a failure mid-page resumes after the last success.
    await setCursor(ev.ledger, ev.id);
    processed++;
  }

  // Empty/short pages still return a cursor marking how far the RPC scanned.
  if (res.cursor && res.events.length < PAGE_SIZE) {
    await setCursor(ledgerOfPagingToken(res.cursor), res.cursor);
  }
  return processed;
}

/** Self-rescheduling, never overlapping: a slow poll (e.g. one that submits
 * a finalize tx and waits ~3-5s for confirmation) must fully finish before
 * the next tick starts, or two ticks can both observe the same unprocessed
 * event and race to finalize the same submission concurrently. */
export function startIndexer(intervalMs = 4000): { stop: () => void } {
  let stopped = false;
  let timer: NodeJS.Timeout | undefined;
  const tick = async () => {
    if (stopped) return;
    try {
      await pollOnce();
    } catch (err) {
      console.error("[indexer] poll failed:", err);
    }
    if (!stopped) timer = setTimeout(tick, intervalMs);
  };
  timer = setTimeout(tick, 0);
  return { stop: () => { stopped = true; if (timer) clearTimeout(timer); } };
}
