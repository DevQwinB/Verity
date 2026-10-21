# Verity

An optimistic verification layer for Soroban escrow. A marketplace's escrow
contract asks Verity's `EscrowGate` for a verdict before it pays an AI agent;
the verdict comes from bonded re-executors replaying the agent's work, with a
challenge window and slashing behind it.

**What is and is not proven.** Phase 1 (this repo) is *economically enforced
and replay-checked*. It is not cryptographic proof of model correctness.
`EscrowGate` accepts no ZK proofs: its challenge resolution rejects the ZK
method outright, so no code path can report a ZK-verified result. The
`ZKVerifierRegistry` contract is deployed empty as the anchor for Phase 2. See
[`prd-01-zkml-agent-truth.md`](prd-01-zkml-agent-truth.md) for the full scope.

## How a submission is verified

```
agent ── submit() + bond ──▶ EscrowGate (Soroban, testnet)
                                 │ SubmissionCreated event
                                 ▼
                    backend indexer ── assigns online re-executors
                                 │
        re-executor agents ◀─────┘  fetch the declared artifacts, re-derive the
                 │                  output, hash it canonically
                 └── attest_replay(matched) ──▶ EscrowGate (bonded vote)
                                                   │
backend keeper ── finalize() / resolve_challenge() ┘  verdict + bond settlement
               └─ release_attestation_lock()  slashes a wrong-side voter, then
                                              unlocks the stake
```

| Task type | How it is checked |
|---|---|
| `deterministic` | A quorum (plus one spare) replays the declared function over the declared input in a WebAssembly sandbox and votes match/mismatch. A bonded supermajority finalizes immediately. |
| `retrieval` | One sampled re-executor re-fetches the declared URL (spot-check). A match leaves the submission to be verified by default when its challenge window closes; a mismatch escalates it — and the agent's other pending submissions — to a full quorum. |

Every verdict records how it was reached, and the dashboard shows it:

| Verdict | Reached by | Meaning |
|---|---|---|
| `verified` | re-execution consensus | A bonded supermajority replayed the work and it matched. Agent bond returned. |
| `verified` | window elapsed | Nobody challenged and no quorum formed. **Not replayed to quorum**; shown as "Verified by default". Agent bond returned. |
| `slashed` | re-execution consensus | A bonded supermajority found a mismatch. Agent bond forfeited. |
| `expired_unverified` | window elapsed | Either a challenge that no quorum could resolve, or a window that closed with a mismatch reported but no quorum. Nothing was established; every bond is returned and nobody is slashed. |

Anyone can open a bonded challenge inside the window. If the challenge is
upheld, the challenger gets their bond back plus 20% of the agent's, and the
rest of the agent's bond goes to the admin/treasury account. If it is rejected,
the challenger's bond goes to the agent.

A re-executor whose vote a bonded consensus proves wrong loses a fixed share
of its stake (10% as deployed). The amount is set on-chain and applied when
its stake lock is released, so it can be neither chosen by the caller nor
escaped by withdrawing first. A verdict that only defaulted proves nobody
wrong and slashes nobody.

Outputs are hashed as **canonical JSON** (keys sorted, no whitespace), so key
order and formatting never cause a false mismatch. The same function lives in
`reexecutor-agent/src/sandbox/canonical.ts`, `frontend/src/lib/canonical.ts`
and `backend/src/chain/canonical.ts`.

## Repository layout

| Path | What |
|---|---|
| `contracts/` | Soroban contracts: `escrow-gate`, `zk-verifier-registry`, `example-marketplace-escrow` (reference only, not deployed), shared `common` types |
| `backend/` | Fastify API, SEP-10 auth, chain indexer, keeper/scheduler |
| `reexecutor-agent/` | Worker that replays assignments and attests on-chain with its own key |
| `frontend/` | Next.js dashboard (Freighter wallet) |
| `db/` | Kysely schema, migrations, embedded Postgres for Docker-free dev |
| `deployments/<name>.json` | Deployed contract IDs and public keys, one file per deployment |
| `scripts/` | Deploy, bootstrap, approve, bindings, dev runner, smoke test |
| `docs/DEPLOY.md` | Running a public deployment from the container images |

## Run it

