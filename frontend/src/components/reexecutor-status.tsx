import { Badge } from "./ui/badge";
import type { Reexecutor } from "../lib/types";

/** Whether this re-executor can cast a counting vote right now, and if not,
 * the one thing standing in the way. Every word is derived from real state:
 * on-chain stake and approval, and the worker's own last poll. */
export function reexecutorStanding(r: Reexecutor, allowlist: boolean): {
  label: string;
  tone: "verified" | "pending" | "expired";
  note: string;
} {
  if (!r.active) {
    return { label: "Below stake floor", tone: "expired", note: "Stake is under the contract's minimum, so it is not assigned work." };
  }
  if (allowlist && !r.approved) {
    return { label: "Pending approval", tone: "pending", note: "Staked. Waiting for the deployment admin to approve it as a voter." };
  }
  if (!r.online) {
    return { label: "Offline", tone: "expired", note: "Able to vote, but no worker has polled for work recently, so it is not assigned any." };
  }
  return { label: "Online", tone: "verified", note: "Staked, able to vote, and its worker is polling for work." };
}

export function ReexecutorStatus({ reexecutor, allowlist }: { reexecutor: Reexecutor; allowlist: boolean }) {
  const s = reexecutorStanding(reexecutor, allowlist);
  return <Badge tone={s.tone}>{s.label}</Badge>;
}
