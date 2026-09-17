import { BACKEND_URL } from "./config";

/**
 * Server-only fetch against the real backend for public (unauthenticated)
 * reads. Always no-store: verdicts and stake amounts reflect live chain
 * state via the indexer, so a stale cached read would show a wrong verdict.
 */
export async function backendGet<T>(path: string): Promise<T> {
  const res = await fetch(`${BACKEND_URL}${path}`, { cache: "no-store" });
  if (!res.ok) {
    throw new Error(`Backend GET ${path} failed: ${res.status} ${await res.text()}`);
  }
  return res.json() as Promise<T>;
}

export async function backendGetOrNull<T>(path: string): Promise<T | null> {
  const res = await fetch(`${BACKEND_URL}${path}`, { cache: "no-store" });
  if (res.status === 404) return null;
  if (!res.ok) {
    throw new Error(`Backend GET ${path} failed: ${res.status} ${await res.text()}`);
  }
  return res.json() as Promise<T>;
}
