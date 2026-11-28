# x402 Verified Agent API (Verify-Then-Pay Recourse)

This example shows how an AI agent paying for API calls over **HTTP 402 (x402)** in USDC on Stellar can gain recourse against dishonest or incorrect responses using **Verity EscrowGate**.

---

## The Problem

[x402](https://x402.org) enables AI agents to pay for API calls autonomously. However, under standard x402 `exact` payment:
1. The buyer pays upfront upon receiving the `402 Payment Required` challenge.
2. The seller executes the call and returns the response.
3. If the response is faulty, hallucinatory, or maliciously fabricated, the buyer has **no recourse** — the payment transaction has already settled on Stellar testnet/mainnet.

## How Verity Provides Recourse

With Verity:
1. **Binding Payment to Response:** When the seller accepts the x402 payment, it computes the response and immediately registers a `submit()` on Verity's `EscrowGate` contract.
2. **Cryptographic Binding (`escrow_ref`):** The seller sets `escrow_ref` to the 32-byte hash of the buyer's x402 settlement transaction.
3. **Seller Bond:** The seller locks an on-chain bond (`bond_amount`) backed by its own funds (at least `agent_bond_min_bps`, e.g. 5%).
4. **Independent Verification:** Verity's quorum of independent re-executors replays the deterministic task in a sandboxed WebAssembly engine.
5. **Punishment and Recourse:**
   - If the seller provided an honest, reproducible response, consensus confirms it and the seller's bond is returned.
   - If the seller returned a fraudulent or incorrect response, consensus (or an open challenge) proves the claim wrong: the seller is **slashed**, 20% of the slashed bond is awarded to the challenger, and the remainder goes to the platform treasury.

---

## Security Model: What Is and Is Not Protected

> [!IMPORTANT]
> **No Payment Escrow in x402 Exact Mode:**
> x402's `exact` scheme pays the seller at request time. This example does **not** hold the buyer's original payment in escrow.
>
> If a seller acts dishonestly:
> - The seller loses its locked **bond**.
> - The buyer is refunded or compensated **only if the buyer acts as the challenger** (receiving 20% of the slashed bond).
> - True payment escrow (holding payment in a contract until the challenge window elapses) requires a custom pay-to-contract flow or session escrow, outside the baseline x402 exact spec.

---

## Why Deterministic Tasks Are Used for Paid APIs

Verity supports both `deterministic` and `retrieval` task types.

For x402-paid APIs, tasks **must be deterministic**:
- A Verity `retrieval` re-executor re-fetches the target URL with a plain, unauthenticated `GET`.
- Because an x402 endpoint requires payment, an unauthenticated re-executor would receive an HTTP 402.
- HTTP 402 is not on Verity's transient error retry list (401, 403, 408, 429, 451, 5xx), so it is treated as a **permanent failure / mismatch**.
- An honest seller using `retrieval` on its own paid endpoint would therefore be slashed.
- Deterministic tasks instead package the logic as a pure function artifact that re-executors replay deterministically in an isolated sandbox.

---

## Bond Economics & Challenge Windows

For micro-transactions (e.g. 0.01 USDC API calls):
- A 5% bond on 0.01 USDC is only 0.0005 USDC, which is negligible and does not deter fraud.
- In production, sellers should configure an absolute bond floor (for example, 5 to 10 XLM minimum bond per call) rather than purely proportional bonds.
- The challenge window (`window_tier_small_s`, typically 1 to 2 hours) dictates the settlement finality period.

---

## Architecture

```
[Buyer Agent]                                   [Seller API]                       [Verity EscrowGate]
      |                                              |                                      |
      |--- 1. POST /api/analyze (no payment) ------->|                                      |
      |<-- 2. 402 Payment Required (x402 spec) ------|                                      |
      |                                              |                                      |
      |--- 3. Stellar payment transaction ---------->| [Stellar testnet]                    |
      |                                              |                                      |
      |--- 4. POST /api/analyze (x402 tx=<hash>) --->|                                      |
      |                                              |--- 5. Submit to Verity ------------->|
      |                                              |       (escrow_ref = payment hash)    |
      |                                              |       (bond locked)                  |
      |<-- 6. 200 OK + X-Verity-Submission-Id -------|                                      |
      |                                                                                     |
      |--- 7. Poll /v1/submissions/:id ---------------------------------------------------->|
      |<-- 8. Terminal verdict (verified | slashed) ----------------------------------------|
      |                                                                                     |
      |--- 9. GET /v1/submissions/:id/attestation ----------------------------------------->|
      |    - Verifies keeper ed25519 signature                                              |
      |    - Checks escrow_ref == payment tx hash                                           |
      |    - Checks claimed_output_hash == response hash                                    |
```

---

## Running the Example

### 1. Prerequisites
- Node.js >= 20
- Verity backend running locally (`pnpm dev` in the root workspace)
- A funded Stellar testnet keypair for the seller

### 2. Start the Seller
```bash
export SELLER_SECRET_KEY="S..."
export VERITY_API_URL="http://localhost:3001"
pnpm --filter @verity/example-x402-verified-api run seller
```

### 3. Run the Buyer
```bash
export VERITY_API_URL="http://localhost:3001"
export TRUSTED_KEEPER_PUBLIC_KEY="G..." # From deployments/testnet.json
pnpm --filter @verity/example-x402-verified-api run buyer
```

### 4. Simulating a Dishonest Seller (Slashing Scenario)
Start the seller with `SIMULATE_WRONG_RESULT=true`:
```bash
SIMULATE_WRONG_RESULT=true pnpm --filter @verity/example-x402-verified-api run seller
```
Run the buyer again. When re-executors replay the task, consensus will determine a mismatch. The seller will be slashed and the buyer's attestation verification will report the `slashed` verdict.
