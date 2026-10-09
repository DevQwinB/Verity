import type { Metadata } from "next";
import { backendGet } from "../../../lib/server-api";
import type { GateConfig } from "../../../lib/types";
import { NewSubmissionForm } from "./form";

export const metadata: Metadata = { title: "New submission" };

export default async function NewSubmissionPage() {
  const config = await backendGet<GateConfig>("/v1/config");
  return <NewSubmissionForm config={config} />;
}
