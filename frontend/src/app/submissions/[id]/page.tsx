import { notFound } from "next/navigation";
import { backendGetOrNull } from "../../../lib/server-api";
import type { SubmissionDetail, ProofStatus } from "../../../lib/types";
import { Card, CardBody, CardHeader } from "../../../components/ui/card";
import { VerdictBadge } from "../../../components/verdict-badge";
import { stroopsToXlm, truncateMiddle, formatRelativeTime, windowDeadlineIso } from "../../../lib/format";
import { TESTNET_EXPLORER_TX } from "../../../lib/config";
import { ChallengeWindowCountdown } from "../../../components/challenge-window-countdown";
import { OpenChallengeButton } from "../../../components/open-challenge-button";

export default async function SubmissionDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const [detail, proof] = await Promise.all([
    backendGetOrNull<SubmissionDetail>(`/v1/submissions/${id}`),
    backendGetOrNull<ProofStatus>(`/v1/submissions/${id}/proof`),
  ]);
  if (!detail) notFound();
  const { submission, replays, spot_checks, challenge } = detail;
  const deadline = windowDeadlineIso(submission.submitted_at, submission.challenge_window_s);

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="font-mono text-xl">
            {submission.chain_submission_id ? `Submission #${submission.chain_submission_id}` : "Submission"}
          </h1>
          <p className="mt-1 text-sm text-text-secondary">{submission.escrow_ref}</p>
        </div>
        <VerdictBadge status={submission.status} resolutionMethod={challenge?.resolution_method} />
      </div>

      <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
        <Stat label="Task type" value={submission.task_type} />
        <Stat label="Bond" value={`${stroopsToXlm(submission.bond_amount)} XLM`} />
        <Stat label="Submitted" value={formatRelativeTime(submission.submitted_at)} />
        <CardStatSlot>
          {submission.status === "pending" && !challenge ? (
            <ChallengeWindowCountdown deadlineIso={deadline} />
          ) : (
            <Stat label="Window" value={`${submission.challenge_window_s}s`} bare />
          )}
        </CardStatSlot>
      </div>

      {submission.chain_tx_hash && (
        <a
          href={TESTNET_EXPLORER_TX(submission.chain_tx_hash)}
          target="_blank"
          rel="noreferrer"
          className="inline-block text-sm text-accent hover:underline"
        >
          View submission transaction on stellar.expert
        </a>
      )}

      <Card>
        <CardHeader>
          <span className="font-medium">Proof status</span>
        </CardHeader>
        <CardBody>
          {proof?.available ? (
            <p className="text-sm text-status-verified">A ZK proof artifact is available.</p>
          ) : (
            <p className="text-sm text-text-secondary">
              {proof?.reason ??
                "No ZK verifier is registered on this deployment. Verdicts are reached by economic re-execution consensus, not cryptographic proof."}
            </p>
          )}
        </CardBody>
      </Card>

      <Card>
        <CardHeader>
          <span className="font-medium">Replay attestations</span>
        </CardHeader>
        <CardBody className="p-0">
          {replays.length === 0 ? (
            <p className="px-5 py-8 text-center text-sm text-text-tertiary">
              No re-executors have replayed this submission yet.
            </p>
          ) : (
            <ul className="divide-y divide-border-subtle">
              {replays.map((r) => (
                <li key={r.id} className="flex items-center justify-between px-5 py-3 text-sm">
                  <span className="text-text-secondary">
                    Re-executor {truncateMiddle(r.reexecutor_id, 6, 4)}
                  </span>
                  <div className="flex items-center gap-3">
                    <span className="text-xs text-text-tertiary">{r.status}</span>
                    {r.match !== null && (
                      <span className={r.match ? "text-status-verified" : "text-status-slashed"}>
                        {r.match ? "Match" : "Mismatch"}
                      </span>
                    )}
                    {r.tx_hash && (
                      <a
                        href={TESTNET_EXPLORER_TX(r.tx_hash)}
                        target="_blank"
                        rel="noreferrer"
                        className="text-xs text-accent hover:underline"
                      >
                        tx
                      </a>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </CardBody>
      </Card>

      {submission.task_type === "retrieval" && (
        <Card>
          <CardHeader>
            <span className="font-medium">Spot checks</span>
          </CardHeader>
          <CardBody className="p-0">
            {spot_checks.length === 0 ? (
              <p className="px-5 py-8 text-center text-sm text-text-tertiary">
                Not sampled for spot-check yet.
              </p>
            ) : (
              <ul className="divide-y divide-border-subtle">
                {spot_checks.map((s) => (
                  <li key={s.id} className="flex items-center justify-between px-5 py-3 text-sm">
                    <span className="text-text-secondary">
                      Re-executor {truncateMiddle(s.reexecutor_id, 6, 4)}
                    </span>
                    <span>{s.result ?? "pending"}</span>
                  </li>
                ))}
              </ul>
            )}
          </CardBody>
        </Card>
      )}

      <Card>
        <CardHeader>
          <span className="font-medium">Challenge</span>
        </CardHeader>
        <CardBody className="space-y-3">
          {challenge ? (
            <div className="text-sm">
              <p>
                Challenger {truncateMiddle(challenge.challenger_account, 6, 6)} bonded{" "}
                {stroopsToXlm(challenge.challenger_bond)} XLM
              </p>
              <p className="mt-1 text-text-tertiary">
                {challenge.resolved_at
                  ? `Resolved: ${challenge.resolution} via ${challenge.resolution_method}`
                  : "Awaiting resolution"}
              </p>
            </div>
          ) : submission.chain_submission_id ? (
            <OpenChallengeButton submissionId={submission.id} />
          ) : (
            <p className="text-sm text-text-tertiary">
              Not yet confirmed on-chain, cannot be challenged.
            </p>
          )}
        </CardBody>
      </Card>
    </div>
  );
}

function Stat({ label, value, bare }: { label: string; value: string; bare?: boolean }) {
  const content = (
    <>
      <p className="text-xs uppercase tracking-wide text-text-tertiary">{label}</p>
      <p className="mt-2 text-sm capitalize">{value}</p>
    </>
  );
  if (bare) return content;
  return (
    <Card>
      <CardBody>{content}</CardBody>
    </Card>
  );
}

function CardStatSlot({ children }: { children: React.ReactNode }) {
  return (
    <Card>
      <CardBody>{children}</CardBody>
    </Card>
  );
}
