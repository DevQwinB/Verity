import test from "node:test";
import assert from "node:assert/strict";
import { Keypair } from "@stellar/stellar-sdk";
import { canonicalJson } from "./canonical.js";
import { verifyAttestation, type Attestation, type AttestationPayload } from "./attestation.js";

function makeValidAttestation(): {
  attestation: Attestation;
  keypair: Keypair;
  networkPassphrase: string;
  contractId: string;
  submissionId: string;
} {
  const keypair = Keypair.random();
  const submissionId = "11111111-1111-4111-8111-111111111111";
  const networkPassphrase = "Test SDF Network ; September 2015";
  const contractId = "CDUMMY000000000000000000000000000000000000000000000000000000";

  const payload: AttestationPayload = {
    schema: "verity.attestation.v2",
    network_passphrase: networkPassphrase,
    escrow_gate_contract_id: contractId,
    attestor: {
      type: "keeper",
      stellar_account: keypair.publicKey(),
    },
    subject: {
      submission_id: submissionId,
      agent_stellar_account: Keypair.random().publicKey(),
      escrow_ref: "task-123",
      chain_submission_id: "1",
    },
    claim: {
      task_type: "deterministic",
      verdict: "verified",
      resolution_method: "quorum",
      attestations: [],
    },
    submit_tx_hash: "a".repeat(64),
    finalize_tx_hash: "b".repeat(64),
    issued_at: new Date().toISOString(),
  };

  const canonical = canonicalJson(payload);
  const signatureBytes = keypair.sign(Buffer.from(canonical, "utf8"));
  const signature = Buffer.from(signatureBytes).toString("base64");

  const attestation: Attestation = {
    payload,
    canonical,
    signature,
    signature_algorithm: "ed25519",
    signer: keypair.publicKey(),
    issued_at: payload.issued_at,
  };

  return { attestation, keypair, networkPassphrase, contractId, submissionId };
}

test("verifyAttestation succeeds on valid attestation", () => {
  const { attestation, keypair, networkPassphrase, contractId, submissionId } = makeValidAttestation();
  const verified = verifyAttestation(attestation, {
    trustedSigner: keypair.publicKey(),
    networkPassphrase,
    escrowGateContractId: contractId,
    submissionId,
  });

  assert.equal(verified.schema, "verity.attestation.v2");
  assert.equal(verified.subject.submission_id, submissionId);
  assert.equal(verified.claim?.verdict, "verified");
});

test("verifyAttestation throws if trustedSigner is missing", () => {
  const { attestation, networkPassphrase, contractId, submissionId } = makeValidAttestation();
  assert.throws(
    () =>
      verifyAttestation(attestation, {
        trustedSigner: "",
        networkPassphrase,
        escrowGateContractId: contractId,
        submissionId,
      }),
    /trustedSigner must be provided/
  );
});

test("verifyAttestation throws if signature algorithm is not ed25519", () => {
  const { attestation, keypair, networkPassphrase, contractId, submissionId } = makeValidAttestation();
  attestation.signature_algorithm = "secp256k1";
  assert.throws(
    () =>
      verifyAttestation(attestation, {
        trustedSigner: keypair.publicKey(),
        networkPassphrase,
        escrowGateContractId: contractId,
        submissionId,
      }),
    /Unexpected signature algorithm/
  );
});

test("verifyAttestation throws if signer does not match trustedSigner", () => {
  const { attestation, networkPassphrase, contractId, submissionId } = makeValidAttestation();
  const otherSigner = Keypair.random().publicKey();
  assert.throws(
    () =>
      verifyAttestation(attestation, {
        trustedSigner: otherSigner,
        networkPassphrase,
        escrowGateContractId: contractId,
        submissionId,
      }),
    /does not match trusted signer/
  );
});

test("verifyAttestation throws if payload is tampered after canonicalization", () => {
  const { attestation, keypair, networkPassphrase, contractId, submissionId } = makeValidAttestation();
  attestation.payload.claim!.verdict = "rejected"; // tampered payload
  assert.throws(
    () =>
      verifyAttestation(attestation, {
        trustedSigner: keypair.publicKey(),
        networkPassphrase,
        escrowGateContractId: contractId,
        submissionId,
      }),
    /Attestation payload does not match signed canonical bytes/
  );
});

