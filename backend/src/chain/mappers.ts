import { createHash } from "node:crypto";
import type { TaskType as ChainTaskType, ResolutionMethod as ChainResolutionMethod } from "escrow-gate";
import type { TaskType } from "@verity/db";

export function toChainTaskType(t: TaskType): ChainTaskType {
  if (t === "deterministic") return { tag: "Deterministic", values: void 0 };
  if (t === "retrieval") return { tag: "Retrieval", values: void 0 };
  return { tag: "Unverifiable", values: void 0 };
}

export function toChainResolutionMethod(
  m: "reexecution_consensus" | "zk_proof"
): ChainResolutionMethod {
  return m === "zk_proof"
    ? { tag: "ZkProof", values: void 0 }
    : { tag: "ReexecutionConsensus", values: void 0 };
}

/** A fieldless #[contracttype] enum variant decodes differently depending on
 * the path: the generated Client's typed `.result`/`.unwrap()` gives
 * `{tag: "Verified", values: void}`, but the SDK's generic `scValToNative`
 * (used when decoding raw event values in the indexer) gives `["Verified"]`
 * — a bare array wrapping the variant name, no `.tag` at all. Handling only
 * the `{tag}` shape here silently fell through to the "pending" default for
 * every event-derived verdict, which is exactly the bug that reverted a
 * submission from "verified" back to "pending" after the indexer observed
 * its own Finalized event. This accepts either shape. */
function enumTag(v: unknown): string | undefined {
  if (Array.isArray(v)) return v[0] as string;
  if (v && typeof v === "object" && "tag" in v) return (v as { tag: string }).tag;
  if (typeof v === "string") return v;
  return undefined;
}

export function fromChainVerdict(v: unknown): string {
  switch (enumTag(v)) {
    case "Verified":
      return "verified";
    case "Disputed":
      return "disputed";
    case "Slashed":
      return "slashed";
    case "ExpiredUnverified":
      return "expired_unverified";
    default:
      return "pending";
  }
}

export function fromChainResolution(v: unknown): "upheld" | "rejected" | null {
  const tag = enumTag(v);
  if (tag === "Upheld") return "upheld";
  if (tag === "Rejected") return "rejected";
  return null;
}

export function fromChainResolutionMethod(v: unknown): "reexecution_consensus" | "zk_proof" {
  return enumTag(v) === "ZkProof" ? "zk_proof" : "reexecution_consensus";
}

/** Deterministic 32-byte content address, matching what the contract expects
 * for BytesN<32> fields (escrow_ref/input_hash/output_hash). */
export function sha256Bytes(input: string | Buffer): Buffer {
  return createHash("sha256").update(input).digest();
}

export function hex(buf: Buffer): string {
  return buf.toString("hex");
}

export function bufFromHex(h: string): Buffer {
  return Buffer.from(h, "hex");
}
