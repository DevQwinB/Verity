import type { Metadata } from "next";
import Link from "next/link";
import { backendGet } from "../../lib/server-api";
import type { GateConfig, Submission } from "../../lib/types";
import { Card, CardBody, CardHeader } from "../../components/ui/card";
import { Badge } from "../../components/ui/badge";
import { TESTNET_EXPLORER_CONTRACT } from "../../lib/config";
import { formatRelativeTime, stroopsToXlm } from "../../lib/format";

export const metadata: Metadata = { title: "System status" };

export interface HealthResponse {
  ok: boolean;
  deployment: string;
  network_passphrase: string;
  escrow_gate_contract_id: string;
  workers: boolean;
  keeper_balance_stroops: string | null;
  reexecutors_online: number;
  checks: {
    database: boolean;
    rpc: boolean;
    indexer: boolean;
    indexer_lag_ledgers: number | null;
  };
}

export default async function StatusPage() {
  let health: HealthResponse | null = null;
  let config: GateConfig | null = null;
  let submissions: Submission[] = [];
  let unreachableError: string | null = null;

  try {
    const [h, c, s] = await Promise.all([
      backendGet<HealthResponse>("/health"),
      backendGet<GateConfig>("/v1/config").catch(() => null),
      backendGet<Submission[]>("/v1/submissions?limit=10").catch(() => []),
    ]);
    health = h;
    config = c;
    submissions = s;
  } catch (err) {
    unreachableError = err instanceof Error ? err.message : String(err);
  }

  if (!health || unreachableError) {
    return (
      <div className="space-y-6">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">System Status</h1>
          <p className="mt-1 text-sm text-text-secondary">
            Live operational status of the Verity network and backend verification services.
          </p>
        </div>

        <Card className="border-status-slashed/40 bg-status-slashed/5">
          <CardHeader className="flex items-center justify-between">
            <h2 className="text-lg font-medium text-status-slashed">Backend Service Unreachable</h2>
            <Badge tone="slashed">Degraded</Badge>
          </CardHeader>
          <CardBody className="space-y-3">
            <p className="text-sm text-text-secondary">
              The status dashboard could not establish a connection to the Verity API service at the configured endpoint.
            </p>
            {unreachableError && (
              <p className="font-mono text-xs text-text-tertiary">
                {unreachableError}
              </p>
            )}
          </CardBody>
        </Card>
      </div>
    );
  }

  const keeperBalanceXlm = health.keeper_balance_stroops
    ? stroopsToXlm(health.keeper_balance_stroops)
    : null;
  const isKeeperLow = keeperBalanceXlm !== null && Number(keeperBalanceXlm) < 100;

  const minQuorum = config?.quorum_min_reexecutors ?? 1;
  const isQuorumMet = health.reexecutors_online >= minQuorum;

  const lastFinalized = submissions.find(
    (s) => s.status && s.status !== "pending" && s.status !== "disputed"
  );

  return (
    <div className="space-y-8">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">System Status</h1>
          <p className="mt-1 text-sm text-text-secondary">
            Live operational status of the Verity network and verification infrastructure.
          </p>
        </div>
        <div>
          <Badge tone={health.ok ? "verified" : "slashed"} className="text-sm px-3 py-1">
            {health.ok ? "All Systems Operational" : "System Degraded"}
          </Badge>
        </div>
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Card>
          <CardHeader>
            <span className="text-xs font-medium uppercase tracking-wider text-text-tertiary">
              Deployment
            </span>
          </CardHeader>
          <CardBody>
            <div className="text-lg font-semibold uppercase">{health.deployment}</div>
            <div className="mt-1 text-xs text-text-secondary">Stellar Testnet</div>
          </CardBody>
        </Card>

        <Card>
          <CardHeader>
            <span className="text-xs font-medium uppercase tracking-wider text-text-tertiary">
              EscrowGate Contract
            </span>
          </CardHeader>
          <CardBody>
            <Link
              href={TESTNET_EXPLORER_CONTRACT(health.escrow_gate_contract_id)}
              target="_blank"
              rel="noopener noreferrer"
              className="text-xs font-mono text-accent hover:underline break-all"
            >
              {health.escrow_gate_contract_id}
            </Link>
          </CardBody>
        </Card>

        <Card>
          <CardHeader>
            <span className="text-xs font-medium uppercase tracking-wider text-text-tertiary">
              Online Re-executors
            </span>
          </CardHeader>
          <CardBody className="flex items-center justify-between">
            <div>
              <div className="text-lg font-semibold">
                {health.reexecutors_online} <span className="text-sm font-normal text-text-tertiary">/ {minQuorum} quorum</span>
              </div>
              <div className="mt-1 text-xs text-text-secondary">
                {isQuorumMet ? "Quorum satisfied" : "Quorum below requirement"}
              </div>
            </div>
            <Badge tone={isQuorumMet ? "verified" : "slashed"}>
              {isQuorumMet ? "Ready" : "Under quorum"}
            </Badge>
          </CardBody>
        </Card>

        <Card>
          <CardHeader>
            <span className="text-xs font-medium uppercase tracking-wider text-text-tertiary">
              Keeper Balance
            </span>
          </CardHeader>
          <CardBody className="flex items-center justify-between">
            <div>
              <div className="text-lg font-semibold">
                {keeperBalanceXlm ? `${keeperBalanceXlm} XLM` : "Unavailable"}
              </div>
              <div className="mt-1 text-xs text-text-secondary">
                {isKeeperLow ? "Warning: Low balance (< 100 XLM)" : "Sufficient operational stake"}
              </div>
            </div>
            {isKeeperLow ? (
              <Badge tone="slashed">Low</Badge>
            ) : (
              <Badge tone="verified">Funded</Badge>
            )}
          </CardBody>
        </Card>
      </div>

      <div className="grid grid-cols-1 gap-6 md:grid-cols-2">
        <Card>
          <CardHeader>
            <h2 className="font-medium">Infrastructure Health Checks</h2>
          </CardHeader>
          <CardBody className="divide-y divide-border-subtle">
            <div className="flex items-center justify-between py-3">
              <div>
                <div className="text-sm font-medium">PostgreSQL Database</div>
                <div className="text-xs text-text-secondary">Query connectivity and state store</div>
              </div>
              <Badge tone={health.checks.database ? "verified" : "slashed"}>
                {health.checks.database ? "Passing" : "Failing"}
              </Badge>
            </div>

            <div className="flex items-center justify-between py-3">
              <div>
                <div className="text-sm font-medium">Stellar Soroban RPC</div>
                <div className="text-xs text-text-secondary">RPC node connection and ledger lookup</div>
              </div>
              <Badge tone={health.checks.rpc ? "verified" : "slashed"}>
                {health.checks.rpc ? "Passing" : "Failing"}
              </Badge>
            </div>

            <div className="flex items-center justify-between py-3">
              <div>
                <div className="text-sm font-medium">Chain Indexer</div>
                <div className="text-xs text-text-secondary">
                  Lag: {health.checks.indexer_lag_ledgers !== null ? `${health.checks.indexer_lag_ledgers} ledgers` : "unknown"}
                </div>
              </div>
              <Badge tone={health.checks.indexer ? "verified" : "slashed"}>
                {health.checks.indexer ? "Synchronized" : "Lagging"}
              </Badge>
            </div>
          </CardBody>
        </Card>

        <Card>
          <CardHeader>
            <h2 className="font-medium">Verification Activity</h2>
          </CardHeader>
          <CardBody className="space-y-4">
            <div>
              <div className="text-xs font-medium uppercase tracking-wider text-text-tertiary">
                Last Finalized Submission
              </div>
              {lastFinalized ? (
                <div className="mt-2 space-y-1">
                  <div className="flex items-center gap-2">
                    <Link
                      href={`/submissions/${lastFinalized.id}`}
                      className="text-sm font-mono text-accent hover:underline"
                    >
                      {lastFinalized.id}
                    </Link>
                    <Badge tone={lastFinalized.status === "verified" ? "verified" : "slashed"}>
                      {lastFinalized.status}
                    </Badge>
                  </div>
                  <div className="text-xs text-text-secondary">
                    Finalized {formatRelativeTime(lastFinalized.updated_at)}
                  </div>
                </div>
              ) : (
                <p className="mt-2 text-sm text-text-secondary">
                  No finalized submissions recorded on this deployment.
                </p>
              )}
            </div>

            <div className="pt-2 border-t border-border-subtle">
              <div className="text-xs font-medium uppercase tracking-wider text-text-tertiary">
                Background Workers
              </div>
              <div className="mt-2 flex items-center justify-between">
                <span className="text-sm text-text-secondary">
                  Indexer and keeper workers
                </span>
                <Badge tone={health.workers ? "verified" : "expired"}>
                  {health.workers ? "Active" : "Disabled"}
                </Badge>
              </div>
            </div>
          </CardBody>
        </Card>
      </div>
    </div>
  );
}
