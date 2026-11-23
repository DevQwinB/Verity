import { Keypair, TransactionBuilder } from "@stellar/stellar-sdk";
import { canonicalJson } from "./canonical.js";
import type { Attestation } from "./attestation.js";

export type SignerFn = (xdr: string, networkPassphrase: string) => Promise<string>;

export interface VerityClientOptions {
  apiUrl: string;
  signer?: Keypair | SignerFn;
  account?: string;
}

export interface GateConfig {
  deployment: string;
  network_passphrase: string;
  escrow_gate_contract_id: string;
  bond_asset: string;
  min_stake_floor: string;
  quorum_min_reexecutors: number;
  quorum_supermajority_bps: number;
  agent_bond_min_bps: number;
  challenger_bond_min_bps: number;
  window_tier_small_ceiling: string;
  window_tier_small_s: number;
  window_tier_large_s: number;
  slash_split_challenger_bps: number;
  reexecutor_slash_bps: number;
  reexecutor_allowlist: boolean;
  reexecutor_liveness_s: number;
  [key: string]: unknown;
}

export interface ArtifactUploadResult {
  content_hash: string;
  storage_ref: string;
}

export interface SubmissionParams {
  escrowRef: string;
  taskType: "deterministic" | "retrieval";
  input: unknown;
  claimedOutput: unknown;
  functionSource?: string;
  spec?: { url: string; pointer?: string };
  escrowValue: string;
  bondAmount: string;
  idempotencyKey?: string;
}

export interface SubmissionResult {
  id: string;
  chainSubmissionId: string | null;
  status: string;
  txHash: string | null;
}

export class VerityClient {
  public readonly apiUrl: string;
  private signer?: SignerFn;
  private account?: string;
  private cachedToken: string | null = null;
  private cachedConfig: GateConfig | null = null;

  constructor(opts: VerityClientOptions) {
    this.apiUrl = opts.apiUrl.replace(/\/$/, "");
    if (opts.signer) {
      if (typeof opts.signer === "function") {
        this.signer = opts.signer;
        this.account = opts.account;
      } else {
        const kp = opts.signer;
        this.account = kp.publicKey();
        this.signer = async (xdr, networkPassphrase) => {
          const tx = TransactionBuilder.fromXDR(xdr, networkPassphrase);
          tx.sign(kp);
          return tx.toXDR();
        };
      }
    }
  }

  private async request<T = unknown>(
    path: string,
    opts: { token?: string; body?: unknown; method?: string } = {}
  ): Promise<T> {
    const res = await fetch(`${this.apiUrl}${path}`, {
      method: opts.method ?? (opts.body !== undefined ? "POST" : "GET"),
      headers: {
        ...(opts.body !== undefined ? { "content-type": "application/json" } : {}),
        ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}),
      },
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error(`Verity API error ${res.status} on ${path}: ${JSON.stringify(data)}`);
    }
    return data as T;
  }

  public async getConfig(): Promise<GateConfig> {
    if (!this.cachedConfig) {
      this.cachedConfig = await this.request<GateConfig>("/v1/config");
    }
    return this.cachedConfig;
  }

  public async login(): Promise<string> {
    if (!this.signer || !this.account) {
      throw new Error("Cannot login without an configured account and signer");
    }
    const cfg = await this.getConfig();
    const { transaction } = await this.request<{ transaction: string }>(
      `/auth?account=${encodeURIComponent(this.account)}`
    );
    const signedXdr = await this.signer(transaction, cfg.network_passphrase);
    const { token } = await this.request<{ token: string }>("/auth", {
      body: { transaction: signedXdr },
    });
    this.cachedToken = token;
    return token;
  }

  public async getToken(): Promise<string> {
    if (this.cachedToken) return this.cachedToken;
    return this.login();
  }

  public async uploadArtifact(content: string | Buffer): Promise<ArtifactUploadResult> {
    const token = await this.getToken();
    const base64 = Buffer.isBuffer(content)
      ? content.toString("base64")
      : Buffer.from(content, "utf8").toString("base64");
    return this.request<ArtifactUploadResult>("/v1/artifacts", {
      token,
      body: { content_base64: base64 },
    });
  }

  public async submit(params: SubmissionParams): Promise<SubmissionResult> {
    const token = await this.getToken();
    const cfg = await this.getConfig();

    const inputContent =
      params.taskType === "deterministic" ? canonicalJson(params.input) : canonicalJson(params.spec);
    const outputContent = canonicalJson(params.claimedOutput);

    const inputArtifact = await this.uploadArtifact(inputContent);
    const outputArtifact = await this.uploadArtifact(outputContent);
    const fnArtifact =
      params.taskType === "deterministic" && params.functionSource
        ? await this.uploadArtifact(params.functionSource)
        : null;

    const idempotencyKey = params.idempotencyKey ?? `sdk-${params.escrowRef}-${Date.now()}`;

    const created = await this.request<{
      submission: { id: string; status: string; chain_submission_id: string | null };
      unsigned_transaction_xdr: string | null;
      network_passphrase?: string;
    }>("/v1/submissions", {
      token,
      body: {
        escrow_ref: params.escrowRef,
        task_type: params.taskType,
        input_hash: inputArtifact.content_hash,
        input_ref: inputArtifact.storage_ref,
        claimed_output_hash: outputArtifact.content_hash,
        claimed_output_ref: outputArtifact.storage_ref,
        function_hash: fnArtifact?.content_hash,
        function_ref: fnArtifact?.storage_ref,
        escrow_value: params.escrowValue,
        bond_amount: params.bondAmount,
        idempotency_key: idempotencyKey,
      },
    });

    let txHash: string | null = null;
    let finalStatus = created.submission.status;
    let chainId = created.submission.chain_submission_id;

    if (created.unsigned_transaction_xdr) {
      if (!this.signer) {
        throw new Error("Cannot submit transaction: signer not provided to VerityClient");
      }
      const passphrase = created.network_passphrase || cfg.network_passphrase;
      const signedXdr = await this.signer(created.unsigned_transaction_xdr, passphrase);
      const relayed = await this.request<{
        submission: { id: string; status: string; chain_submission_id: string | null };
        tx_hash: string;
      }>(`/v1/submissions/${created.submission.id}/relay`, {
        token,
        body: { signed_transaction_xdr: signedXdr },
      });
      txHash = relayed.tx_hash;
      finalStatus = relayed.submission.status;
      chainId = relayed.submission.chain_submission_id;
    }

    return {
      id: created.submission.id,
      chainSubmissionId: chainId,
      status: finalStatus,
      txHash,
    };
  }

  public async getSubmission(id: string): Promise<any> {
    return this.request(`/v1/submissions/${encodeURIComponent(id)}`);
  }

  public async waitForVerdict(
    id: string,
    opts: { timeoutMs?: number; pollIntervalMs?: number } = {}
  ): Promise<any> {
    const deadline = Date.now() + (opts.timeoutMs ?? 60_000);
    const interval = opts.pollIntervalMs ?? 1_000;

    while (Date.now() < deadline) {
      const sub = await this.getSubmission(id);
      if (sub.status && sub.status !== "pending" && sub.status !== "disputed") {
        return sub;
      }
      await new Promise((r) => setTimeout(r, interval));
    }
    throw new Error(`Timeout waiting for verdict on submission ${id}`);
  }

  public async getAttestation(id: string): Promise<Attestation> {
    return this.request<Attestation>(`/v1/submissions/${encodeURIComponent(id)}/attestation`);
  }
}
