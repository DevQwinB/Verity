import { NextRequest } from "next/server";
import { proxyToBackend, readJsonBody } from "../../../../../lib/backend-proxy";

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const parsed = await readJsonBody(req);
  if (!parsed.ok) return parsed.response;
  const body = parsed.body;
  return proxyToBackend(`/v1/submissions/${id}/relay`, { method: "POST", body });
}
