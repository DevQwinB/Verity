import { Keypair } from "@stellar/stellar-sdk";
import { canonicalJson } from "./canonical.js";

export interface AttestationPayload {
  schema: string;
  network_passphrase: string;
  escrow_gate_contract_id: string;
  attestor: {
    type?: string;
    stellar_account: string;
  };
  subject: {
    agent_stellar_account?: string;
    escrow_ref?: string;
    submission_id: string;
    chain_submission_id?: string;
  };
  claim?: {
    task_type?: string;
    verdict: string;
    resolution_method?: string;
    attestations?: Array<{
      reexecutor: string;
      matched: boolean | null;
      tx_hash: string | null;
    }>;
  };
  submit_tx_hash?: string | null;
  finalize_tx_hash?: string | null;
  issued_at: string;
}

export interface Attestation {
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
}

/**
 * Verifies a Verity verdict attestation against trusted deployment parameters.
 * Throws an Error with a specific message if verification fails.
 */
export function verifyAttestation(
  att: Attestation,
  opts: VerifyAttestationOptions
): AttestationPayload {
  if (!opts.trustedSigner) {
    throw new Error("trustedSigner must be provided; never accept signer from API response as trusted");
  }

  if (att.signature_algorithm !== "ed25519") {
    throw new Error(`Unexpected signature algorithm: expected ed25519, got ${att.signature_algorithm}`);
  }

  if (att.signer !== opts.trustedSigner) {
    throw new Error(`Attestation signer ${att.signer} does not match trusted signer ${opts.trustedSigner}`);
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

  if (key.verify(Buffer.concat([message, Buffer.from(" ")]), signature)) {
    throw new Error("Tampered canonical bytes unexpectedly verified");
  }

  if (att.payload?.schema !== "verity.attestation.v2") {
    throw new Error(`Unexpected attestation schema: ${att.payload?.schema}`);
  }

  if (att.payload?.subject?.submission_id !== opts.submissionId) {
    throw new Error(
      `Attestation submission_id ${att.payload?.subject?.submission_id} does not match requested submission ${opts.submissionId}`
    );
  }

  if (att.payload?.network_passphrase !== opts.networkPassphrase) {
    throw new Error(
      `Attestation network_passphrase does not match expected network ${opts.networkPassphrase}`
    );
  }

  if (att.payload?.escrow_gate_contract_id !== opts.escrowGateContractId) {
    throw new Error(
      `Attestation escrow_gate_contract_id does not match expected contract ${opts.escrowGateContractId}`
    );
  }

  return att.payload;
}
