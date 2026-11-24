import type { SubmissionDetail } from "./types";

/** The parts of a submission that change while its page is polling it. The
 * page and the status route both compute this from the same backend read, so
 * the client can compare what the page was rendered with against what the
 * route reports now. A string, not an object, so the comparison never depends
 * on JSON key order. */
export function submissionFingerprint({ submission, replays, challenge }: SubmissionDetail): string {
  return JSON.stringify([
    submission.status,
    submission.settled_at,
    submission.updated_at,
    challenge?.id ?? null,
    replays.filter((r) => r.status === "confirmed_onchain").length,
  ]);
}
