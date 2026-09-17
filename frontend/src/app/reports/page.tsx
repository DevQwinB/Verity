import { backendGet } from "../../lib/server-api";
import type { VerificationRatesReport } from "../../lib/types";
import { Card, CardBody, CardHeader } from "../../components/ui/card";
import { Badge } from "../../components/ui/badge";

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
          Computed live from real submission and slashing records. Phase 1 metrics only.
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
          <span className="font-medium">By marketplace, task type, and status</span>
        </CardHeader>
        <CardBody className="p-0">
          {report.by_marketplace_task_status.length === 0 ? (
            <p className="px-5 py-8 text-center text-sm text-text-tertiary">
              No submissions recorded yet on this deployment.
            </p>
          ) : (
            <table className="w-full text-sm">
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
                      {row.marketplace_id.slice(0, 8)}
                    </td>
                    <td className="px-5 py-3 capitalize">{row.task_type}</td>
                    <td className="px-5 py-3 capitalize">{row.status}</td>
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
