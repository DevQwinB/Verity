import { NextRequest } from "next/server";
import { proxyToBackend, readJsonBody } from "../../../lib/backend-proxy";

export async function POST(req: NextRequest) {
  const parsed = await readJsonBody(req);
  if (!parsed.ok) return parsed.response;
  const body = parsed.body;
  return proxyToBackend("/v1/submissions", { method: "POST", body });
}
