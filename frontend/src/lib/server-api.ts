import { headers } from "next/headers";
import { unstable_rethrow } from "next/navigation";
import { BACKEND_READ_TIMEOUT_MS, BACKEND_URL } from "./config";

/** The backend rate-limits per client address. Every server-rendered read
 * comes from this one server, so the browser's own address is passed along
 * (the backend honours it only when it is told to trust its proxy). */
async function forwardedFor(): Promise<Record<string, string>> {
  const incoming = await headers();
  const chain = incoming.get("x-forwarded-for") ?? incoming.get("x-real-ip");
  return chain ? { "x-forwarded-for": chain } : {};
}

/** Thrown for any backend failure other than "that does not exist". The
 * message is for the server log; app/error.tsx shows the visitor a plain
 * explanation and a retry instead. */
export class BackendError extends Error {
  constructor(
    public readonly path: string,
    public readonly status: number | null,
    detail: string
  ) {
    super(`Backend GET ${path} failed: ${status ?? "unreachable"} ${detail}`);
    this.name = "BackendError";
  }
}

async function get(path: string): Promise<Response> {
  // Read outside the try: at build time headers() throws to tell Next.js the
  // route is dynamic, and that signal must reach the framework untouched.
  const forwarded = await forwardedFor();
  try {
    return await fetch(`${BACKEND_URL}${path}`, {
      cache: "no-store",
      headers: forwarded,
      // A backend that accepts the connection but never answers must end in
      // the error state too, not in a page that loads forever.
      signal: AbortSignal.timeout(BACKEND_READ_TIMEOUT_MS),
    });
  } catch (err) {
    unstable_rethrow(err);
    throw new BackendError(path, null, err instanceof Error ? err.message : String(err));
  }
}

/**
 * Server-only fetch against the real backend for public (unauthenticated)
 * reads. Always no-store: verdicts and stake amounts reflect live chain
 * state via the indexer, so a stale cached read would show a wrong verdict.
 */
export async function backendGet<T>(path: string): Promise<T> {
  const res = await get(path);
  if (!res.ok) throw new BackendError(path, res.status, await res.text());
  return res.json() as Promise<T>;
}

/** Null when the thing does not exist: a 404, or a 400 for an id that is not
 * even well-formed (a mistyped URL is a missing page, not a server fault). */
export async function backendGetOrNull<T>(path: string): Promise<T | null> {
  const res = await get(path);
  if (res.status === 404 || res.status === 400) return null;
  if (!res.ok) throw new BackendError(path, res.status, await res.text());
  return res.json() as Promise<T>;
}
