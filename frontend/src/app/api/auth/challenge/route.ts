import { NextRequest, NextResponse } from "next/server";
import { BACKEND_URL } from "../../../../lib/config";

export async function GET(req: NextRequest) {
  const account = req.nextUrl.searchParams.get("account");
  if (!account) {
    return NextResponse.json({ error: "account query param required" }, { status: 400 });
  }
  try {
    const res = await fetch(
      `${BACKEND_URL}/auth?account=${encodeURIComponent(account)}`,
      { cache: "no-store" }
    );
    const data = await res.json().catch(() => ({}));
    return NextResponse.json(data, { status: res.status });
  } catch {
    return NextResponse.json({ error: "The Verity backend is not reachable right now. Try again in a moment." }, { status: 502 });
  }
}
