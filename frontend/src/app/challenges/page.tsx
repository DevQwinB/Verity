import Link from "next/link";
import { backendGet } from "../../lib/server-api";
import type { ChallengeListItem } from "../../lib/types";
import { Card, CardBody } from "../../components/ui/card";
import { Badge } from "../../components/ui/badge";
import { stroopsToXlm, truncateMiddle, formatRelativeTime } from "../../lib/format";
import { TESTNET_EXPLORER_TX } from "../../lib/config";

const METHOD_LABEL: Record<string, string> = {
  reexecution_consensus: "Re-execution consensus",
  zk_proof: "ZK proof",
  manual_review: "Manual review",
};

export default async function ChallengesPage() {
  const challenges = await backendGet<ChallengeListItem[]>("/v1/challenges");

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Challenges</h1>
        <p className="mt-1 max-w-2xl text-sm text-text-secondary">
          Every challenge here is a real, bonded dispute against a submission. Resolution method is
          always shown explicitly, never blurred between economic and cryptographic outcomes.
        </p>
      </div>

      {challenges.length === 0 ? (
        <Card>
          <CardBody className="py-12 text-center text-sm text-text-tertiary">
            No challenges have been opened on this deployment yet.
          </CardBody>
        </Card>
      ) : (
        <div className="space-y-3">
          {challenges.map((c) => (
            <Card key={c.id}>
              <CardBody className="flex flex-wrap items-center justify-between gap-4">
                <div>
                  <Link
                    href={`/submissions/${c.submission_id}`}
                    className="font-mono text-sm text-accent hover:underline"
                  >
                    Submission {c.chain_submission_id ?? c.submission_id.slice(0, 8)}
                  </Link>
                  <p className="mt-1 text-xs text-text-tertiary">
                    Challenger {truncateMiddle(c.challenger_account, 6, 6)} - opened{" "}
                    {formatRelativeTime(c.opened_at)}
                  </p>
                </div>
                <div className="flex items-center gap-3">
                  <div className="text-right">
                    <p className="font-mono text-sm">{stroopsToXlm(c.challenger_bond)} XLM bond</p>
                    {c.resolution_method && (
                      <p className="text-xs text-text-tertiary">
                        {METHOD_LABEL[c.resolution_method] ?? c.resolution_method}
                      </p>
                    )}
                  </div>
                  <Badge tone={c.resolution === "upheld" ? "slashed" : c.resolution === "rejected" ? "verified" : "pending"}>
                    {c.resolution ? c.resolution : "Open"}
                  </Badge>
                  {c.chain_tx_hash && (
                    <a
                      href={TESTNET_EXPLORER_TX(c.chain_tx_hash)}
                      target="_blank"
                      rel="noreferrer"
                      className="text-xs text-accent hover:underline"
                    >
                      tx
                    </a>
                  )}
                </div>
              </CardBody>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
