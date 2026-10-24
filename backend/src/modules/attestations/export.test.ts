import assert from "node:assert/strict";
import test from "node:test";
import { Keypair, StrKey } from "@stellar/stellar-sdk";

// export.ts imports the validated environment and the keeper at module load
// time. Set every required field before its first dynamic import; assign
// rather than default so a developer's backend/.env is never used.
const keeper = Keypair.random();
const attestor = Keypair.random();
const passphrase = "Test SDF Network ; September 2015";

Object.assign(process.env, {
  SOROBAN_RPC_URL: "https://soroban-testnet.stellar.org", // never contacted
  NETWORK_PASSPHRASE: passphrase,
  ESCROW_GATE_CONTRACT_ID: StrKey.encodeContract(Buffer.alloc(32)),
  ZK_VERIFIER_REGISTRY_CONTRACT_ID: StrKey.encodeContract(Buffer.alloc(32)),
  BOND_ASSET_CONTRACT_ID: StrKey.encodeContract(Buffer.alloc(32)),
  DATABASE_URL: "postgres://unused:unused@127.0.0.1:1/unused",
  KEEPER_SECRET_KEY: keeper.secret(),
  ATTESTATION_SIGNING_SECRET: attestor.secret(),
  JWT_SECRET: "a".repeat(32),
  WEB_AUTH_DOMAIN: "localhost:3001",
  HOME_DOMAIN: "localhost",
});

const { buildAttestationPayload, signAttestation } = await import("./export.js");
const { canonicalJson } = await import("../../chain/canonical.js");

type Submission = Parameters<typeof buildAttestationPayload>[0];
type Votes = Parameters<typeof buildAttestationPayload>[1];

const issuedAt = new Date("2026-10-24T12:00:00.000Z");

function submission(overrides: Partial<Submission> = {}): Submission {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    agent_id: Keypair.fromRawEd25519Seed(Buffer.alloc(32, 1)).publicKey(),
    escrow_ref: "escrow-1",
    chain_submission_id: "7",
    task_type: "deterministic",
    status: "verified",
    resolution_method: "reexecution_consensus",
    chain_tx_hash: "a".repeat(64),
    finalize_tx_hash: "b".repeat(64),
    ...overrides,
  };
}

const votes: Votes = [
  { stellar_account: Keypair.fromRawEd25519Seed(Buffer.alloc(32, 2)).publicKey(), match: true, tx_hash: "c".repeat(64) },
  { stellar_account: Keypair.fromRawEd25519Seed(Buffer.alloc(32, 3)).publicKey(), match: false, tx_hash: "d".repeat(64) },
];

function verifies(canonical: string, signature: string): boolean {
  return attestor.verify(Buffer.from(canonical), Buffer.from(signature, "base64"));
}

test("the payload states the schema, signer, verdict and how it was reached", () => {
  const payload = buildAttestationPayload(submission(), votes, issuedAt);
  assert.equal(payload.schema, "verity.attestation.v2");
  assert.equal(payload.network_passphrase, passphrase);
  assert.equal(payload.attestor.stellar_account, attestor.publicKey());
  assert.equal(payload.claim.verdict, "verified");
  assert.equal(payload.claim.resolution_method, "reexecution_consensus");
  assert.equal(payload.issued_at, issuedAt.toISOString());
  assert.deepEqual(
    payload.claim.attestations.map((a) => a.matched),
    [true, false]
  );
});

test("a signature verifies over the canonical JSON of the payload", () => {
  const canonical = canonicalJson(buildAttestationPayload(submission(), votes, issuedAt));
  assert.ok(verifies(canonical, signAttestation(canonical)));
});

test("the signature stops verifying once any signed field changes", () => {
  const canonical = canonicalJson(buildAttestationPayload(submission(), votes, issuedAt));
  const signature = signAttestation(canonical);

  const otherVerdict = canonicalJson(buildAttestationPayload(submission({ status: "slashed" }), votes, issuedAt));
  assert.ok(!verifies(otherVerdict, signature));

  const flippedVote: Votes = [{ ...votes[0]!, match: false }, votes[1]!];
  const otherVote = canonicalJson(buildAttestationPayload(submission(), flippedVote, issuedAt));
  assert.ok(!verifies(otherVote, signature));

  const otherTime = canonicalJson(buildAttestationPayload(submission(), votes, new Date(issuedAt.getTime() + 1)));
  assert.ok(!verifies(otherTime, signature));
});

test("the same inputs give the same canonical string and signature", () => {
  const first = canonicalJson(buildAttestationPayload(submission(), votes, issuedAt));
  const second = canonicalJson(buildAttestationPayload(submission(), votes, issuedAt));
  assert.equal(first, second);
  assert.equal(signAttestation(first), signAttestation(second));
});

test("each resolution method produces a distinct signed payload", () => {
  const methods = ["reexecution_consensus", "window_elapsed", "zk_proof"] as const;
  const canonicals = methods.map((m) =>
    canonicalJson(buildAttestationPayload(submission({ resolution_method: m }), votes, issuedAt))
  );
  assert.equal(new Set(canonicals).size, methods.length);
  assert.equal(new Set(canonicals.map(signAttestation)).size, methods.length);
});