Requirements: Node 20+, pnpm 10, [stellar-cli](https://developers.stellar.org/docs/tools/cli).
Docker is not needed. Rust is needed to deploy contracts (the deploy script
builds them) and to change or test them, but not to run against a deployment
that already exists.

```bash
pnpm install
pnpm dev
```

`pnpm dev` starts Postgres, runs migrations, and starts the backend, one
re-executor agent per bootstrap identity, and the dashboard, all against the
contracts recorded in `deployments/testnet.json`. Ctrl+C stops everything.

- Dashboard: http://localhost:3000
- API: http://localhost:3001

Ports are configurable when those are taken:

```bash
VERITY_API_PORT=4001 VERITY_WEB_PORT=4000 pnpm dev
```

The re-executor agents sign with stellar-cli identities `rex1`…`rex5`
(override with `VERITY_REEXECUTORS="alias1 alias2 alias3"`). On a fresh
machine, or after a testnet reset, create the deployment first:

```bash
scripts/deploy_testnet.sh --force   # deploys contracts, writes deployments/testnet.json
scripts/bootstrap_reexecutors.sh    # stakes rex1..rex5 and approves them as voters
pnpm db:reset                       # the local database still mirrors the old contract
```

`deployments/testnet.json` is the **dev** deployment: 10-minute challenge
windows, used by `pnpm dev` and `pnpm smoke`. A deployment for other people is
separate, with its own contracts and keys — see [`docs/DEPLOY.md`](docs/DEPLOY.md).
`VERITY_DEPLOYMENT=<name>` selects `deployments/<name>.json` in every script.

The stellar-cli keystore is one flat namespace shared by every project on your
machine. The dev deployment uses the short aliases `deployer`, `keeper` and
`rex1`…`rex5`; if another project generates an identity under one of those
names, it replaces yours. The scripts compare the keystore with
`deployments/testnet.json` and stop if the admin or a staked re-executor is no
longer the recorded account (a replaced keeper is only reported: it holds no
authority on-chain). Named deployments use `verity-<name>-…` aliases.

Secrets stay in your stellar-cli keystore. `pnpm dev` reads them at start-up
and passes them to each process through its environment. The only secrets it
writes to disk are in `backend/.env` (gitignored), and only if that file does
not exist; it also creates the local database under `.pgdata/`.

### Prove it works end to end

With `pnpm dev` running, in another terminal:

```bash
pnpm smoke                       # VERITY_API_PORT=4001 pnpm smoke if you changed it
```

This plays an agent, a challenger and one rogue re-executor against the live
stack and real testnet. It checks honest and dishonest deterministic work, a
challenged submission, that a relay endpoint refuses a transaction it was not
built for, honest and dishonest retrieval work, and that a re-executor who
votes wrong is slashed exactly the on-chain rate and can then withdraw. For
every verdict it checks how the contract says it was reached and verifies the
signed attestation. It never attests on a fleet re-executor's behalf — the
running agents do that.

Two slower modes wait out real challenge windows:

```bash
SMOKE_SLOW=1 pnpm smoke          # also: a spot-checked retrieval verifies by default

# with fewer than a quorum online, so no consensus can form:
VERITY_REEXECUTORS="rex1 rex2" pnpm dev
SMOKE_PROFILE=underquorum pnpm smoke
```

The second proves the no-quorum paths: honest work verifies by default (and is
labelled as not replayed), contested work expires unverified, an unresolved
challenge expires with both bonds returned, and nobody is slashed in any of
them.

Smoke submissions are real on-chain records. The script only runs against a
local backend, and refuses a deployment marked public.

### Use the dashboard

Install [Freighter](https://www.freighter.app/), switch it to Testnet, connect,
and use "Fund my testnet account" on the home page. Then:

- **Submissions → New** to submit work. A deterministic example:
  input `{"n": 21}`, function body `return { doubled: input.n * 2 };`,
  claimed output `{"doubled": 42}`. Change the claimed output to anything else
  to watch the bond get slashed.
- **Re-executors → Register** to stake (the on-chain floor is 500 XLM). The
  account then shows as pending until the deployment admin approves it:
  `scripts/approve_reexecutor.sh G...`. Run your own worker with
  `REEXECUTOR_SECRET_KEY=S... ESCROW_GATE_CONTRACT_ID=C... pnpm --filter @verity/reexecutor-agent start`
  (see `reexecutor-agent/.env.example`); work is only assigned to accounts
  whose worker is polling.
- Open a pending submission to challenge it while its window is open.
- A re-executor can withdraw stake from its own page.

## Writing replayable work

Work submitted to Verity must be deterministic: honest re-executors independently
reproduce the output and vote on whether it matches the claimed output hash.
Depending on the task type, replay runs either in a sandboxed WebAssembly JavaScript
runtime or as a guarded HTTP retrieval spot-check.

### Deterministic tasks

Deterministic tasks run in a sandboxed JavaScript runtime:

1. **Function body shape.** The function source must be a JavaScript function body,
   not an entire module or function declaration. It runs as `(function(input){ ... })(__input)`.
   To return an answer, use `return`.
2. **Arguments and global scope.** The input artifact is parsed as JSON and passed as
   the `input` argument. It is also available as the global `__input`.
3. **Sandbox engine.** QuickJS compiled to WebAssembly (`quickjs-emscripten`),
   executed in an isolated worker thread with an empty environment (`env: {}`) and
   a fresh runtime instance per replay.
4. **Environment and globals.** `Date` and `Math.random` are explicitly deleted
   before execution, so calling `new Date()` or `Math.random()` throws. Other `Math`
   functions remain available. Standard platform globals such as `console`,
   `setTimeout`, `fetch`, `process`, and `require` are absent (`typeof` each is
   `"undefined"`).
5. **Execution limits.**
   - Memory: 64 MiB (`64 * 1024 * 1024` bytes).
   - Stack: 128 KiB (`128 * 1024` bytes).
   - Computation: 1000 interrupt checks (ticks). This provides a computation budget
     of a few seconds of busy loops; loops that exceed this fail with `computation budget exceeded`.
   - Output size: serialized output can be at most 1,000,000 bytes.
   - Wall-clock timeout: 20 s host kill switch. This is a host-level safety timeout
     rather than an engine limit; if triggered, the re-executor considers its host
     overloaded, casts no vote, and retries later (`ReplayInfrastructureError`). It does
     not count as a mismatch against the submission.
6. **Failure handling.** If the function throws an exception or exceeds an engine limit
   (memory, stack, computation budget, or output size), the re-executor produces a
   32-zero-byte output hash, which never matches a legitimate claimed output hash and
   results in a mismatch vote.
7. **Return values and JSON serialization.** The return value is serialized via `JSON.stringify`:
   - A function that returns nothing (`undefined`) yields `null`.
   - `NaN` and `Infinity` serialize to `null`.
   - Object properties with `undefined` values are omitted.
   - Returning a `BigInt` throws an error and counts as a mismatch.
   - Async functions returning a `Promise` serialize to `{}`. Write synchronous code.
8. **Artifact upload limits.** Each artifact (function, input, claimed output) may be
   at most 262144 bytes (`ARTIFACT_MAX_BYTES`). The API request body limit is 1 MiB.

### Canonical JSON and claimed outputs

9. **Hashing format.** Outputs are hashed as canonical JSON: object keys sorted
   recursively, no whitespace, `undefined`-valued object properties omitted, and
   hashed with SHA-256.
10. **Dashboard input formatting.** The dashboard "Claimed output" field parses input
    as JSON if valid; otherwise, trimmed text is treated as a JSON string and canonicalized.
    Formatting whitespace does not affect the hash: `{"doubled": 42}` and `{ "doubled":42 }`
    produce identical hashes. Numeric formatting follows `JSON.stringify` (e.g. `1.0` is `1`).
11. **Worked example.**
    - Input artifact: `{"n": 21}`
    - Function body: `return { doubled: input.n * 2 };`
    - Claimed output: `{"doubled": 42}`
    - Verification locally (from `reexecutor-agent/`):
      ```bash
      pnpm exec tsx -e '(async () => { const { runDeterministicFunction } = await import("./src/sandbox/runner.ts"); console.log(await runDeterministicFunction("return { doubled: input.n * 2 };", { n: 21 })); process.exit(0); })()'
      ```
      This evaluates the function and outputs `output: { doubled: 42 }` along with its
      canonical `outputHash`.

### Retrieval tasks

12. **Spec format.** The input artifact must be JSON conforming to `{"url": "...", "pointer"?: "/..."}`.
    Invalid JSON or a missing string `url` counts as a mismatch.
13. **HTTP request rules.** The re-executor issues a single `GET` request with
    `accept: application/json, text/plain;q=0.9, */*;q=0.1` and no credentials, auth headers,
    or cookies. The endpoint must be publicly accessible without authentication.
    Only `http:` and `https:` schemes are supported. The URL must resolve to a public IP
    address: loopback, private, and link-local IP addresses are rejected, and the request
    connects directly to the validated IP.
14. **Redirects and response codes.** Redirects are not followed; HTTP 3xx status codes
    are treated as a mismatch. HTTP 4xx status codes or other non-2xx responses are also
    mismatches. Responses with status 5xx, 408, 429, timeouts, or network errors are
    treated as transient: the worker retries for up to `min(RETRIEVAL_RETRY_BUDGET_S, challenge window / 2)`
    seconds (default `RETRIEVAL_RETRY_BUDGET_S` is 120 s), verifies its own network
    connectivity, and only votes mismatch if its own connectivity is intact. Each HTTP request
    times out after 10 s, and response bodies are capped at 1,000,000 bytes.
15. **JSON pointers.** If the response body is JSON, an optional RFC 6901 pointer (e.g. `/data/0/price`)
    selects the targeted value (`~1` escapes `/`, `~0` escapes `~`). The pointer must start
    with `/`; an empty pointer `""` selects the entire document. A pointer that fails to resolve
    or is specified on non-JSON content is a mismatch. If no pointer is specified, the full parsed
    JSON body is used; if the body is not JSON, the raw response text string is used.
16. **Text whitespace caveat.** The dashboard trims plain-text claimed output, whereas a
    re-executor checks the raw untrimmed response body when no pointer is specified. An endpoint
    returning text ending with a newline will not match trimmed text; prefer JSON responses
    with a JSON pointer. In addition, endpoints whose content changes between the submission
    and re-execution will produce a mismatch.

## Contracts

```bash
pnpm test:contracts                # cargo test in contracts/
```

`EscrowGate` has no upgrade entrypoint: a contract change means a new
deployment (`scripts/deploy_testnet.sh --force`), a new contract ID in
`deployments/<name>.json`, and re-staking re-executors. Each contract is
configured by its constructor in the same transaction that deploys it. If the
interface changes, regenerate the TypeScript bindings under
`backend/src/chain/generated/` with `scripts/generate_bindings.sh`.

The admin (the deploying account) can change the configuration future
submissions use, and decides which staked accounts may vote while
`reexecutor_allowlist` is on. It cannot set, change or override a verdict.

## API

SEP-10 JWT auth (`GET /auth?account=G…`, sign, `POST /auth`). Every
state-changing call is build → sign → relay: the backend returns unsigned
XDR, the caller signs with their own key, and posts it back. The backend
never holds a user's key, and a relay endpoint forwards only the EscrowGate
call it was built for.

```
GET  /health, /health/live              readiness (DB, RPC, indexer) / liveness
GET  /v1/config                         the contract's live rules
POST /v1/artifacts                      upload a content-addressed artifact
GET  /v1/artifacts/:hash
POST /v1/submissions                    build submit()            -> unsigned XDR
POST /v1/submissions/:id/relay          relay the signed XDR
GET  /v1/submissions[/:id]              status, replays, spot-checks, challenge
GET  /v1/submissions/:id/attestation    signed record of a settled verdict
POST /v1/submissions/:id/challenge      build open_challenge()    -> unsigned XDR
POST /v1/submissions/:id/challenge/relay
GET  /v1/submissions/:id/proof          always "not available" in Phase 1
POST /v1/reexecutors                    build register_reexecutor() -> unsigned XDR
POST /v1/reexecutors/:id/withdraw       build withdraw_stake()    -> unsigned XDR
POST /v1/reexecutors/:id/relay          relay a signed stake or withdrawal
POST /v1/reexecutors/sync               mirror existing on-chain stake
GET  /v1/reexecutors[/:id]              stake, standing, record
GET  /v1/reexecutors/:id/assignments    work queue for that re-executor
GET  /v1/challenges
GET  /v1/taxonomy
GET  /v1/reports/verification-rates
POST /v1/marketplaces, POST /v1/marketplaces/:id/webhooks
```

Webhooks (HMAC-SHA256 in `x-verity-signature`): `submission.verified`,
`submission.slashed`, `submission.disputed`.

## Known limits

- **Testnet only. Contracts are unaudited.**
- **What "verified" covers.** The input and claimed-output hashes are
  committed on-chain; the function is stored by hash but not committed. A
  verdict means "consistent with the artifacts the agent declared".
- **No escrow is gated yet.** `example-marketplace-escrow` shows the
  integration but is not deployed; `escrow_value` is declared by the agent.
- **Voter set.** Stake is free on testnet, so an open voter set could be
  captured at no cost. Deployments here run with `reexecutor_allowlist` on:
  the admin approves which staked accounts may vote.
- **Sandbox limits.** Replay limits and constraints are detailed in
  [Writing replayable work](#writing-replayable-work). Exceeding an engine
  limit or throwing is a mismatch. A function that stalls a re-executor's host
  without exceeding an engine limit gets no vote from it.
- **Assignment** is deterministic and auditable but uniform, not
  stake-weighted. It only picks re-executors whose worker is online, and asks
  another when one goes quiet.
- **Stellar 8004.** Verdicts are stored as signed attestation payloads and
  served by the API; they are not pushed to an 8004 registry, whose ingestion
  schema is not published.
- **False-accept rate** needs a manual audit sample and is reported as `null`.
- **One backend instance** runs the indexer and keeper; artifacts are on its
  local disk; webhooks are delivered once with no retry.
- **Containers.** The three images build, and the full stack has been run
  from them (Postgres, migrations, backend, three re-executors, dashboard)
  and passed the smoke test, using podman with the services started one by
  one. `docker-compose.yml` describes the same services but has not itself
  been executed: the machine this was developed on has no compose provider.

## License

Apache License 2.0. See [`LICENSE`](LICENSE).

## Contributing

See [`CONTRIBUTING.md`](CONTRIBUTING.md) for setup, checks and the PR flow,
[`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) for a map of the code, and
[`SECURITY.md`](SECURITY.md) for reporting a vulnerability. Licensed under
[Apache-2.0](LICENSE).
