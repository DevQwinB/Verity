import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { BACKEND_URL } from "./config";

export const SESSION_COOKIE = "verity_jwt";

/**
 * Server-only proxy to the real backend for actions that need the caller's
 * JWT. The JWT lives only in an httpOnly cookie set by /api/auth - client
 * JS never sees it, only this server-side handler reads it and attaches it
 * as the Authorization header the backend's requireAuth middleware expects.
 */
export async function proxyToBackend(
  path: string,
  init: { method: string; body?: unknown }
): Promise<NextResponse> {
  const store = await cookies();
  const token = store.get(SESSION_COOKIE)?.value;
  if (!token) {
    return NextResponse.json({ error: "not authenticated" }, { status: 401 });
  }

  const res = await fetch(`${BACKEND_URL}${path}`, {
    method: init.method,
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${token}`,
    },
    body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
    cache: "no-store",
  });

  const data = await res.json().catch(() => ({}));
  return NextResponse.json(data, { status: res.status });
}
