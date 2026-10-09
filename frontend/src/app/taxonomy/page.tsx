import type { Metadata } from "next";
import { backendGet } from "../../lib/server-api";
import type { Taxonomy } from "../../lib/types";
import { Card, CardBody, CardHeader } from "../../components/ui/card";
import { Badge } from "../../components/ui/badge";

export const metadata: Metadata = { title: "Task taxonomy" };

const METHOD_LABEL: Record<string, string> = {
  replay: "Full replay",
  statistical_spot_check: "Sampled spot-check",
  manual_review: "Not verifiable",
};

export default async function TaxonomyPage() {
  const taxonomy = await backendGet<Taxonomy>("/v1/taxonomy");

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Verifiable task taxonomy</h1>
        <p className="mt-1 max-w-2xl text-sm text-text-secondary">
          Version {taxonomy.version}. Verity only accepts task shapes it can actually check today.
          Open-ended or subjective work has no verification path and cannot be submitted.
        </p>
      </div>

      <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
        {taxonomy.task_types.map((entry) => (
          <Card key={entry.type}>
            <CardHeader className="flex items-center justify-between gap-3">
              <h2 className="font-medium capitalize">{entry.type}</h2>
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
