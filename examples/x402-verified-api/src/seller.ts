import http from "node:http";
import { Keypair, TransactionBuilder } from "@stellar/stellar-sdk";
import { canonicalJson, txHashToEscrowRef } from "./common.js";

export const DETERMINISTIC_FUNCTION_SOURCE = `
const words = String(input.text || "").trim().split(/\\s+/).filter(Boolean);
return {
  word_count: words.length,
  sentiment: words.length % 2 === 0 ? "positive" : "neutral",
  input_hash_prefix: words[0] || "empty"
};
`;

export interface SellerOptions {
  port?: number;
  sellerKeypair: Keypair;
  verityApiUrl: string;
  simulateWrongResult?: boolean;
}

export function executeDeterministicFunction(input: { text: string }): Record<string, unknown> {
  const words = String(input.text || "").trim().split(/\s+/).filter(Boolean);
  return {
    word_count: words.length,
    sentiment: words.length % 2 === 0 ? "positive" : "neutral",
    input_hash_prefix: words[0] || "empty",
  };
}

export class VerifiedSeller {
  private server: http.Server | null = null;
  private sellerKeypair: Keypair;
  private verityApiUrl: string;
  private simulateWrongResult: boolean;
  private token: string | null = null;

  constructor(opts: SellerOptions) {
    this.sellerKeypair = opts.sellerKeypair;
    this.verityApiUrl = opts.verityApiUrl.replace(/\/$/, "");
    this.simulateWrongResult = opts.simulateWrongResult ?? false;
  }

