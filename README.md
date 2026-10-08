# Verity

An optimistic verification layer for Soroban escrow. A marketplace's escrow
contract asks Verity's `EscrowGate` for a verdict before it pays an AI agent;
the verdict comes from bonded re-executors replaying the agent's work, with a
challenge window and slashing behind it.

**What is and is not proven.** Phase 1 (this repo) is *economically enforced
and replay-checked*. It is not cryptographic proof of model correctness. The
`ZKVerifierRegistry` contract is deployed with zero verifiers registered, so
there is no code path that can report a ZK-verified result. See
[`prd-01-zkml-agent-truth.md`](prd-01-zkml-agent-truth.md) for the full scope.

## How a submission is verified

```
agent ── submit() + bond ──▶ EscrowGate (Soroban, testnet)
                                 │ SubmissionCreated event
                                 ▼
                    backend indexer ── assigns re-executors
                                 │
        re-executor agents ◀─────┘  fetch the declared artifacts, re-derive the
                 │                  output, hash it canonically
                 └── attest_replay(matched) ──▶ EscrowGate (bonded vote)
                                                   │
backend keeper ── finalize() / resolve_challenge() ┘  verdict + bond settlement
               └─ slash() wrong-side voters, release_attestation_lock()
```

| Task type | How it is checked |
|---|---|
| `deterministic` | A full quorum replays the declared function over the declared input in a sandbox and votes match/mismatch. A bonded supermajority finalizes immediately. |
| `retrieval` | One sampled re-executor re-fetches the declared URL (spot-check). A match leaves the submission to auto-verify when its challenge window closes; a mismatch escalates it — and the agent's other pending submissions — to a full quorum. |

Verdicts: `verified` (agent bond returned), `slashed` (agent bond forfeited),
`expired_unverified` (a challenge nobody could resolve; all bonds returned).
Anyone can open a bonded challenge inside the window. The loser of a
challenge forfeits their bond to the winner.

Outputs are hashed as **canonical JSON** (keys sorted, no whitespace), so key
order and formatting never cause a false mismatch. The same function lives in
`reexecutor-agent/src/sandbox/canonical.ts` and `frontend/src/lib/canonical.ts`.

## Repository layout

| Path | What |
|---|---|
| `contracts/` | Soroban contracts: `escrow-gate`, `zk-verifier-registry`, `example-marketplace-escrow`, shared `common` types |
| `backend/` | Fastify API, SEP-10 auth, chain indexer, keeper/scheduler |
| `reexecutor-agent/` | Worker that replays assignments and attests on-chain with its own key |
| `frontend/` | Next.js dashboard (Freighter wallet) |
| `db/` | Kysely schema, migrations, embedded Postgres for Docker-free dev |
| `deployments/testnet.json` | Deployed contract IDs and public keys |
| `scripts/` | Deploy, bootstrap, dev runner, smoke test |

## Run it

