import { Keypair } from "@stellar/stellar-sdk";
import { canonicalJson } from "./canonical-json.mjs";

/** Verifies a Verity attestation the way README.md "Verify an attestation"
 * prescribes: the signature is over the canonical bytes, the signer is pinned
 * to the deployment's keeper public key, and the payload is bound to the
 * requested submission, network and contract.
 *
 * Returns the payload on success; throws on any mismatch. `attestation` is
 * the JSON from `GET /v1/submissions/:id/attestation`. */
export function verifyAttestation(attestation, { deployment, trustedSigner, submissionId }) {
  if (attestation.signature_algorithm !== "ed25519") throw new Error("Unexpected signature algorithm");
  const signer = trustedSigner ?? deployment.keeper_public_key;
  if (!signer || attestation.signer !== signer) throw new Error("Unexpected attestation signer");
  if (typeof attestation.canonical !== "string") throw new Error("Attestation has no canonical bytes");
  if (canonicalJson(attestation.payload) !== attestation.canonical) {
    throw new Error("Attestation payload does not match the signed canonical bytes");
  }
  if (attestation.payload?.attestor?.stellar_account !== attestation.signer) {
    throw new Error("Attestation signer does not match attestor");
  }
  const key = Keypair.fromPublicKey(attestation.signer);
  const signature = Buffer.from(attestation.signature, "base64");
  const message = Buffer.from(attestation.canonical, "utf8");
  if (signature.length !== 64 || !key.verify(message, signature)) {
    throw new Error("Invalid attestation signature");
  }
  if (attestation.payload?.schema !== "verity.attestation.v2") throw new Error("Unexpected attestation schema");
  if (attestation.payload?.subject?.submission_id !== submissionId) {
    throw new Error("Attestation does not belong to the requested submission");
  }
  if (attestation.payload?.network_passphrase !== deployment.network_passphrase) {
    throw new Error("Attestation network does not match the trusted deployment");
  }
  if (attestation.payload?.escrow_gate_contract_id !== deployment.escrow_gate_contract_id) {
    throw new Error("Attestation contract does not match the trusted deployment");
  }
  return attestation.payload;
}
