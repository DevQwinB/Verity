import assert from "node:assert/strict";
import test from "node:test";
import { Keypair, StrKey } from "@stellar/stellar-sdk";
import {
  canonicalHash,
  canonicalJson,
  txHashToEscrowRef,
  verifyAttestation,
  AttestationResponse,
} from "./common.js";
import { executeDeterministicFunction, DETERMINISTIC_FUNCTION_SOURCE } from "./seller.js";

const keeper = Keypair.random();
const client = Keypair.random();
const contractId = StrKey.encodeContract(Buffer.alloc(32));
const passphrase = "Test SDF Network ; September 2015";

test("txHashToEscrowRef converts valid 64-char hex transaction hash to 32-byte hex string", () => {
  const txHash = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
  const escrowRef = txHashToEscrowRef(txHash);
  assert.equal(escrowRef, txHash);
  assert.equal(txHashToEscrowRef(`0x${txHash}`), txHash);

  assert.throws(() => txHashToEscrowRef("invalid-hash"), /expected 64 hex characters/);
  assert.throws(() => txHashToEscrowRef("1234"), /expected 64 hex characters/);
});

test("deterministic function computes expected sentiment and count", () => {
  const result = executeDeterministicFunction({ text: "Verity verifies agent work on chain" });
  assert.equal(result.word_count, 6);
  assert.equal(result.sentiment, "positive");
  assert.equal(result.input_hash_prefix, "Verity");
});

test("verifyAttestation succeeds on valid attestation and correctly bound payment tx hash", () => {
  const submissionId = "11111111-2222-3333-4444-555555555555";
  const txHash = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
  const output = { word_count: 6, sentiment: "positive", input_hash_prefix: "Verity" };
  const outputHash = canonicalHash(output);

  const payload = {
    schema: "verity.attestation.v2",
    network_passphrase: passphrase,
    escrow_gate_contract_id: contractId,
    attestor: { stellar_account: keeper.publicKey() },
    subject: {
      submission_id: submissionId,
      chain_submission_id: "42",
      escrow_ref: txHash,
      verdict: "verified",
      resolution_method: "reexecution_consensus",
      claimed_output_hash: outputHash,
    },
  };

  const canonical = canonicalJson(payload);
  const signature = Buffer.from(keeper.sign(Buffer.from(canonical, "utf8"))).toString("base64");

  const att: AttestationResponse = {
    payload,
    canonical,
    signature,
    signature_algorithm: "ed25519",
    signer: keeper.publicKey(),
    issued_at: new Date().toISOString(),
  };

  const res = verifyAttestation(att, {
    trustedSigner: keeper.publicKey(),
    networkPassphrase: passphrase,
    escrowGateContractId: contractId,
    submissionId,
    expectedEscrowRef: txHash,
    expectedOutputHash: outputHash,
  });

  assert.equal(res.verified, true);
  assert.equal(res.verdict, "verified");
  assert.equal(res.subject.escrow_ref, txHash);
});

test("verifyAttestation rejects when payment hash does not match escrow_ref", () => {
  const submissionId = "11111111-2222-3333-4444-555555555555";
  const txHash = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
  const differentTxHash = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  const output = { word_count: 6, sentiment: "positive" };

  const payload = {
    schema: "verity.attestation.v2",
    network_passphrase: passphrase,
    escrow_gate_contract_id: contractId,
    attestor: { stellar_account: keeper.publicKey() },
    subject: {
      submission_id: submissionId,
      chain_submission_id: "42",
      escrow_ref: txHash,
      verdict: "verified",
      resolution_method: "reexecution_consensus",
      claimed_output_hash: canonicalHash(output),
    },
  };

  const canonical = canonicalJson(payload);
  const signature = Buffer.from(keeper.sign(Buffer.from(canonical, "utf8"))).toString("base64");

  const att: AttestationResponse = {
    payload,
    canonical,
    signature,
    signature_algorithm: "ed25519",
    signer: keeper.publicKey(),
    issued_at: new Date().toISOString(),
  };

  assert.throws(
    () =>
      verifyAttestation(att, {
        trustedSigner: keeper.publicKey(),
        networkPassphrase: passphrase,
        escrowGateContractId: contractId,
        submissionId,
        expectedEscrowRef: differentTxHash, // mismatched payment hash!
      }),
    /does not match expected payment hash/
  );
});

test("verifyAttestation rejects tampered canonical payload or wrong signer", () => {
  const submissionId = "11111111-2222-3333-4444-555555555555";
  const txHash = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
  const otherKeeper = Keypair.random();

  const payload = {
    schema: "verity.attestation.v2",
    network_passphrase: passphrase,
    escrow_gate_contract_id: contractId,
    attestor: { stellar_account: keeper.publicKey() },
    subject: {
      submission_id: submissionId,
      chain_submission_id: "42",
      escrow_ref: txHash,
      verdict: "verified",
      resolution_method: "reexecution_consensus",
      claimed_output_hash: canonicalHash({ ok: true }),
    },
  };

  const canonical = canonicalJson(payload);
  const signature = Buffer.from(keeper.sign(Buffer.from(canonical, "utf8"))).toString("base64");

  const att: AttestationResponse = {
    payload,
    canonical,
    signature,
    signature_algorithm: "ed25519",
    signer: keeper.publicKey(),
    issued_at: new Date().toISOString(),
  };

  // Wrong trusted signer
  assert.throws(
    () =>
      verifyAttestation(att, {
        trustedSigner: otherKeeper.publicKey(),
        networkPassphrase: passphrase,
        escrowGateContractId: contractId,
        submissionId,
      }),
    /does not match trusted keeper signer/
  );

  // Tampered payload
  const tamperedAtt: AttestationResponse = {
    ...att,
    payload: {
      ...payload,
      subject: { ...payload.subject, verdict: "slashed" },
    },
  };
  assert.throws(
    () =>
      verifyAttestation(tamperedAtt, {
        trustedSigner: keeper.publicKey(),
        networkPassphrase: passphrase,
        escrowGateContractId: contractId,
        submissionId,
      }),
    /payload does not match signed canonical bytes/
  );
});
