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

export function fromChainVerdict(v: { tag: string }): string {
  switch (v.tag) {
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
