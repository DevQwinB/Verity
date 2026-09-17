import Link from "next/link";
import { backendGet } from "../../lib/server-api";
import type { Reexecutor } from "../../lib/types";
import { Card, CardBody } from "../../components/ui/card";
import { Badge } from "../../components/ui/badge";
import { buttonClasses } from "../../components/ui/button";
import { stroopsToXlm, truncateMiddle, formatRelativeTime } from "../../lib/format";

export default async function ReexecutorsPage() {
  const reexecutors = await backendGet<Reexecutor[]>("/v1/reexecutors");

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Re-executor network</h1>
          <p className="mt-1 max-w-2xl text-sm text-text-secondary">
            Every stake, replay, and slash here is a real Stellar testnet record. Selection into a
            quorum is deterministic and stake-weighted, never operator-chosen.
          </p>
        </div>
        <Link href="/reexecutors/register" className={buttonClasses("primary")}>
          Register as re-executor
        </Link>
      </div>

      {reexecutors.length === 0 ? (
        <Card>
          <CardBody className="py-12 text-center text-sm text-text-tertiary">
            No re-executors registered on this deployment yet.
          </CardBody>
        </Card>
      ) : (
        <Card>
          <CardBody className="p-0">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs uppercase tracking-wide text-text-tertiary">
                  <th className="px-5 py-3 font-medium">Account</th>
                  <th className="px-5 py-3 font-medium">Status</th>
                  <th className="px-5 py-3 text-right font-medium">Stake</th>
                  <th className="px-5 py-3 text-right font-medium">Reputation</th>
                  <th className="px-5 py-3 text-right font-medium">Slashed</th>
                  <th className="px-5 py-3 font-medium">Joined</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border-subtle">
                {reexecutors.map((r) => (
                  <tr key={r.id}>
                    <td className="px-5 py-3">
                      <Link
                        href={`/reexecutors/${r.id}`}
                        className="font-mono text-xs text-accent hover:underline"
                      >
                        {truncateMiddle(r.stellar_account, 6, 6)}
                      </Link>
                    </td>
                    <td className="px-5 py-3">
                      <Badge tone={r.active ? "verified" : "expired"}>
                        {r.active ? "Active" : "Inactive"}
                      </Badge>
                    </td>
                    <td className="px-5 py-3 text-right font-mono">{stroopsToXlm(r.stake_amount)} XLM</td>
                    <td className="px-5 py-3 text-right font-mono">{Number(r.reputation_score).toFixed(2)}</td>
                    <td className="px-5 py-3 text-right font-mono">{r.slashed_count}</td>
                    <td className="px-5 py-3 text-text-tertiary">{formatRelativeTime(r.joined_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </CardBody>
        </Card>
      )}
    </div>
  );
}