test("verifyAttestation throws if canonical bytes are tampered", () => {
  const { attestation, keypair, networkPassphrase, contractId, submissionId } = makeValidAttestation();
  attestation.canonical = attestation.canonical + " ";
  assert.throws(
    () =>
      verifyAttestation(attestation, {
        trustedSigner: keypair.publicKey(),
        networkPassphrase,
        escrowGateContractId: contractId,
        submissionId,
      }),
    /Attestation payload does not match signed canonical bytes/
  );
});

test("verifyAttestation throws if attestor account does not match signer", () => {
  const { attestation, keypair, networkPassphrase, contractId, submissionId } = makeValidAttestation();
  attestation.payload.attestor.stellar_account = Keypair.random().publicKey();
  attestation.canonical = canonicalJson(attestation.payload);
  attestation.signature = Buffer.from(keypair.sign(Buffer.from(attestation.canonical, "utf8"))).toString("base64");

  assert.throws(
    () =>
      verifyAttestation(attestation, {
        trustedSigner: keypair.publicKey(),
        networkPassphrase,
        escrowGateContractId: contractId,
        submissionId,
      }),
    /Attestation signer does not match payload attestor account/
  );
});

test("verifyAttestation throws if signature is invalid", () => {
  const { attestation, keypair, networkPassphrase, contractId, submissionId } = makeValidAttestation();
  // Tamper signature by signing with another key
  const rogueKey = Keypair.random();
  attestation.signature = Buffer.from(rogueKey.sign(Buffer.from(attestation.canonical, "utf8"))).toString("base64");

  assert.throws(
    () =>
      verifyAttestation(attestation, {
        trustedSigner: keypair.publicKey(),
        networkPassphrase,
        escrowGateContractId: contractId,
        submissionId,
      }),
    /Invalid attestation signature/
  );
});

test("verifyAttestation throws on invalid schema", () => {
  const { attestation, keypair, networkPassphrase, contractId, submissionId } = makeValidAttestation();
  attestation.payload.schema = "verity.attestation.v1";
  attestation.canonical = canonicalJson(attestation.payload);
  attestation.signature = Buffer.from(keypair.sign(Buffer.from(attestation.canonical, "utf8"))).toString("base64");

  assert.throws(
    () =>
      verifyAttestation(attestation, {
        trustedSigner: keypair.publicKey(),
        networkPassphrase,
        escrowGateContractId: contractId,
        submissionId,
      }),
    /Unexpected attestation schema/
  );
});

test("verifyAttestation throws if submission_id mismatch", () => {
  const { attestation, keypair, networkPassphrase, contractId } = makeValidAttestation();
  assert.throws(
    () =>
      verifyAttestation(attestation, {
        trustedSigner: keypair.publicKey(),
        networkPassphrase,
        escrowGateContractId: contractId,
        submissionId: "22222222-2222-4222-8222-222222222222",
      }),
    /does not match requested submission/
  );
});

test("verifyAttestation throws if network_passphrase mismatch", () => {
  const { attestation, keypair, contractId, submissionId } = makeValidAttestation();
  assert.throws(
    () =>
      verifyAttestation(attestation, {
        trustedSigner: keypair.publicKey(),
        networkPassphrase: "Public Global Stellar Network ; September 2015",
        escrowGateContractId: contractId,
        submissionId,
      }),
    /does not match expected network/
  );
});

test("verifyAttestation throws if escrow_gate_contract_id mismatch", () => {
  const { attestation, keypair, networkPassphrase, submissionId } = makeValidAttestation();
  assert.throws(
    () =>
      verifyAttestation(attestation, {
        trustedSigner: keypair.publicKey(),
        networkPassphrase,
        escrowGateContractId: "CDIFFERENT0000000000000000000000000000000000000000000000000",
        submissionId,
      }),
    /does not match expected contract/
  );
});
