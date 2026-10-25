const NETWORK_CODES = new Set([
  "ECONNREFUSED",
  "ECONNRESET",
  "ECONNABORTED",
  "ETIMEDOUT",
  "ENOTFOUND",
  "EAI_AGAIN",
  "EPIPE",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "UND_ERR_SOCKET",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
]);

/** Postgres SQLSTATEs that say "try again" rather than "this statement is wrong":
 * class 08 connection exceptions, 40001/40P01 serialization and deadlock,
 * 53xxx insufficient resources, 57P01-57P03 and 57014 admin shutdown/cancel. */
function isTransientSqlState(code: string): boolean {
  return (
    code.startsWith("08") ||
    code.startsWith("53") ||
    code === "40001" ||
    code === "40P01" ||
    code === "57P01" ||
    code === "57P02" ||
    code === "57P03" ||
    code === "57014"
  );
}

/** True when `err` came from the environment (network, database availability,
 * RPC overload) rather than from the event itself, so repeating the same work
 * later can succeed. The indexer retries these forever and only skips an event
 * whose failure is deterministic. */
export function isTransientError(err: unknown, depth = 0): boolean {
  if (!err || typeof err !== "object" || depth > 3) return false;
  const e = err as {
    code?: unknown;
    status?: unknown;
    response?: { status?: unknown };
    message?: unknown;
    cause?: unknown;
    errors?: unknown;
  };

  if (typeof e.code === "string" && (NETWORK_CODES.has(e.code) || isTransientSqlState(e.code))) return true;

  const status = typeof e.status === "number" ? e.status : e.response?.status;
  if (typeof status === "number" && (status === 408 || status === 429 || status >= 500)) return true;

  // fetch() rejects with a bare TypeError("fetch failed") and the real reason in `cause`.
  if (typeof e.message === "string" && /fetch failed|socket hang up|timeout|timed out|connection terminated/i.test(e.message)) {
    return true;
  }

  // AggregateError (dual-stack connect) carries one error per address.
  if (Array.isArray(e.errors) && e.errors.some((inner) => isTransientError(inner, depth + 1))) return true;

  return isTransientError(e.cause, depth + 1);
}
