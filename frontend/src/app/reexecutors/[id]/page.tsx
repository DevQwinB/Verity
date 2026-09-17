import { notFound } from "next/navigation";
import { backendGetOrNull } from "../../../lib/server-api";
import type { Reexecutor, SlashingEvent } from "../../../lib/types";
import { Card, CardBody, CardHeader } from "../../../components/ui/card";
import { Badge } from "../../../components/ui/badge";
import { stroopsToXlm, truncateMiddle, formatRelativeTime } from "../../../lib/format";
import { TESTNET_EXPLORER_ACCOUNT, TESTNET_EXPLORER_TX } from "../../../lib/config";

export default async function ReexecutorDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const data = await backendGetOrNull<{ reexecutor: Reexecutor; slashing_events: SlashingEvent[] }>(
    `/v1/reexecutors/${id}`
  );
  if (!data) notFound();
  const { reexecutor, slashing_events } = data;

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="font-mono text-xl">{truncateMiddle(reexecutor.stellar_account, 8, 8)}</h1>
          <a
            href={TESTNET_EXPLORER_ACCOUNT(reexecutor.stellar_account)}
            target="_blank"
            rel="noreferrer"
            className="text-xs text-accent hover:underline"
          >
            View account on stellar.expert
          </a>
        </div>
        <Badge tone={reexecutor.active ? "verified" : "expired"}>
          {reexecutor.active ? "Active" : "Inactive"}
        </Badge>
      </div>

      <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
        <Card>
          <CardBody>
            <p className="text-xs uppercase tracking-wide text-text-tertiary">Stake</p>
            <p className="mt-2 font-mono text-xl">{stroopsToXlm(reexecutor.stake_amount)} XLM</p>
          </CardBody>
        </Card>
        <Card>
          <CardBody>
            <p className="text-xs uppercase tracking-wide text-text-tertiary">Reputation</p>
            <p className="mt-2 font-mono text-xl">{Number(reexecutor.reputation_score).toFixed(2)}</p>
          </CardBody>
        </Card>
        <Card>
          <CardBody>
            <p className="text-xs uppercase tracking-wide text-text-tertiary">Slashed count</p>
            <p className="mt-2 font-mono text-xl">{reexecutor.slashed_count}</p>
          </CardBody>
        </Card>
        <Card>
          <CardBody>
            <p className="text-xs uppercase tracking-wide text-text-tertiary">Joined</p>
            <p className="mt-2 text-sm">{formatRelativeTime(reexecutor.joined_at)}</p>
          </CardBody>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <span className="font-medium">Slashing history</span>
        </CardHeader>
        <CardBody className="p-0">
          {slashing_events.length === 0 ? (
            <p className="px-5 py-8 text-center text-sm text-text-tertiary">
              No slashing events recorded for this account.
            </p>
          ) : (
            <ul className="divide-y divide-border-subtle">
              {slashing_events.map((event) => (
                <li key={event.id} className="flex items-center justify-between px-5 py-3 text-sm">
                  <div>
                    <p>{event.reason}</p>
                    <p className="text-xs text-text-tertiary">{formatRelativeTime(event.created_at)}</p>
                  </div>
                  <div className="text-right">
                    <p className="font-mono text-status-slashed">-{stroopsToXlm(event.amount)} XLM</p>
                    {event.tx_hash && (
                      <a
                        href={TESTNET_EXPLORER_TX(event.tx_hash)}
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
    </div>
  );
}
