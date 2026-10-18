# @verity/frontend

The Next.js dashboard for Verity.

## What it is

The Verity dashboard is built with **Next.js 16**, **React 19**, and **Tailwind CSS 4** (see `frontend/package.json`).

It serves as the user-facing web interface for viewing verification statuses, submitting tasks, registering re-executors, and monitoring disputes. Following the architectural principle in `CONTRIBUTING.md`, the dashboard only renders what the backend API reports—the backend remains the sole authority on chain state.

The application interacts with the Stellar network by signing transactions through the [Freighter](https://www.freighter.app/) browser wallet extension. The frontend never holds or manages a user's private keys.

Pages live under `src/app`:
- `/`: Home dashboard overview
- `/submissions`: List of submitted re-execution tasks
- `/submissions/new`: Form to create a new submission
- `/submissions/[id]`: Detailed view of a single submission
- `/reexecutors`: Registry of active re-executors
- `/reexecutors/[id]`: Detail page for an individual re-executor
- `/reexecutors/register`: Registration form for prospective re-executors
- `/challenges`: Challenge and dispute dashboard
- `/reports`: Incident and operational reports
- `/taxonomy`: Verification taxonomy and classification reference

## Running it

### As part of the full stack
From the repository root, running:
```bash
pnpm dev
```
starts all services, including the dashboard (see root `README.md` "Run it"). The dashboard listens on port `3000` by default, or the port defined by `VERITY_WEB_PORT` in `scripts/dev.sh`, which runs `next dev --turbopack -p "$WEB_PORT"` with `BACKEND_URL` and `NEXT_PUBLIC_NETWORK_PASSPHRASE` populated.

### Standalone frontend commands
From the repository root:
```bash
# Start Turbopack dev server on port 3000
pnpm --filter @verity/frontend dev

# Build production bundle
pnpm --filter @verity/frontend build

# Start production server on port 3000
pnpm --filter @verity/frontend start
```

## Environment variables

The frontend reads two application-specific environment variables, plus standard `NODE_ENV`. Check with `grep -rn "process.env" frontend/src` to verify that no other environment variables are accessed.

| Variable | Scope & Timing | Default | Description |
| :--- | :--- | :--- | :--- |
| `BACKEND_URL` | Runtime (server-side only) | `http://127.0.0.1:3001` | Base URL of the Verity backend API. Read in `src/lib/config.ts`. Defaults to `http://127.0.0.1:3001` (uses `127.0.0.1` instead of `localhost` because Node resolves `localhost` to IPv6 `::1` first while the backend only binds IPv4). In `docker-compose.yml`, this is configured as `http://backend:3001`. |
| `NEXT_PUBLIC_NETWORK_PASSPHRASE` | Build time (inlined into client bundle) | `"Test SDF Network ; September 2015"` | Stellar network passphrase used by Freighter wallet signing. Next.js inlines `NEXT_PUBLIC_*` values into the client JavaScript bundle at build time. Declared as an `ARG` in `frontend/Dockerfile` and passed as `NETWORK_PASSPHRASE` during compose builds. Changing this for a container requires an image rebuild, not just a restart. |
| `NODE_ENV` | Runtime / Build time | `"development"` / `"production"` | Controls framework optimizations and determines whether the session cookie uses `secure: true` in `src/app/api/auth/route.ts`. |

For local development, copy `.env.example` to `.env.local`:
```bash
cp frontend/.env.example frontend/.env.local
```
Next.js automatically loads `.env.local`, which is ignored by `.gitignore`.

## The `/api/*` proxy

All client-initiated mutations and authenticated actions flow through route handlers under `src/app/api` (13 `route.ts` files):

| Route Handler | Method | Backend Target | Description |
| :--- | :--- | :--- | :--- |
| `/api/auth/challenge` | `GET` | `GET /auth?account=<address>` | Fetches a SEP-10 challenge transaction from the backend for the specified Stellar account. |
| `/api/auth` | `POST` | `POST /auth` | Submits the Freighter-signed challenge transaction to the backend and sets the `verity_jwt` `httpOnly` session cookie upon success. |
| `/api/auth/logout` | `POST` | *(none)* | Clears the `verity_jwt` session cookie on the client response without calling the backend. |
| `/api/session` | `GET` | *(none)* | Decodes the `sub` claim from the `verity_jwt` cookie and returns `{ account }` (or `{ account: null }` if unauthenticated/expired). |
| `/api/friendbot` | `POST` | `https://friendbot.stellar.org` | Faucet request for testnet funding. Only permits funding the currently signed-in account (returns 401 if unauthenticated). |
| `/api/artifacts` | `POST` | `POST /v1/artifacts` | Forwards artifact creation payload to backend via `proxyToBackend`. |
| `/api/submissions` | `POST` | `POST /v1/submissions` | Forwards new task submission to backend via `proxyToBackend`. |
| `/api/submissions/[id]/relay` | `POST` | `POST /v1/submissions/:id/relay` | Relays signed on-chain transaction for a submission via `proxyToBackend`. |
| `/api/submissions/[id]/challenge` | `POST` | `POST /v1/submissions/:id/challenge` | Forwards challenge initiation for a submission via `proxyToBackend`. |
| `/api/submissions/[id]/challenge/relay` | `POST` | `POST /v1/submissions/:id/challenge/relay` | Relays signed challenge transaction to backend via `proxyToBackend`. |
| `/api/reexecutors` | `POST` | `POST /v1/reexecutors` | Forwards re-executor registration to backend via `proxyToBackend`. |
| `/api/reexecutors/[id]/relay` | `POST` | `POST /v1/reexecutors/:id/relay` | Relays re-executor on-chain registration transaction via `proxyToBackend`. |
| `/api/reexecutors/[id]/withdraw` | `POST` | `POST /v1/reexecutors/:id/withdraw` | Forwards re-executor stake withdrawal request via `proxyToBackend`. |

### `proxyToBackend` behavior (`src/lib/backend-proxy.ts`)
- Returns `401` `{ error: "not authenticated" }` immediately if the `verity_jwt` cookie is absent.
- Forwards `Authorization: Bearer <cookie token>` and the incoming `x-forwarded-for` (or `x-real-ip`) header.
- Enforces an action timeout of 90 seconds (`BACKEND_ACTION_TIMEOUT_MS`) to accommodate on-chain transaction confirmation.
- Catches network/connection errors and returns `502` with `{ error: "The Verity backend is not reachable right now. Try again in a moment." }`.
- Automatically deletes the `verity_jwt` cookie if the backend responds with `401` (e.g., token expired or signing secret rotated).

## Server-side reads

Server components fetch public read data directly from the backend using `src/lib/server-api.ts`:
- **`cache: "no-store"`**: Verdicts, states, and stakes reflect live on-chain state indexed by the backend; stale cached reads are avoided.
- **20-second timeout (`BACKEND_READ_TIMEOUT_MS`)**: Read operations abort if the backend takes longer than 20 seconds.
- **Client IP forwarding**: Passes the visitor's `x-forwarded-for` header to the backend to preserve per-client rate limiting.
- **Error handling**: Unhandled fetch errors or non-404/400 failures throw `BackendError`, which renders `src/app/error.tsx` with user-friendly retry instructions.

## Session model

Authentication follows **Stellar SEP-10**:
1. The browser requests a challenge transaction for the user's public key (`GET /api/auth/challenge?account=...`).
2. The user signs the transaction in Freighter.
3. The browser submits the signed transaction via `POST /api/auth`.
4. The backend verifies the signature and returns a signed JWT expiring in 1 hour (`issueJwt` in `backend/src/auth/sep10.ts`).
5. The Next.js route handler sets an `httpOnly` cookie named `verity_jwt` (`sameSite: "lax"`, `path: "/"`, `maxAge: 3600`, `secure: process.env.NODE_ENV === "production"`).

Client-side JavaScript cannot read the token. Because `secure` is enabled in production, serving a production build over plain HTTP will prevent session persistence; HTTPS is required as documented in `docs/DEPLOY.md` section 4.

## Checks

To verify code quality and types:
```bash
# Typecheck TypeScript definitions and Next.js types
pnpm --filter @verity/frontend typecheck

# Lint with ESLint
pnpm --filter @verity/frontend lint

# Test production build
pnpm --filter @verity/frontend build
```

> [!NOTE]
> The dashboard currently has **no automated tests**. `frontend/package.json` contains no test script, and no test files exist within the `frontend/` package.

## Container image

`frontend/Dockerfile` defines a multi-stage build:
- Builds the standalone Next.js output (`.next/standalone`).
- Listens on port `3000`.
- Runs as the unprivileged `node` user.
- Includes a healthcheck requesting `http://127.0.0.1:3000/icon.svg`.

## Canonical JSON

In accordance with `CONTRIBUTING.md` ("Canonical JSON must stay identical"), `src/lib/canonical.ts` must remain byte-for-byte identical to the canonical JSON implementations in the other packages.
