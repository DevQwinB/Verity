import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Keypair } from "@stellar/stellar-sdk";
import { canonicalJson } from "../lib/canonical-json.mjs";
import { verifyAttestation } from "../lib/attestation.mjs";

const DEPLOYMENT = {
  network_passphrase: "Test SDF Network ; September 2015",
  escrow_gate_contract_id: "C".repeat(56),
  keeper_public_key: null, // set per test
};
const SUBMISSION_ID = "00000000-0000-0000-0000-000000000001";

function makeAttestation(keypair, payloadOverrides = {}) {
  const payload = {
    schema: "verity.attestation.v2",
    network_passphrase: DEPLOYMENT.network_passphrase,
    escrow_gate_contract_id: DEPLOYMENT.escrow_gate_contract_id,
    attestor: { type: "verity-verification-layer", stellar_account: keypair.publicKey() },
    subject: { agent_stellar_account: "G" + "A".repeat(55), escrow_ref: "a".repeat(64), submission_id: SUBMISSION_ID, chain_submission_id: "1" },
    claim: { task_type: "deterministic", verdict: "verified", resolution_method: "reexecution_consensus", attestations: [] },
    submit_tx_hash: "b".repeat(64),
    finalize_tx_hash: "c".repeat(64),
    issued_at: "2026-11-22T00:00:00.000Z",
    ...payloadOverrides,
  };
  const canonical = canonicalJson(payload);
  return {
    signature_algorithm: "ed25519",
    signer: keypair.publicKey(),
    canonical,
    signature: Buffer.from(keypair.sign(Buffer.from(canonical, "utf8"))).toString("base64"),
    payload,
  };
}

describe("verifyAttestation", () => {
  it("accepts a well-formed attestation pinned to the deployment keeper", () => {
    const keeper = Keypair.random();
    const att = makeAttestation(keeper);
    const payload = verifyAttestation(att, { deployment: { ...DEPLOYMENT, keeper_public_key: keeper.publicKey() }, submissionId: SUBMISSION_ID });
    assert.equal(payload.subject.submission_id, SUBMISSION_ID);
    assert.equal(payload.subject.escrow_ref, "a".repeat(64));
  });

  it("rejects a tampered payload (canonical no longer matches)", () => {
    const keeper = Keypair.random();
    const att = makeAttestation(keeper);
    att.payload.claim.verdict = "slashed"; // tamper after signing
    assert.throws(() => verifyAttestation(att, { deployment: { ...DEPLOYMENT, keeper_public_key: keeper.publicKey() }, submissionId: SUBMISSION_ID }), /canonical/);
  });

  it("rejects a forged signature from a different key", () => {
    const keeper = Keypair.random();
    const forger = Keypair.random();
    const att = makeAttestation(forger); // signed by forger, claims forger as signer
    assert.throws(() => verifyAttestation(att, { deployment: { ...DEPLOYMENT, keeper_public_key: keeper.publicKey() }, submissionId: SUBMISSION_ID }), /signer/);
  });

  it("rejects an attestation for another submission / network / contract", () => {
    const keeper = Keypair.random();
    const dep = { ...DEPLOYMENT, keeper_public_key: keeper.publicKey() };
    assert.throws(() => verifyAttestation(makeAttestation(keeper), { deployment: dep, submissionId: "00000000-0000-0000-0000-000000000002" }), /does not belong/);
    assert.throws(
      () => verifyAttestation(makeAttestation(keeper, { network_passphrase: "Other" }), { deployment: dep, submissionId: SUBMISSION_ID }),
      /network/
    );
    assert.throws(
      () => verifyAttestation(makeAttestation(keeper, { escrow_gate_contract_id: "D".repeat(56) }), { deployment: dep, submissionId: SUBMISSION_ID }),
      /contract/
    );
  });
});
