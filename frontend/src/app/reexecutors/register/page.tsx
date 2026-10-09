import type { Metadata } from "next";
import { backendGet } from "../../../lib/server-api";
import type { GateConfig } from "../../../lib/types";
import { RegisterReexecutorForm } from "./form";

export const metadata: Metadata = { title: "Register as a re-executor" };

export default async function RegisterReexecutorPage() {
  const config = await backendGet<GateConfig>("/v1/config");
  return <RegisterReexecutorForm config={config} />;
}
