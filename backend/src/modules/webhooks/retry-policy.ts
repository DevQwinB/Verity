/** Maximum number of delivery attempts (including the first). */
export const MAX_DELIVERY_ATTEMPTS = 8;

/** Backoff schedule in milliseconds: 1m, 2m, 4m, 8m, 16m, 32m, 64m, 128m. */
export function backoffMs(attempt: number): number {
  const base = 60_000;
  const capped = Math.min(attempt, 8);
  return base * Math.pow(2, capped - 1);
}

/** Determines whether a failed delivery should be retried based on status code.
 *  - Network errors (null status) are retried.
 *  - 2xx: never (success).
 *  - 3xx: never (redirects are not followed).
 *  - 4xx: only 408 and 429 are retried; other 4xx are terminal.
 *  - 5xx: always retried.
 */
export function shouldRetry(statusCode: number | null): boolean {
  if (statusCode === null) return true; // network/timeout error
  if (statusCode >= 200 && statusCode < 300) return false; // success
  if (statusCode >= 300 && statusCode < 400) return false; // redirects (not followed)
  if (statusCode === 408 || statusCode === 429) return true; // timeout, rate limit
  if (statusCode >= 400 && statusCode < 500) return false; // other client errors
  if (statusCode >= 500) return true; // server errors
  return false;
}
