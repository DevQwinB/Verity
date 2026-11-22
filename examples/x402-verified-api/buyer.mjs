/** The buyer: pays for one call with x402, then verifies the Verity verdict
 * before trusting the response.
 *
 *   1. GET /compute?n=21            -> 402 + payment requirements
 *   2. build + sign the USDC payment (X-PAYMENT header), retry
 *   3. 200 + X-Verity-Submission    -> poll GET /v1/submissions/:id to terminal
 *   4. GET /v1/submissions/:id/attestation, verify signature + binding
 *   5. check payload.subject.escrow_ref === the x402 settlement tx hash
 *
 * Run with the seller up: `node buyer.mjs`. Exits non-zero if the verdict is
 * not "verified" or the escrow_ref does not match the payment. */
import { Transaction, TransactionBuilder, Keypair } from "@stellar/stellar-sdk";
import { readFileSync } from "node:fs";
import { x402Client, x402HTTPClient } from "@x402/fetch";
import { createEd25519Signer, getNetworkPassphrase } from "@x402/stellar";
import { ExactStellarScheme } from "@x402/stellar/exact/client";
import { escrowRefFromTxHash, settlementTxHash } from "./lib/payment-ref.mjs";
import { verifyAttestation } from "./lib/attestation.mjs";
import { getAttestation, waitForVerdict } from "./lib/verity-api.mjs";

const BUYER_SECRET = process.env.BUYER_SECRET;
const SELLER_URL = process.env.SELLER_URL ?? "http://localhost:4021";
const VERITY_API = process.env.VERITY_API ?? "http://localhost:3001";
const DEPLOYMENT = process.env.DEPLOYMENT ?? "testnet";
const NETWORK = process.env.X402_NETWORK ?? "stellar:testnet";
const RPC_URL = process.env.STELLAR_RPC_URL ?? "https://soroban-testnet.stellar.org";
const N = process.env.N ?? "21";

if (!BUYER_SECRET) throw new Error("Set BUYER_SECRET (a funded testnet account with a USDC trustline)");

const deployment = JSON.parse(readFileSync(new URL(`../../../deployments/${DEPLOYMENT}.json`, import.meta.url), "utf8"));
const url = `${SELLER_URL.replace(/\/$/, "")}/compute?n=${encodeURIComponent(N)}`;

const signer = createEd25519Signer(BUYER_SECRET, NETWORK);
const client = new x402Client().register("stellar:*", new ExactStellarScheme(signer, { url: RPC_URL }));
const httpClient = new x402HTTPClient(client);

console.log(`buyer ${signer.address} -> ${url}`);

// 1. Unpaid request: expect 402 with the payment requirements.
const firstTry = await fetch(url);
if (firstTry.status !== 402) throw new Error(`expected 402, got ${firstTry.status}`);
const paymentRequired = httpClient.getPaymentRequiredResponse((name) => firstTry.headers.get(name));

// 2. Build the payment payload; keep the facilitator's 1-stroop fee fix from
//    the Stellar quickstart (testnet facilitator limit).
let paymentPayload = await client.createPaymentPayload(paymentRequired);
const networkPassphrase = getNetworkPassphrase(NETWORK);
const tx = new Transaction(paymentPayload.payload.transaction, networkPassphrase);
const envelope = tx.toEnvelope();
if (envelope.type !== "envelopeTypeTx") throw new Error("expected a v1 transaction envelope");
const txExt = envelope.value.tx.ext;
const sorobanData = txExt.type === "sorobanData" ? txExt.value : undefined;
if (sorobanData) {
  paymentPayload = {
    ...paymentPayload,
    payload: {
      ...paymentPayload.payload,
      transaction: TransactionBuilder.cloneFrom(tx, { fee: "1", sorobanData, networkPassphrase }).build().toXDR(),
    },
  };
}
const paymentHeaders = httpClient.encodePaymentSignatureHeader(paymentPayload);

// 3. Paid request.
const paid = await fetch(url, { headers: paymentHeaders });
if (paid.status !== 200) throw new Error(`paid request returned ${paid.status}: ${await paid.text()}`);
const body = await paid.json();
const settleResponse = httpClient.getPaymentSettleResponse((name) => paid.headers.get(name));
const txHash = settlementTxHash({
  payment: settleResponse,
  paymentResponseHeader: paid.headers.get("PAYMENT-RESPONSE") ?? paid.headers.get("X-PAYMENT-RESPONSE"),
});
if (!txHash) throw new Error("settled, but no transaction hash in the payment response");
const escrowRef = escrowRefFromTxHash(txHash);
console.log(`paid; settlement tx ${txHash}`);
console.log(`seller response: ${JSON.stringify(body)}`);

const submissionId = paid.headers.get("X-Verity-Submission") ?? body.submission;
if (!submissionId) throw new Error("seller did not return a Verity submission id");

// 4. Wait for the verdict, then verify the attestation and the payment binding.
console.log(`polling submission ${submissionId} for a terminal verdict…`);
const verdict = await waitForVerdict(VERITY_API, submissionId);
console.log(`verdict: ${verdict.status} (${verdict.resolution_method ?? "-"})`);

const attestation = await getAttestation(VERITY_API, submissionId);
const payload = verifyAttestation(attestation, {
  deployment,
  trustedSigner: process.env.TRUSTED_KEEPER_PUBLIC_KEY,
  submissionId,
});
if (payload.subject.escrow_ref !== escrowRef) {
  throw new Error(`attestation escrow_ref ${payload.subject.escrow_ref} does not match the payment ${escrowRef}`);
}
console.log("attestation verified: signer pinned, escrow_ref matches the x402 settlement tx");

const explorer = `https://stellar.expert/explorer/testnet/tx/${txHash}`;
console.log(`payment:   ${explorer}`);
if (payload.finalize_tx_hash) console.log(`finalize:  https://stellar.expert/explorer/testnet/tx/${payload.finalize_tx_hash}`);

if (verdict.status !== "verified") {
  console.error(`verdict is ${verdict.status}, not verified — treat the paid response as untrusted`);
  process.exit(1);
}
console.log(`OK: paid response verified by Verity (escrow_ref bound to ${escrowRef.slice(0, 16)}…)`);
