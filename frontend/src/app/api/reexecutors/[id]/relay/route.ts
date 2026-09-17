import { NextRequest } from "next/server";
import { proxyToBackend } from "../../../../../lib/backend-proxy";

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const body = await req.json();
  return proxyToBackend(`/v1/reexecutors/${id}/relay`, { method: "POST", body });
}
