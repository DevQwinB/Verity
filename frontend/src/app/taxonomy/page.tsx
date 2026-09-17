import { backendGet } from "../../lib/server-api";
import type { Taxonomy } from "../../lib/types";
import { Card, CardBody, CardHeader } from "../../components/ui/card";
import { Badge } from "../../components/ui/badge";

const METHOD_LABEL: Record<string, string> = {
  replay: "Replay verification",
  statistical_spot_check: "Statistical spot-check",
  manual_review: "Manual review",
};

export default async function TaxonomyPage() {
  const taxonomy = await backendGet<Taxonomy>("/v1/taxonomy");

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Verifiable task taxonomy</h1>
        <p className="mt-1 max-w-2xl text-sm text-text-secondary">
          Version {taxonomy.version}. Verity only auto-verifies task shapes that can actually be
          checked today. Open-ended or subjective work is recorded but never auto-verified.
        </p>
      </div>

      <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
        {taxonomy.task_types.map((entry) => (
          <Card key={entry.type}>
            <CardHeader className="flex items-center justify-between">
              <span className="font-medium capitalize">{entry.type}</span>
              <Badge tone={entry.type === "unverifiable" ? "expired" : "accent"}>
                {METHOD_LABEL[entry.verification_method] ?? entry.verification_method}
              </Badge>
            </CardHeader>
            <CardBody>
              <p className="text-sm leading-relaxed text-text-secondary">{entry.description}</p>
            </CardBody>
          </Card>
        ))}
      </div>
    </div>
  );
}
