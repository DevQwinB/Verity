import Link from "next/link";
import { backendGet } from "../../lib/server-api";
import type { Submission } from "../../lib/types";
import { Card, CardBody } from "../../components/ui/card";
import { VerdictBadge } from "../../components/verdict-badge";
import { buttonClasses } from "../../components/ui/button";
import { stroopsToXlm, truncateMiddle, formatRelativeTime } from "../../lib/format";

export default async function SubmissionsPage() {
  const submissions = await backendGet<Submission[]>("/v1/submissions");

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Submissions</h1>
          <p className="mt-1 max-w-2xl text-sm text-text-secondary">
            Real submissions backed by real Stellar testnet transactions and a live chain indexer.
          </p>
        </div>
        <Link href="/submissions/new" className={buttonClasses("primary")}>
          New submission
        </Link>
      </div>

      {submissions.length === 0 ? (
        <Card>
          <CardBody className="py-12 text-center text-sm text-text-tertiary">
            No submissions recorded on this deployment yet.
          </CardBody>
        </Card>
      ) : (
        <div className="space-y-3">
          {submissions.map((s) => (
            <Link key={s.id} href={`/submissions/${s.id}`}>
              <Card className="transition-colors hover:bg-surface-hover">
                <CardBody className="flex flex-wrap items-center justify-between gap-4">
                  <div>
                    <p className="font-mono text-sm">
                      {s.chain_submission_id ? `#${s.chain_submission_id}` : truncateMiddle(s.id, 6, 6)}
                    </p>
                    <p className="mt-1 text-xs text-text-tertiary">
                      {s.task_type} - agent {truncateMiddle(s.agent_id, 4, 4)} - submitted{" "}
                      {formatRelativeTime(s.submitted_at)}
                    </p>
                  </div>
                  <div className="flex items-center gap-6">
                    <p className="font-mono text-sm">{stroopsToXlm(s.bond_amount)} XLM bond</p>
                    <VerdictBadge status={s.status} />
                  </div>
                </CardBody>
              </Card>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
