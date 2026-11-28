import { createHash } from "node:crypto";
import { Keypair } from "@stellar/stellar-sdk";

/**
 * Returns RFC 8785-compliant canonical JSON (consistent key order, no whitespace).
 */
export function canonicalJson(value: unknown): string {
  if (value === undefined) return "null";
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).filter((k) => obj[k] !== undefined).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`).join(",")}}`;
}

/**
 * Returns the hex-encoded SHA-256 digest of the canonical JSON representation.
 */
export function canonicalHash(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value), "utf8").digest("hex");
}

/**
 * Maps a 64-character hex transaction hash (e.g. from an x402 settlement transaction)
 * into a 32-byte hex escrow_ref string expected by Verity EscrowGate.
 */
export function txHashToEscrowRef(txHashHex: string): string {
  const cleanHex = txHashHex.replace(/^0x/i, "").toLowerCase();
  if (cleanHex.length !== 64 || !/^[0-9a-f]{64}$/.test(cleanHex)) {
    throw new Error(`Invalid transaction hash hex string: expected 64 hex characters, got ${txHashHex.length}`);
  }
  return cleanHex;
}

export interface AttestationPayload {
  schema: string;
  network_passphrase: string;
  escrow_gate_contract_id: string;
  attestor: {
    stellar_account: string;
  };
  subject: {
    submission_id: string;
    chain_submission_id: string;
    escrow_ref: string;
    verdict: string;
    resolution_method: string;
    claimed_output_hash: string;
  };
}

export interface AttestationResponse {
  payload: AttestationPayload;
  canonical: string;
  signature: string;
  signature_algorithm: string;
  signer: string;
  issued_at: string;
}

export interface VerifyAttestationOptions {
  trustedSigner: string;
  networkPassphrase: string;
  escrowGateContractId: string;
  submissionId: string;
  expectedEscrowRef?: string;
  expectedOutputHash?: string;
}

/**
 * Cryptographically verifies an attestation returned by Verity's
 * `GET /v1/submissions/:id/attestation` endpoint against trusted deployment parameters.
 */
export function verifyAttestation(
  att: AttestationResponse,
  opts: VerifyAttestationOptions
): { verified: boolean; verdict: string; subject: AttestationPayload["subject"] } {
  if (att.signature_algorithm !== "ed25519") {
    throw new Error(`Unexpected signature algorithm: expected ed25519, got ${att.signature_algorithm}`);
  }

  if (att.signer !== opts.trustedSigner) {
    throw new Error(`Attestation signer ${att.signer} does not match trusted keeper signer ${opts.trustedSigner}`);
  }

  if (typeof att.canonical !== "string" || canonicalJson(att.payload) !== att.canonical) {
    throw new Error("Attestation payload does not match signed canonical bytes");
  }

  if (att.payload?.attestor?.stellar_account !== att.signer) {
    throw new Error("Attestation signer does not match payload attestor account");
  }

  const key = Keypair.fromPublicKey(att.signer);
  const signature = Buffer.from(att.signature, "base64");
  const message = Buffer.from(att.canonical, "utf8");

  if (signature.length !== 64 || !key.verify(message, signature)) {
    throw new Error("Invalid attestation signature over canonical bytes");
  }

  if (att.payload?.schema !== "verity.attestation.v2") {
    throw new Error(`Unexpected attestation schema: ${att.payload?.schema}`);
  }

  if (att.payload?.subject?.submission_id !== opts.submissionId) {
    throw new Error(`Attestation does not belong to requested submission ${opts.submissionId}`);
  }

  if (att.payload?.network_passphrase !== opts.networkPassphrase) {
    throw new Error("Attestation network does not match trusted network passphrase");
  }

  if (att.payload?.escrow_gate_contract_id !== opts.escrowGateContractId) {
    throw new Error("Attestation contract does not match trusted EscrowGate contract ID");
  }

  if (opts.expectedEscrowRef && att.payload?.subject?.escrow_ref !== opts.expectedEscrowRef) {
    throw new Error(
      `Attestation escrow_ref ${att.payload?.subject?.escrow_ref} does not match expected payment hash ${opts.expectedEscrowRef}`
    );
  }

  if (opts.expectedOutputHash && att.payload?.subject?.claimed_output_hash !== opts.expectedOutputHash) {
    throw new Error(
      `Attestation claimed_output_hash does not match expected output hash ${opts.expectedOutputHash}`
    );
  }

  return {
    verified: true,
    verdict: att.payload.subject.verdict,
    subject: att.payload.subject,
  };
}
