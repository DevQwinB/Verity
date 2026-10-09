import { setDefaultAutoSelectFamilyAttemptTimeout } from "node:net";

// Node's happy-eyeballs gives each address family only 250ms to connect
// before moving on. On a host with no IPv6 route and a slow-ish link, the
// IPv4 attempt to the Soroban RPC regularly needs longer than that, and every
// request then dies with "fetch failed" (ETIMEDOUT + ENETUNREACH).
setDefaultAutoSelectFamilyAttemptTimeout(5000);

// The Stellar SDK issues its RPC calls through global fetch with no timeout,
// and Node's own default waits 5 minutes for response headers. One request
// black-holed by a network blip therefore froze a whole worker loop (and
// anything queued behind the keeper lock) for 5 minutes at a time. Every
// outbound request now fails fast instead, and the loops simply retry.
const REQUEST_TIMEOUT_MS = 30_000;
const nativeFetch = globalThis.fetch;
globalThis.fetch = (input, init) => {
  const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
  const signal = init?.signal ? AbortSignal.any([init.signal, timeout]) : timeout;
  return nativeFetch(input, { ...init, signal });
};
