# Deploying Verity for other people to use

This is the runbook for a public testnet deployment: its own contracts, its
own keys, a database that starts empty, and the stack running from container
images on any host. Local development is `pnpm dev` (see the README) and is
deliberately a separate deployment.

## What you are running

| Piece | Image | Notes |
|---|---|---|
| Postgres | `postgres:18-alpine` | Mirror of chain state, plus artifacts metadata. Not exposed. |
| Backend | `backend/Dockerfile` | API, chain indexer, keeper. **Run exactly one with workers on.** |
| Dashboard | `frontend/Dockerfile` | Next.js. Talks to the backend over the internal network. |
| Re-executors | `reexecutor-agent/Dockerfile` | Your own fleet, at least a quorum (3). Optional `fleet` profile. |

The images need nothing special from the host: no Docker socket, no extra
capabilities. Submitted functions run in a WebAssembly sandbox inside the
re-executor process.

## 1. Create the deployment (once, from your own machine)

You need `stellar-cli` and Rust. Keys are created in your stellar-cli keystore
and never leave it except where you copy them in step 2.

```bash
VERITY_DEPLOYMENT=public scripts/deploy_testnet.sh --public
VERITY_DEPLOYMENT=public scripts/bootstrap_reexecutors.sh
```

The first command deploys a fresh EscrowGate and ZKVerifierRegistry, each
configured in the same transaction that creates it, and writes
`deployments/public.json`. It creates the identities `verity-public-deployer` (the
contract admin), `verity-public-keeper` and `verity-public-rex1..5`. The second stakes the
five re-executors and approves them as voters.

`--public` marks the deployment so that `pnpm dev` and `pnpm smoke` refuse to
run against it. Test submissions are real on-chain records; they must never
land on the contract your users see. A public deployment also gets the real
challenge windows (1 hour, or 24 hours from 100,000 XLM of escrow value)
rather than the 10-minute dev windows.

Commit `deployments/public.json`. It holds contract IDs and public keys only.

## 2. Configure

On the host, in a checkout of this repository:

```bash
cp .env.example .env
```

Fill it in from `deployments/public.json` and your keystore:

| Variable | Value |
|---|---|
| `ESCROW_GATE_CONTRACT_ID`, `ZK_VERIFIER_REGISTRY_CONTRACT_ID`, `BOND_ASSET_CONTRACT_ID` | `escrow_gate_contract_id`, `zk_verifier_registry_contract_id`, `native_xlm_sac_address` |
| `WEB_AUTH_DOMAIN`, `HOME_DOMAIN` | The public host of the **API**, e.g. `api.verity.example` |
| `POSTGRES_PASSWORD` | `openssl rand -hex 24` |
| `JWT_SECRET` | `openssl rand -hex 32` |
| `KEEPER_SECRET_KEY` | `stellar keys secret verity-public-keeper` |
| `SEP10_SIGNING_SECRET` | `stellar keys generate verity-public-sep10 && stellar keys secret verity-public-sep10` |
| `REX1..5_SECRET_KEY` | `stellar keys secret verity-public-rex1` … `verity-public-rex5` |

The **admin key (`verity-public-deployer`) does not go on the server.** It is only
used from your own machine, to approve re-executors and change contract
configuration.

Keep the keeper account funded: it pays the fee for every finalize, challenge
resolution and lock release. `stellar keys fund verity-public-keeper --network testnet`
tops it up.

## 3. Start it

```bash
docker compose --profile fleet up -d --build
docker compose ps
curl -s http://127.0.0.1:3001/health
```

`/health` answers `200` with `"ok": true` once the database, the Soroban RPC
and the indexer are all in order, and reports which deployment and contract
this backend serves. `/health/live` only says the process is up.

Without `--profile fleet` you get everything except the re-executors, which
you can then run elsewhere with the same image and `BACKEND_URL` pointed at
the public API.

## 4. Put HTTPS in front

The containers listen on `127.0.0.1` only. Terminate TLS with any reverse
proxy and route two hosts:

| Public host | To |
|---|---|
| `verity.example` | `127.0.0.1:3000` (dashboard) |
| `api.verity.example` | `127.0.0.1:3001` (backend) |

HTTPS is required, not optional: the sign-in cookie is `Secure` in production,
so sign-in does not work over plain HTTP.

The API must be publicly reachable because other people's re-executor workers
poll it. Your proxy **must overwrite `X-Forwarded-For`** with the real client
address rather than pass through whatever the client sent: the backend trusts
that header for rate limiting.

With Caddy the whole configuration is:

```
verity.example {
	reverse_proxy 127.0.0.1:3000
}
api.verity.example {
	reverse_proxy 127.0.0.1:3001
}
```

## 5. Day to day

**Approving a re-executor.** Anyone can stake from the dashboard; their
account then shows as "Pending approval". To let it vote, from your machine:

```bash
VERITY_DEPLOYMENT=public scripts/approve_reexecutor.sh G...
VERITY_DEPLOYMENT=public scripts/approve_reexecutor.sh G... --revoke
```

**One backend with workers.** The indexer owns the chain cursor and the keeper
signs with one account sequence, so only one backend process may run them. To
scale the API, run more backends with `RUN_WORKERS=false`.

**Storage.** Two volumes hold state: `pgdata` and `backend_artifacts` (the
functions and inputs agents declared). Back both up together. Postgres can be
rebuilt from the chain only within the RPC's event retention (about 7 days);
the artifacts cannot be rebuilt at all.

**Contract TTL.** Contract entries expire if untouched for long enough. Every
state-changing call extends them, so a deployment in use looks after itself.
After a long idle spell, extend them explicitly:

```bash
stellar contract extend --id <ESCROW_GATE_CONTRACT_ID> --source verity-public-keeper \
  --network testnet --durability persistent --ledgers-to-extend 500000
```

**Testnet resets.** Stellar testnet is wiped periodically. After a reset the
contracts are gone: repeat step 1 with `--force`, update `.env`, and start
from an empty database (`docker compose down -v` deletes both volumes).

**Upgrading.** EscrowGate has no upgrade entrypoint. A backend, dashboard or
worker change is `git pull && docker compose --profile fleet up -d --build`.
A contract change is a new deployment: step 1 with `--force`, then as for a
testnet reset. Stakes on the old contract stay withdrawable from it.

## What this deployment does not give you

- It is Stellar testnet. The XLM has no value, the contracts are unaudited.
- Stake is free on testnet, which is why the voter set is admin-approved.
  That is a real admin power: you decide who may vote. You cannot set a verdict.
- Webhooks are delivered once, with no retry.
- Artifacts live on one host's disk.