Requirements: Node 20+, pnpm 10, [stellar-cli](https://developers.stellar.org/docs/tools/cli).
Docker is not needed. Rust is only needed to change or test the contracts.

```bash
pnpm install
pnpm dev
```

`pnpm dev` starts Postgres, runs migrations, and starts the backend, one
re-executor agent per bootstrap identity, and the dashboard, all against the
contracts already deployed on Stellar testnet. Ctrl+C stops everything.

- Dashboard: http://localhost:3000
- API: http://localhost:3001

Ports are configurable when those are taken:

```bash
VERITY_API_PORT=4001 VERITY_WEB_PORT=4000 pnpm dev
```

The re-executor agents sign with stellar-cli identities `rex1`…`rex5`
(override with `VERITY_REEXECUTORS="alias1 alias2 alias3"`). On a fresh
machine, or after a testnet reset, create and stake them first:

```bash
scripts/deploy_testnet.sh          # deploys contracts, writes deployments/testnet.json
scripts/bootstrap_reexecutors.sh   # stakes rex1..rex5 into EscrowGate
```

Secrets stay in your stellar-cli keystore. `pnpm dev` reads them at start-up
and passes them to each process through its environment. The only file it
writes is `backend/.env` (gitignored), and only if it does not exist.

### Prove it works end to end

With `pnpm dev` running, in another terminal:

```bash
pnpm smoke                       # VERITY_API_PORT=4001 pnpm smoke if you changed it
```

This plays an agent and a challenger against the live stack and real testnet,
and checks five flows: honest and dishonest deterministic work, a challenged
submission, and honest and dishonest retrieval work. It never attests on a
re-executor's behalf — the running agents do that. Takes about five minutes.

### Use the dashboard

Install [Freighter](https://www.freighter.app/), switch it to Testnet, and
fund the account with Friendbot. Then connect the wallet and:

- **Submissions → New** to submit work. A deterministic example:
  input `{"n": 21}`, function body `return { doubled: input.n * 2 };`,
  claimed output `{"doubled": 42}`. Change the claimed output to anything else
  to watch the bond get slashed.
- **Re-executors → Register** to stake (the on-chain floor is 500 XLM), then
  run your own worker: `REEXECUTOR_SECRET_KEY=S... pnpm --filter @verity/reexecutor-agent start`.
- Open a submission to challenge it while its window is open.

## Contracts

```bash
pnpm test:contracts                # cargo test in contracts/
```

`EscrowGate` has no upgrade entrypoint: a contract change means a new
deployment (`scripts/deploy_testnet.sh`), a new contract ID in
`deployments/testnet.json`, and re-staking re-executors. If the interface
changes, regenerate the TypeScript bindings under
`backend/src/chain/generated/` with `stellar contract bindings typescript`.

## API

SEP-10 JWT auth (`GET /auth?account=G…`, sign, `POST /auth`). Every
state-changing call is build → sign → relay: the backend returns unsigned
XDR, the caller signs with their own key, and posts it back. The backend
never holds a user's key.

```
POST /v1/artifacts                      upload a content-addressed artifact
GET  /v1/artifacts/:hash
POST /v1/submissions                    build submit()            -> unsigned XDR
POST /v1/submissions/:id/relay          relay the signed XDR
GET  /v1/submissions[/:id]              status, replays, spot-checks, challenge
POST /v1/submissions/:id/challenge      build open_challenge()    -> unsigned XDR
POST /v1/submissions/:id/challenge/relay
GET  /v1/submissions/:id/proof          always "not available" in Phase 1
POST /v1/reexecutors                    build register_reexecutor() -> unsigned XDR
POST /v1/reexecutors/:id/relay
POST /v1/reexecutors/sync               mirror existing on-chain stake
GET  /v1/reexecutors[/:id]
GET  /v1/reexecutors/:id/assignments    work queue for that re-executor
GET  /v1/challenges
GET  /v1/taxonomy
GET  /v1/reports/verification-rates
POST /v1/marketplaces, POST /v1/marketplaces/:id/webhooks
```

Webhooks (HMAC-SHA256 in `x-verity-signature`): `submission.verified`,
`submission.slashed`, `submission.disputed`.

## Known limits

- **Sandbox.** With Docker available, functions replay in a container with no
  network. Without it, the agent falls back to `node:vm`, which is not a
  security boundary. Do not replay untrusted functions without Docker.
- **Assignment** is deterministic and auditable but uniform, not
  stake-weighted. Offline re-executors are not reassigned; a challenge they
  leave unresolved expires and returns both bonds.
- **Slashing policy.** The keeper slashes a wrong-side re-executor by
  `REEXECUTOR_SLASH_BPS` of their stake (default 10%). The contract only
  bounds this by the stake; the policy is off-chain.
- **Stellar 8004.** Verdicts are stored as signed attestation payloads; they
  are not pushed to an 8004 registry, whose ingestion schema is not published.
- **False-accept rate** needs a manual audit sample and is reported as `null`.
- **Docker Compose** files exist but are untested on this machine (no Docker).
- Testnet only. Contracts are unaudited.
