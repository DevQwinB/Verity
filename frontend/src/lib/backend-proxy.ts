import { cookies, headers } from "next/headers";
import { NextResponse } from "next/server";
import { BACKEND_ACTION_TIMEOUT_MS, BACKEND_URL } from "./config";

export const SESSION_COOKIE = "verity_jwt";

/** Parse a request body as JSON, answering a malformed or empty body with a
 * 400 instead of letting the SyntaxError from Request.json() surface as an
 * unhandled 500. Returns a result so callers stay one-liners; the 400 is
 * built here, in one place. */
export async function readJsonBody(
  req: Request
): Promise<{ ok: true; body: unknown } | { ok: false; response: NextResponse }> {
  try {
    return { ok: true, body: await req.json() };
  } catch {
    return { ok: false, response: NextResponse.json({ error: "invalid JSON body" }, { status: 400 }) };
  }
}

/** What the session cookie claims: the account, and when the token expires.
 * Read without verifying the signature — good enough to address a request and
 * to schedule a UI clock, never to authorise one (the backend verifies the
 * token itself on every call). `expires_at` is the token's `exp` in
 * milliseconds since the epoch, or null for a token that carries none: an
 * early or late clock on the client can only make the UI wrong sooner or
 * later, never make an expired token work. */
export async function sessionInfo(): Promise<{
  account: string | null;
  expires_at: number | null;
}> {
  const empty = { account: null, expires_at: null };
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  if (!token) return empty;
  try {
    const payload = JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString("utf8"));
    if (payload.exp && Date.now() >= payload.exp * 1000) return empty;
    if (typeof payload.sub !== "string") return empty;
    return {
      account: payload.sub,
      expires_at: typeof payload.exp === "number" ? payload.exp * 1000 : null,
    };
  } catch {
    return empty;
  }
}

/** The signed-in account alone, for server-side code that only needs to know
 * who is asking. */
export async function sessionAccount(): Promise<string | null> {
  return (await sessionInfo()).account;
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
      signal: AbortSignal.timeout(BACKEND_ACTION_TIMEOUT_MS),
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
