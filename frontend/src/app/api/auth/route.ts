import { NextRequest, NextResponse } from "next/server";
import { BACKEND_URL } from "../../../lib/config";
import { SESSION_COOKIE } from "../../../lib/backend-proxy";

/**
 * Step 2 of SEP-10: the client has already signed the challenge with
 * Freighter. We forward the signed XDR to the real backend for verification
 * against the claimed account's actual on-chain signing key, then store the
 * returned JWT in an httpOnly cookie - never in localStorage, never handed
 * back to client JS - so an XSS bug can't exfiltrate the session token.
 */
export async function POST(req: NextRequest) {
  const body = await req.json();
  const res = await fetch(`${BACKEND_URL}/auth`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    cache: "no-store",
  });
  const data = await res.json();
  if (!res.ok || !data.token) {
    return NextResponse.json({ error: data.error ?? "authentication failed" }, { status: res.status });
  }

  const payload = JSON.parse(Buffer.from(data.token.split(".")[1], "base64url").toString("utf8"));
  const response = NextResponse.json({ account: payload.sub });
  response.cookies.set(SESSION_COOKIE, data.token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: 60 * 60,
  });
  return response;
}
