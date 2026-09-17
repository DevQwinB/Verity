import { scValToNative } from "@stellar/stellar-sdk";
import { db } from "../db.js";
import { server } from "../chain/rpc.js";
import { env } from "../config/env.js";
import { fromChainVerdict } from "../chain/mappers.js";
import { assignReplayJobs } from "../modules/reexecutors/assignment.js";
import { escrowGateAsKeeper } from "../chain/clients.js";
import { exportAttestation } from "../modules/attestations/export.js";
import { dispatchWebhook } from "../modules/webhooks/dispatcher.js";

const CONTRACT_ID = env.ESCROW_GATE_CONTRACT_ID;

async function getCursor(): Promise<number> {
  const row = await db
    .selectFrom("chain_cursor")
    .selectAll()
    .where("contract_id", "=", CONTRACT_ID)
    .executeTakeFirst();
  if (row) return Number(row.last_ledger);
  const latest = await server.getLatestLedger();
  const start = Math.max(latest.sequence - 100, 1);
  await db
    .insertInto("chain_cursor")
    .values({ contract_id: CONTRACT_ID, last_ledger: start })
    .onConflict((oc) => oc.column("contract_id").doNothing())
    .execute();
  const settled = await db
    .selectFrom("chain_cursor")
    .selectAll()
    .where("contract_id", "=", CONTRACT_ID)
    .executeTakeFirstOrThrow();
  return Number(settled.last_ledger);
}

async function setCursor(ledger: number, pagingToken: string | null) {
  await db
    .updateTable("chain_cursor")
    .set({ last_ledger: ledger, last_paging_token: pagingToken, updated_at: new Date() })
    .where("contract_id", "=", CONTRACT_ID)
    .execute();
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
        // Submitted directly on-chain, bypassing our /v1/submissions build step.
        row = await db
          .selectFrom("submission")
          .selectAll()
          .where("agent_id", "=", v.agent)
          .where("chain_submission_id", "is", null)
          .orderBy("submitted_at", "desc")
          .executeTakeFirst();
      }
      if (row) {
        const onChain = await escrowGateAsKeeper.get_submission({ id: BigInt(chainSubmissionId) });
        const sub = onChain.result;
        await db
          .updateTable("submission")
          .set({
            chain_submission_id: chainSubmissionId,
            chain_tx_hash: txHash,
            challenge_window_s: sub ? Number(sub.challenge_window_s) : row.challenge_window_s,
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
        await maybeEarlyFinalize(sub.id, chainSubmissionId);
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
          .onConflict((oc) => oc.column("submission_id").where("resolved_at", "is", null).doNothing())
          .execute();
        await db.updateTable("submission").set({ status: "disputed" }).where("id", "=", sub.id).execute();
      }
      break;
    }

    case "challenge_resolved": {
      const chainSubmissionId = String(topic[1]);
      const v = value as { resolution: { tag: string }; method: { tag: string } };
      const sub = await db
        .selectFrom("submission")
        .selectAll()
        .where("chain_submission_id", "=", chainSubmissionId)
        .executeTakeFirst();
      if (sub) {
        await db
          .updateTable("challenge")
          .set({
            resolution: v.resolution.tag === "Upheld" ? "upheld" : "rejected",
            resolution_method:
              v.method.tag === "ZkProof" ? "zk_proof" : "reexecution_consensus",
            resolved_at: new Date(),
          })
          .where("submission_id", "=", sub.id)
          .execute();
      }
      break;
    }

    case "finalized": {
      const chainSubmissionId = String(topic[1]);
      const v = value as { verdict: { tag: string } };
      const status = fromChainVerdict(v.verdict);
      const sub = await db
        .updateTable("submission")
        .set({ status: status as any, updated_at: new Date() })
        .where("chain_submission_id", "=", chainSubmissionId)
        .returningAll()
        .executeTakeFirst();
      if (sub && (status === "verified" || status === "slashed")) {
        await exportAttestation(sub.id).catch((err) => console.error("[indexer] attestation export failed:", err));
        await dispatchWebhook(sub.marketplace_id, `submission.${status}`, { submission_id: sub.id, status }).catch(
          (err) => console.error("[indexer] webhook dispatch failed:", err)
        );
      }
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
          .execute();
        await db
          .updateTable("reexecutor")
          .set({ slashed_count: rex.slashed_count + 1 })
          .where("id", "=", rex.id)
          .execute();
      }
      break;
    }
  }
}

/** Mirrors invariant 1 off-chain: as soon as a fresh replay tally implies a
 * bonded supermajority, proactively call the real keeper-signed finalize()
 * rather than waiting for the challenge window to elapse. */
async function maybeEarlyFinalize(submissionRowId: string, chainSubmissionId: string) {
  const sub = await db
    .selectFrom("submission")
    .selectAll()
    .where("id", "=", submissionRowId)
    .executeTakeFirst();
  if (!sub || sub.status !== "pending") return;
  const onChain = await escrowGateAsKeeper.get_submission({ id: BigInt(chainSubmissionId) });
  const record = onChain.result;
  if (!record) return;
  const cfg = record;
  const totalVotes = record.match_votes + record.mismatch_votes;
  if (totalVotes < cfg.cfg_quorum_min_reexecutors) return;
  const totalWeight = record.bonded_weight_matched + record.bonded_weight_mismatched;
  if (totalWeight <= 0n) return;
  const matchRatioBps = (record.bonded_weight_matched * 10000n) / totalWeight;
  const mismatchRatioBps = (record.bonded_weight_mismatched * 10000n) / totalWeight;
  const threshold = BigInt(cfg.cfg_quorum_supermajority_bps);
  if (matchRatioBps < threshold && mismatchRatioBps < threshold) return;

  const tx = await escrowGateAsKeeper.finalize({ submission_id: BigInt(chainSubmissionId) });
  const sent = await tx.signAndSend();
  const verdict = sent.result.unwrap();
  await db
    .updateTable("submission")
    .set({
      status: fromChainVerdict(verdict) as any,
      chain_tx_hash: sent.sendTransactionResponse?.hash ?? undefined,
      updated_at: new Date(),
    })
    .where("id", "=", submissionRowId)
    .execute();
}

export async function pollOnce(): Promise<number> {
  const startLedger = await getCursor();
  const res = await server.getEvents({
    filters: [{ type: "contract", contractIds: [CONTRACT_ID] }],
    startLedger,
    limit: 100,
  });
  let maxSeenEventLedger = startLedger - 1;
  for (const ev of res.events) {
    const topic = ev.topic.map((t) => scValToNative(t));
    const value = scValToNative(ev.value);
    await handleEvent(topic, value, ev.ledger, ev.txHash);
    if (ev.ledger > maxSeenEventLedger) maxSeenEventLedger = ev.ledger;
  }
  // Next startLedger must never exceed the RPC's current latestLedger, or
  // the following poll is rejected outright — clamp rather than blindly +1.
  const nextCursor = Math.min(maxSeenEventLedger + 1, res.latestLedger ?? maxSeenEventLedger + 1);
  await setCursor(nextCursor, null);
  return res.events.length;
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
