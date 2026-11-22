/** The seller: an x402-protected endpoint whose every paid response is bonded
 * through EscrowGate, so a wrong response costs the seller its bond.
 *
 *   GET /compute?n=21  --$0.01 USDC (x402 exact, stellar:testnet)-->  { result }
 *
 * The route runs the `upfront` payment flow: the facilitator verifies AND
 * settles the payment BEFORE this handler runs, so the handler knows the
 * settlement transaction hash. It then uploads the artifacts and relays a
 * bonded submit() with escrow_ref = that hash, and answers with the result
 * plus an X-Verity-Submission header.
 *
 * Run with `pnpm dev` (Verity API on :3001) up, then `node seller.mjs`.
 * See README.md for what this does and does not protect. */
import express from "express";
import { Keypair } from "@stellar/stellar-sdk";
import { readFileSync } from "node:fs";
import { x402ResourceServer, x402HTTPResourceServer, HTTPFacilitatorClient } from "@x402/core/server";
import { ExpressAdapter } from "@x402/express";
import { ExactStellarScheme } from "@x402/stellar/exact/server";
import { canonicalJson } from "./lib/canonical-json.mjs";
import { escrowRefFromTxHash, settlementTxHash } from "./lib/payment-ref.mjs";
import { login, submitBonded } from "./lib/verity-api.mjs";

const SELLER_SECRET = process.env.SELLER_SECRET;
const VERITY_API = process.env.VERITY_API ?? "http://localhost:3001";
const DEPLOYMENT = process.env.DEPLOYMENT ?? "testnet";
const PORT = Number(process.env.SELLER_PORT ?? 4021);
const PRICE_USDC = process.env.PRICE_USDC ?? "$0.01";
const NETWORK = process.env.X402_NETWORK ?? "stellar:testnet";
const FACILITATOR_URL = process.env.X402_FACILITATOR_URL ?? "https://www.x402.org/facilitator";
// EscrowGate's bond asset on this deployment is XLM, so the declared value and
// bond are stroops of XLM. See README.md "What is and is not protected".
const ESCROW_VALUE_STROOPS = process.env.ESCROW_VALUE_STROOPS ?? "100000";
const BOND_STROOPS = process.env.BOND_STROOPS ?? "10000";

if (!SELLER_SECRET) throw new Error("Set SELLER_SECRET (seller's testnet key; receives the USDC and signs submit())");

// The deterministic function the re-executors replay. The paid response must
// be a pure function of the request, or the seller gets slashed for a mismatch.
const FUNCTION_SOURCE = "return { doubled: input.n * 2 };";
function compute(input) {
  return new Function("input", FUNCTION_SOURCE)(input);
}

const deployment = JSON.parse(readFileSync(new URL(`../../../deployments/${DEPLOYMENT}.json`, import.meta.url), "utf8"));
const keypair = Keypair.fromSecret(SELLER_SECRET);
const token = await login(VERITY_API, keypair, deployment.network_passphrase);
const agent = { keypair, token };
console.log(`seller agent ${keypair.publicKey()} logged in to ${VERITY_API} (deployment ${DEPLOYMENT})`);

// `upfront` settles at verify time, before the handler runs, so the handler
// can bind the Verity submission to the settlement tx hash before serving.
const routes = {
  "GET /compute": {
    accepts: [{ scheme: "exact", price: PRICE_USDC, network: NETWORK, payTo: keypair.publicKey(), paymentFlow: "upfront" }],
    description: "Deterministic compute, bonded through Verity EscrowGate",
  },
};
const httpServer = new x402HTTPResourceServer(
  new x402ResourceServer(new HTTPFacilitatorClient({ url: FACILITATOR_URL })).register(NETWORK, new ExactStellarScheme()),
  routes,
);
await httpServer.initialize();

const app = express();

app.get("/compute", async (req, res) => {
  const result = await httpServer.processHTTPRequest(new ExpressAdapter(req));

  if (result.type === "payment-error") {
    // Unpaid or invalid payment: the 402 with the payment requirements.
    res.status(result.response.status);
    for (const [key, value] of Object.entries(result.response.headers ?? {})) res.setHeader(key, String(value));
    res.send(typeof result.response.body === "string" ? result.response.body : JSON.stringify(result.response.body));
    return;
  }
  if (result.type !== "payment-verified") {
    res.status(500).json({ error: `unexpected x402 result ${result.type}` });
    return;
  }

  // Fail closed: without the settlement hash there is no escrow_ref to bind
  // the verdict to, so the paid response must not be served.
  const txHash = settlementTxHash({ payment: result.beforeHandlerSettlement ?? null });
  if (!txHash) {
    res.status(500).json({ error: "payment settled but its transaction hash could not be read; refusing to serve unbonded" });
    return;
  }
  const escrowRef = escrowRefFromTxHash(txHash);

  const n = Number(req.query.n ?? "21");
  if (!Number.isInteger(n)) {
    res.status(400).json({ error: "n must be an integer" });
    return;
  }
  const input = canonicalJson({ n });
  // WRONG=1 simulates a dishonest seller: it serves and claims an output the
  // function does not produce, so re-executors vote mismatch and the bond is
  // slashed. Used to demo the buyer's challenge path (see README.md).
  const result0 = process.env.WRONG === "1" ? { doubled: -1 } : compute({ n });
  const output = canonicalJson(result0);

  // Bond the response: the verdict on this submission is bound to the payment
  // via escrow_ref. A wrong output is replayed as a mismatch and slashes the bond.
  const submitted = await submitBonded(VERITY_API, agent, {
    escrowRef,
    taskType: "deterministic",
    functionSource: FUNCTION_SOURCE,
    input,
    claimedOutput: output,
    escrowValueStroops: ESCROW_VALUE_STROOPS,
    bondStroops: BOND_STROOPS,
    idempotencyKey: `x402-${escrowRef}`,
  });
  console.log(`paid ${PRICE_USDC} (tx ${txHash.slice(0, 12)}…) -> submission ${submitted.id} (chain #${submitted.chainId})`);

  res.setHeader("X-Verity-Submission", submitted.id);
  res.setHeader("X-Verity-Payment", txHash);
  res.json({ result: result0, submission: submitted.id });
});

app.get("/", (_req, res) => {
  res.json({ route: "GET /compute?n=<int>", price: PRICE_USDC, network: NETWORK, paymentFlow: "upfront", verity_api: VERITY_API });
});

app.listen(PORT, () => console.log(`x402 seller listening on http://localhost:${PORT}/compute (${PRICE_USDC} USDC, ${NETWORK}, upfront settle)`));
