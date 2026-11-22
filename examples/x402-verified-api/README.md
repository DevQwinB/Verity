# x402 verified API (verify-then-pay example)

An AI agent pays for an API call with USDC over [x402](https://www.x402.org) (HTTP 402, `exact` scheme, `stellar:testnet`, settled by a facilitator). The seller does not just take the money: after the payment settles, it bonds the response through Verity's EscrowGate with `escrow_ref` set to the **x402 settlement transaction hash**. The buyer then polls the submission to a terminal verdict and verifies the signed attestation, checking that `escrow_ref` matches the payment it made. A seller that returns a wrong result is replayed by re-executors, found to be a mismatch, and **slashed**.

```
buyer                         seller (this example)            Verity (testnet)
  |  GET /compute?n=21          |                                |
  |---------------------------->|                                |
  |  402 + payment requirements |                                |
  |<----------------------------|                                |
  |  X-PAYMENT (signed USDC tx) |                                |
  |---------------------------->|  facilitator verifies+settles  |
  |                             |  (upfront flow: before serving)|
  |                             |---------------- submit() ------>|
  |  200 + X-Verity-Submission  |  bond locked, escrow_ref=txhash|
  |<----------------------------|                                |
  |  poll /v1/submissions/:id   |                                |
  |------------------------------------------------------> poll   |
  |  attestation (signed)       |<---------------- verdict ----|
  |<------------------------------------------------------      |
  verify signature + escrow_ref == payment tx hash               |
```

The route uses x402's `upfront` payment flow, so the facilitator settles **before** the seller serves anything: the handler knows the settlement tx hash, and a payment that fails to settle never reaches the paid code.

## What this protects — and what it does not

- **Protected:** the buyer gets a signed, on-chain verdict that the paid response matched the deterministic function the seller declared. `escrow_ref` binds that verdict to the exact x402 settlement transaction, so the attestation cannot be replayed for a different payment.
- **Not protected:** x402's `exact` scheme pays the seller **at request time**. This example does **not** hold the buyer's money in escrow; there is nothing to refund from. If the response is wrong, the buyer's recourse is the challenge flow: the seller's **bond** is slashed, the upheld challenger gets 20% of it and the rest goes to the deployment treasury (README.md). The buyer itself is refunded only if it opens the challenge.
- **Bond economics matter at per-call prices.** A $0.01 call with a 5% minimum bond puts ~$0.0005 at stake, which deters nothing. Set `ESCROW_VALUE_STROOPS`/`BOND_STROOPS` to a value that actually matters for your price (the bond must be ≥ `agent_bond_min_bps` of `escrow_value`, enforced by the contract).
- **Paid endpoints must be deterministic tasks.** A retrieval task re-fetches the URL with a plain unauthenticated GET, which a 402 paywall answers with 402 — not a transient status, so it counts as a mismatch and would slash an honest seller. This example therefore submits `deterministic` tasks only.

## Run it

Prerequisites: `pnpm dev` running (Verity API on :3001 against the testnet deployment), re-executor workers running, and two funded testnet accounts: a **seller** (receives USDC, pays the XLM bond, acts as the Verity agent) and a **buyer** (USDC trustline — Circle faucet). The seller account needs the deployment's agent bond in XLM.

```bash
cp .env.example .env   # fill SELLER_SECRET / BUYER_SECRET
pnpm install           # from the repo root (the example is a workspace package)
pnpm --filter @verity/example-x402-verified-api seller   # terminal 1
pnpm --filter @verity/example-x402-verified-api buyer    # terminal 2
```

The buyer prints the payment and finalize transactions as stellar.expert links, the verdict, and exits non-zero unless the verdict is `verified` and the attestation's `escrow_ref` equals the settlement tx hash.

To see the slash path, run the seller with a `WRONG=1` env var (it submits an output the function does not produce), then have the buyer open a challenge (`POST /v1/submissions/:id/challenge` build → sign → relay with the buyer's key, as in the dashboard) and wait out the window.

## Layout

| File | What |
|---|---|
| `seller.mjs` | x402-protected endpoint; after settlement, uploads artifacts and relays a bonded `submit()` with `escrow_ref` = settlement tx hash |
| `buyer.mjs` | x402 payment flow (per the Stellar quickstart), polls the verdict, verifies the attestation and the payment binding |
| `lib/payment-ref.mjs` | settlement tx hash → `escrow_ref` (validated, fail-closed) |
| `lib/verity-api.mjs` | SEP-10 login, artifact upload, build/sign/relay, poll, attestation fetch |
| `lib/attestation.mjs` | attestation verification (canonical bytes + pinned ed25519 signer + deployment binding), mirroring the README recipe |
| `lib/canonical-json.mjs` | canonical JSON, mirroring `backend/src/chain/canonical.ts` |
| `test/` | node --test unit tests for the three pure libs |

Tests: `pnpm --filter @verity/example-x402-verified-api test`.

The live end-to-end run (real 402 → settlement → submit → verdict) needs funded testnet keys and is exercised by hand following this README; it is not part of CI.
