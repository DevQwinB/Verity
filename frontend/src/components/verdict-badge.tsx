import { Badge } from "./ui/badge";
import type { SubmissionStatus, ChallengeResolutionMethod } from "../lib/types";

const STATUS_LABEL: Record<SubmissionStatus, string> = {
  pending: "Pending",
  verified: "Verified",
  disputed: "Disputed",
  slashed: "Slashed",
  expired_unverified: "Expired, unverified",
};

const STATUS_TONE: Record<SubmissionStatus, "pending" | "verified" | "disputed" | "slashed" | "expired"> = {
  pending: "pending",
  verified: "verified",
  disputed: "disputed",
  slashed: "slashed",
  expired_unverified: "expired",
};

/**
 * PRD §10 hard requirement: every verdict display must state whether it was
 * reached by re-execution consensus (Phase 1, economic) or a ZK proof
 * (Phase 2, cryptographic) - never blur the two, and never imply a
 * cryptographic guarantee this deployment cannot back (the ZKVerifierRegistry
 * ships with zero registered verifiers, so `zk_proof` never actually occurs
 * here today, but the label is driven by the real field, not hardcoded).
 */
export function VerdictBadge({
  status,
  resolutionMethod,
}: {
  status: SubmissionStatus;
  resolutionMethod?: ChallengeResolutionMethod | null;
}) {
  const mechanism =
    status === "pending"
      ? "Awaiting replay consensus or challenge window"
      : resolutionMethod === "zk_proof"
        ? "Cryptographic ZK proof"
        : resolutionMethod === "manual_review"
          ? "Manual review"
          : "Economic re-execution consensus, not a cryptographic proof";

  return (
    <div className="inline-flex flex-col gap-1">
      <Badge tone={STATUS_TONE[status]}>{STATUS_LABEL[status]}</Badge>
      <span className="text-xs text-text-tertiary">{mechanism}</span>
    </div>
  );
}
