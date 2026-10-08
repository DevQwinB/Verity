import type { Metadata } from "next";
import { backendGet } from "../../lib/server-api";
import type { VerificationRatesReport } from "../../lib/types";
import { Card, CardBody, CardHeader } from "../../components/ui/card";
import { Badge } from "../../components/ui/badge";
import { truncateMiddle } from "../../lib/format";

export const metadata: Metadata = { title: "Reports" };

const STATUS_LABEL: Record<string, string> = {
  pending: "Pending",
  verified: "Verified",
  disputed: "Disputed",
  slashed: "Slashed",
  expired_unverified: "Expired, unverified",
};

export default async function ReportsPage() {
  const report = await backendGet<VerificationRatesReport>("/v1/reports/verification-rates");

  const totalSubmissions = report.by_marketplace_task_status.reduce(
    (sum, row) => sum + Number(row.count),
    0
  );

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Verification rates</h1>
        <p className="mt-1 max-w-2xl text-sm text-text-secondary">
          Counted live from the submissions and slashes this deployment has on-chain. Unsigned
          drafts are not submissions and are not counted.
        </p>
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <Card>
          <CardBody>
            <p className="text-xs uppercase tracking-wide text-text-tertiary">Total submissions</p>
            <p className="mt-2 font-mono text-3xl">{totalSubmissions}</p>
          </CardBody>
        </Card>
        <Card>
          <CardBody>
            <p className="text-xs uppercase tracking-wide text-text-tertiary">Slashing events</p>
            <p className="mt-2 font-mono text-3xl">{report.slashing_events_total}</p>
          </CardBody>
        </Card>
        <Card>
          <CardBody>
            <p className="text-xs uppercase tracking-wide text-text-tertiary">False-accept rate</p>
            {report.false_accept_rate === null ? (
              <div className="mt-2">
                <Badge tone="pending">Not yet measured</Badge>
                <p className="mt-2 text-xs text-text-tertiary">
                  Requires a manual audit sample against ground truth per the PRD. Not something
                  this system can compute on its own, so it is never fabricated here.
                </p>
              </div>
            ) : (
              <p className="mt-2 font-mono text-3xl">{(report.false_accept_rate * 100).toFixed(1)}%</p>
            )}
          </CardBody>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <h2 className="font-medium">By marketplace, task type and status</h2>
        </CardHeader>
        <CardBody className="overflow-x-auto p-0">
          {report.by_marketplace_task_status.length === 0 ? (
            <p className="px-5 py-8 text-center text-sm text-text-tertiary">
              No submissions recorded yet on this deployment.
            </p>
          ) : (
            <table className="w-full min-w-[520px] text-sm">
              <thead>
                <tr className="text-left text-xs uppercase tracking-wide text-text-tertiary">
                  <th className="px-5 py-3 font-medium">Marketplace</th>
                  <th className="px-5 py-3 font-medium">Task type</th>
                  <th className="px-5 py-3 font-medium">Status</th>
                  <th className="px-5 py-3 text-right font-medium">Count</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border-subtle">
                {report.by_marketplace_task_status.map((row, i) => (
                  <tr key={i}>
                    <td className="px-5 py-3 font-mono text-xs text-text-secondary">
                      {/* A marketplace is named after its account until it registers a name. */}
                      {row.marketplace_name === row.marketplace_account
                        ? truncateMiddle(row.marketplace_account, 6, 6)
                        : row.marketplace_name}
                    </td>
                    <td className="px-5 py-3 capitalize">{row.task_type}</td>
                    <td className="px-5 py-3">{STATUS_LABEL[row.status] ?? row.status}</td>
                    <td className="px-5 py-3 text-right font-mono">{row.count}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </CardBody>
      </Card>
    </div>
  );
}
