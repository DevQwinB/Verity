import { sql } from "kysely";
import { db } from "../db.js";
import { escrowGateAsKeeper } from "../chain/clients.js";
import { fromChainVerdict } from "../chain/mappers.js";

/** Sweeps submissions whose challenge window has elapsed with no open
 * challenge, and calls the real, keeper-signed finalize() on each. A
 * finalize_attempted_at guard avoids duplicate tx spam across sweep ticks;
 * finalize() itself is idempotent on-chain regardless (invariant 3). */
export async function sweepOnce(): Promise<number> {
  const due = await db
    .selectFrom("submission")
    .selectAll()
    .where("status", "=", "pending")
    .where("chain_submission_id", "is not", null)
    .where("finalize_attempted_at", "is", null)
    .where(sql<boolean>`submitted_at + (challenge_window_s || ' seconds')::interval <= now()`)
    .execute();

  for (const sub of due) {
    await db
      .updateTable("submission")
      .set({ finalize_attempted_at: new Date() })
      .where("id", "=", sub.id)
      .execute();
    try {
      const tx = await escrowGateAsKeeper.finalize({ submission_id: BigInt(sub.chain_submission_id!) });
      const sent = await tx.signAndSend();
      const verdict = sent.result.unwrap();
      await db
        .updateTable("submission")
        .set({
          status: fromChainVerdict(verdict) as any,
          chain_tx_hash: sent.sendTransactionResponse?.hash ?? undefined,
          updated_at: new Date(),
        })
        .where("id", "=", sub.id)
        .execute();
    } catch (err) {
      console.error(`[scheduler] finalize failed for submission ${sub.id}:`, err);
    }
  }
  return due.length;
}

export function startScheduler(intervalMs = 15000): { stop: () => void } {
  let stopped = false;
  let timer: NodeJS.Timeout | undefined;
  const tick = async () => {
    if (stopped) return;
    try {
      await sweepOnce();
    } catch (err) {
      console.error("[scheduler] sweep failed:", err);
    }
    if (!stopped) timer = setTimeout(tick, intervalMs);
  };
  timer = setTimeout(tick, intervalMs);
  return { stop: () => { stopped = true; if (timer) clearTimeout(timer); } };
}
