import { NextRequest, NextResponse } from "next/server";
import { BACKEND_URL } from "../../../../lib/config";

export async function GET(req: NextRequest) {
  const account = req.nextUrl.searchParams.get("account");
  if (!account) {
    return NextResponse.json({ error: "account query param required" }, { status: 400 });
  }
  const res = await fetch(
    `${BACKEND_URL}/auth?account=${encodeURIComponent(account)}`,
    { cache: "no-store" }
  );
  const data = await res.json();
  return NextResponse.json(data, { status: res.status });
}