  private async callBackend<T = any>(
    path: string,
    opts: { token?: string; body?: unknown; method?: string } = {}
  ): Promise<T> {
    const res = await fetch(`${this.verityApiUrl}${path}`, {
      method: opts.method ?? (opts.body !== undefined ? "POST" : "GET"),
      headers: {
        ...(opts.body !== undefined ? { "content-type": "application/json" } : {}),
        ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}),
      },
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`${path} -> ${res.status}: ${JSON.stringify(data)}`);
    return data as T;
  }

  private async login(): Promise<string> {
    const cfg = await this.callBackend<{ network_passphrase: string }>("/v1/config");
    const { transaction } = await this.callBackend<{ transaction: string }>(
      `/auth?account=${this.sellerKeypair.publicKey()}`
    );
    const tx = TransactionBuilder.fromXDR(transaction, cfg.network_passphrase);
    tx.sign(this.sellerKeypair);
    const { token } = await this.callBackend<{ token: string }>("/auth", {
      body: { transaction: tx.toXDR() },
    });
    this.token = token;
    return token;
  }

  private async uploadArtifact(content: string): Promise<{ content_hash: string; storage_ref: string }> {
    if (!this.token) await this.login();
    return this.callBackend("/v1/artifacts", {
      token: this.token!,
      body: { content_base64: Buffer.from(content).toString("base64") },
    });
  }

  public async bondAndSubmit(
    paymentTxHash: string,
    inputData: { text: string },
    resultData: Record<string, unknown>
  ): Promise<string> {
    if (!this.token) await this.login();
    const cfg = await this.callBackend<{
      network_passphrase: string;
      agent_bond_min_bps: number;
    }>("/v1/config");

    const inputJson = canonicalJson(inputData);
    const outputJson = canonicalJson(resultData);

    const input = await this.uploadArtifact(inputJson);
    const fn = await this.uploadArtifact(DETERMINISTIC_FUNCTION_SOURCE);
    const output = await this.uploadArtifact(outputJson);

    const escrowRef = txHashToEscrowRef(paymentTxHash);
    const idempotencyKey = `x402-${escrowRef}`;

    // Price: 1 XLM = 10_000_000 stroops, bond floor at agent_bond_min_bps
    const escrowValue = "10000000";
    const bondAmount = "500000"; // 5% minimum bond

    const created = await this.callBackend<{
      submission: { id: string };
      unsigned_transaction_xdr: string | null;
      network_passphrase: string;
    }>("/v1/submissions", {
      token: this.token!,
      body: {
        escrow_ref: escrowRef,
        task_type: "deterministic",
        input_hash: input.content_hash,
        input_ref: input.storage_ref,
        claimed_output_hash: output.content_hash,
        claimed_output_ref: output.storage_ref,
        function_hash: fn.content_hash,
        function_ref: fn.storage_ref,
        escrow_value: escrowValue,
        bond_amount: bondAmount,
        idempotency_key: idempotencyKey,
      },
    });

    if (created.unsigned_transaction_xdr) {
      const tx = TransactionBuilder.fromXDR(
        created.unsigned_transaction_xdr,
        created.network_passphrase || cfg.network_passphrase
      );
      tx.sign(this.sellerKeypair);
      await this.callBackend(`/v1/submissions/${created.submission.id}/relay`, {
        token: this.token!,
        body: { signed_transaction_xdr: tx.toXDR() },
      });
    }

    return created.submission.id;
  }

  public start(port = 4020): Promise<number> {
    return new Promise((resolve) => {
      this.server = http.createServer(async (req, res) => {
        if (req.method !== "POST" || req.url !== "/api/analyze") {
          res.writeHead(404, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: "not found" }));
          return;
        }

        const authHeader = req.headers.authorization;
        const authMatch = authHeader?.match(/^x402\s+tx=([a-fA-F0-9]{64})/i);

        if (!authMatch) {
          // HTTP 402 Payment Required specification
          res.writeHead(402, {
            "content-type": "application/json",
            "x-payment-required": "stellar:testnet",
          });
          res.end(
            JSON.stringify({
              status: 402,
              detail: "x402 Payment Required",
              scheme: "exact",
              network: "stellar:testnet",
              asset: "USDC",
              amount: "1.00",
              destination: this.sellerKeypair.publicKey(),
              description: "Deterministic text sentiment analysis API",
            })
          );
          return;
        }

        const paymentTxHash = authMatch[1];
        let bodyText = "";
        for await (const chunk of req) {
          bodyText += chunk;
        }

        let inputJson: { text: string };
        try {
          inputJson = JSON.parse(bodyText);
        } catch {
          res.writeHead(400, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: "Invalid JSON input" }));
          return;
        }

        try {
          // Compute true deterministic result
          const trueResult = executeDeterministicFunction(inputJson);
          const resultToSend = this.simulateWrongResult
            ? { ...trueResult, word_count: 999999, sentiment: "fraudulent" }
            : trueResult;

          // Bond and submit to Verity
          const submissionId = await this.bondAndSubmit(paymentTxHash, inputJson, resultToSend);

          res.writeHead(200, {
            "content-type": "application/json",
            "x-verity-submission-id": submissionId,
            "x-verity-escrow-ref": txHashToEscrowRef(paymentTxHash),
          });
          res.end(JSON.stringify(resultToSend));
        } catch (err) {
          res.writeHead(500, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }));
        }
      });

      this.server.listen(port, () => {
        const addr = this.server?.address();
        const actualPort = typeof addr === "object" && addr ? addr.port : port;
        resolve(actualPort);
      });
    });
  }

  public stop(): Promise<void> {
    return new Promise((resolve) => {
      if (this.server) {
        this.server.close(() => resolve());
      } else {
        resolve();
      }
    });
  }
}

if (process.argv[1]?.endsWith("seller.ts")) {
  const secret = process.env.SELLER_SECRET_KEY;
  if (!secret) {
    console.error("SELLER_SECRET_KEY environment variable required");
    process.exit(1);
  }
  const sellerKeypair = Keypair.fromSecret(secret);
  const verityApiUrl = process.env.VERITY_API_URL ?? "http://localhost:3001";
  const simulateWrong = process.env.SIMULATE_WRONG_RESULT === "true";
  const seller = new VerifiedSeller({
    sellerKeypair,
    verityApiUrl,
    simulateWrongResult: simulateWrong,
  });
  const port = Number(process.env.PORT ?? 4020);
  seller.start(port).then((actualPort) => {
    console.log(`[x402 seller] Listening on http://localhost:${actualPort}/api/analyze`);
    console.log(`[x402 seller] Public key: ${sellerKeypair.publicKey()}`);
    console.log(`[x402 seller] Mode: ${simulateWrong ? "FRAUDULENT (deliberately wrong result)" : "HONEST"}`);
  });
}
