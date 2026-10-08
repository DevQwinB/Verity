import { cookies, headers } from "next/headers";
import { NextResponse } from "next/server";
import { BACKEND_URL } from "./config";

export const SESSION_COOKIE = "verity_jwt";

/** The signed-in account, read from the session cookie without verifying
 * it — good enough to address a request, never to authorise one (the backend
 * verifies the token itself on every call). */
export async function sessionAccount(): Promise<string | null> {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  if (!token) return null;
  try {
    const payload = JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString("utf8"));
    if (payload.exp && Date.now() >= payload.exp * 1000) return null;
    return typeof payload.sub === "string" ? payload.sub : null;
  } catch {
    return null;
  }
}

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
  const incoming = await headers();
  const forwarded = incoming.get("x-forwarded-for") ?? incoming.get("x-real-ip");

  let res: Response;
  try {
    res = await fetch(`${BACKEND_URL}${path}`, {
      method: init.method,
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${token}`,
        ...(forwarded ? { "x-forwarded-for": forwarded } : {}),
      },
      body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
      cache: "no-store",
    });
  } catch {
    return NextResponse.json({ error: "The Verity backend is not reachable right now. Try again in a moment." }, { status: 502 });
  }

  const data = await res.json().catch(() => ({}));
  const response = NextResponse.json(data, { status: res.status });
  // The backend no longer accepts this token (expired, or signed with a
  // secret that has since changed): drop it so the browser stops presenting it.
  if (res.status === 401) response.cookies.delete(SESSION_COOKIE);
  return response;
}
