import { Keypair } from "@stellar/stellar-sdk";
import { canonicalHash, txHashToEscrowRef, verifyAttestation, AttestationResponse } from "./common.js";

export interface BuyerOptions {
  sellerUrl: string;
  verityApiUrl: string;
  trustedKeeperPublicKey: string;
  networkPassphrase?: string;
  escrowGateContractId?: string;
}

export class VerifiedBuyer {
  private sellerUrl: string;
  private verityApiUrl: string;
  private trustedKeeperPublicKey: string;
  private networkPassphrase: string;
  private escrowGateContractId: string;

  constructor(opts: BuyerOptions) {
    this.sellerUrl = opts.sellerUrl.replace(/\/$/, "");
    this.verityApiUrl = opts.verityApiUrl.replace(/\/$/, "");
    this.trustedKeeperPublicKey = opts.trustedKeeperPublicKey;
    this.networkPassphrase = opts.networkPassphrase ?? "Test SDF Network ; September 2015";
    this.escrowGateContractId = opts.escrowGateContractId ?? "";
  }

  public async requestAndVerify(
    inputText: string,
    opts: { paymentTxHash?: string; pollTimeoutMs?: number } = {}
  ) {
    console.log(`[x402 buyer] 1. Requesting paid API: ${this.sellerUrl}/api/analyze`);
    const initialRes = await fetch(`${this.sellerUrl}/api/analyze`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: inputText }),
    });

    if (initialRes.status !== 402) {
      throw new Error(`Expected HTTP 402 from seller, got ${initialRes.status}`);
    }

    const paymentSpec = await initialRes.json();
    console.log(`[x402 buyer] 2. Received 402 Payment Required:`, paymentSpec);

    // In a live integration, the buyer's wallet signs and submits an x402 payment
    // transaction to Stellar testnet. Here we use either the provided tx hash or generate
    // a deterministic testnet payment hash.
    const paymentTxHash =
      opts.paymentTxHash ??
      Buffer.from(Keypair.random().rawPublicKey()).toString("hex");

    console.log(`[x402 buyer] 3. Submitting payment tx: ${paymentTxHash}`);
    const paidRes = await fetch(`${this.sellerUrl}/api/analyze`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `x402 tx=${paymentTxHash}`,
      },
      body: JSON.stringify({ text: inputText }),
    });

    if (!paidRes.ok) {
      throw new Error(`Paid request failed: ${paidRes.status} ${await paidRes.text()}`);
    }

    const responseBody = await paidRes.json();
    const submissionId = paidRes.headers.get("x-verity-submission-id");
    const escrowRefHeader = paidRes.headers.get("x-verity-escrow-ref");

    if (!submissionId) {
      throw new Error("Seller returned paid response without X-Verity-Submission-Id header");
    }

    console.log(`[x402 buyer] 4. Received response with submission ID: ${submissionId}`);
    console.log(`[x402 buyer]    Response body:`, responseBody);

    // Ensure config details (contract ID, passphrase) are loaded
    if (!this.escrowGateContractId) {
      const cfgRes = await fetch(`${this.verityApiUrl}/v1/config`);
      const cfg = await cfgRes.json();
      this.escrowGateContractId = cfg.escrow_gate_contract_id;
      this.networkPassphrase = cfg.network_passphrase;
    }

    // 5. Poll submission until terminal
    console.log(`[x402 buyer] 5. Polling Verity submission ${submissionId} for verdict...`);
    const deadline = Date.now() + (opts.pollTimeoutMs ?? 60_000);
    let terminalSubmission: any = null;

    while (Date.now() < deadline) {
      const subRes = await fetch(`${this.verityApiUrl}/v1/submissions/${submissionId}`);
      if (subRes.ok) {
        const sub = await subRes.json();
        if (sub.status !== "pending" && sub.status !== "disputed") {
          terminalSubmission = sub;
          break;
        }
      }
      await new Promise((r) => setTimeout(r, 1000));
    }

    if (!terminalSubmission) {
      console.log(`[x402 buyer] Submission ${submissionId} still in flight or open challenge window.`);
      return {
        paidResponse: responseBody,
        submissionId,
        paymentTxHash,
        terminal: false,
      };
    }

    console.log(`[x402 buyer] 6. Terminal verdict reached: ${terminalSubmission.status}`);

    // 6. Fetch attestation and cryptographically verify
    const attRes = await fetch(`${this.verityApiUrl}/v1/submissions/${submissionId}/attestation`);
    if (!attRes.ok) {
      throw new Error(`Failed to fetch attestation: HTTP ${attRes.status}`);
    }

    const attestation: AttestationResponse = await attRes.json();
    const expectedEscrowRef = txHashToEscrowRef(paymentTxHash);
    const expectedOutputHash = canonicalHash(responseBody);

    const verification = verifyAttestation(attestation, {
      trustedSigner: this.trustedKeeperPublicKey,
      networkPassphrase: this.networkPassphrase,
      escrowGateContractId: this.escrowGateContractId,
      submissionId,
      expectedEscrowRef,
      expectedOutputHash,
    });

    console.log(`[x402 buyer] 7. Attestation verified successfully!`);
    console.log(`[x402 buyer]    Verdict: ${verification.verdict}`);
    console.log(`[x402 buyer]    Bound Escrow Ref (Payment Hash): ${verification.subject.escrow_ref}`);

    return {
      paidResponse: responseBody,
      submissionId,
      paymentTxHash,
      terminal: true,
      verdict: verification.verdict,
      verification,
    };
  }
}

if (process.argv[1]?.endsWith("buyer.ts")) {
  const sellerUrl = process.env.SELLER_URL ?? "http://localhost:4020";
  const verityApiUrl = process.env.VERITY_API_URL ?? "http://localhost:3001";
  const trustedKeeperPublicKey = process.env.TRUSTED_KEEPER_PUBLIC_KEY;

  if (!trustedKeeperPublicKey) {
    console.error("TRUSTED_KEEPER_PUBLIC_KEY environment variable required");
    process.exit(1);
  }

  const buyer = new VerifiedBuyer({
    sellerUrl,
    verityApiUrl,
    trustedKeeperPublicKey,
  });

  buyer
    .requestAndVerify("The quick brown fox jumps over the lazy dog")
    .then((result) => {
      console.log("[x402 buyer] Finished:", result);
    })
    .catch((err) => {
      console.error("[x402 buyer] Error:", err);
      process.exit(1);
    });
}
