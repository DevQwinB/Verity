import test from "node:test";
import assert from "node:assert/strict";
import { Keypair } from "@stellar/stellar-sdk";
import { VerityClient } from "./client.js";

const mockConfig = {
  deployment: "testnet",
  network_passphrase: "Test SDF Network ; September 2015",
  escrow_gate_contract_id: "CDUMMY000000000000000000000000000000000000000000000000000000",
  bond_asset: "CDUMMY000000000000000000000000000000000000000000000000000001",
  min_stake_floor: "10000000",
  quorum_min_reexecutors: 1,
  quorum_supermajority_bps: 6667,
  agent_bond_min_bps: 1000,
  challenger_bond_min_bps: 1000,
  window_tier_small_ceiling: "100000000",
  window_tier_small_s: 300,
  window_tier_large_s: 600,
  slash_split_challenger_bps: 5000,
  reexecutor_slash_bps: 2000,
  reexecutor_allowlist: false,
  reexecutor_liveness_s: 3600,
};

test("VerityClient.getConfig caches and returns config", async () => {
  const originalFetch = globalThis.fetch;
  let fetchCount = 0;
  globalThis.fetch = async (url: string | URL | Request) => {
    fetchCount++;
    assert.match(String(url), /\/v1\/config$/);
    return new Response(JSON.stringify(mockConfig), { status: 200 });
  };

  try {
    const client = new VerityClient({ apiUrl: "http://api.test" });
    const cfg1 = await client.getConfig();
    const cfg2 = await client.getConfig();

    assert.equal(cfg1.deployment, "testnet");
    assert.equal(cfg2.deployment, "testnet");
    assert.equal(fetchCount, 1, "getConfig should cache config");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("VerityClient.login with custom signer performs challenge and returns token", async () => {
  const originalFetch = globalThis.fetch;
  const kp = Keypair.random();
  let signedXdrPassed = false;

  globalThis.fetch = async (url: string | URL | Request, init?: RequestInit) => {
    const urlStr = String(url);
    if (urlStr.includes("/v1/config")) {
      return new Response(JSON.stringify(mockConfig), { status: 200 });
    }
    if (urlStr.includes("/auth?account=")) {
      return new Response(JSON.stringify({ transaction: "challenge_xdr" }), { status: 200 });
    }
    if (urlStr.endsWith("/auth") && init?.method === "POST") {
      const body = JSON.parse(String(init.body));
      if (body.transaction === "signed_challenge_xdr") {
        signedXdrPassed = true;
        return new Response(JSON.stringify({ token: "jwt-token-123" }), { status: 200 });
      }
    }
    return new Response(JSON.stringify({ error: "not found" }), { status: 404 });
  };

  try {
    const client = new VerityClient({
      apiUrl: "http://api.test",
      account: kp.publicKey(),
      signer: async (xdr, passphrase) => {
        assert.equal(xdr, "challenge_xdr");
        assert.equal(passphrase, mockConfig.network_passphrase);
        return "signed_challenge_xdr";
      },
    });

    const token = await client.login();
    assert.equal(token, "jwt-token-123");
    assert.equal(signedXdrPassed, true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("VerityClient.uploadArtifact encodes and uploads base64 content", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url: string | URL | Request, init?: RequestInit) => {
    const urlStr = String(url);
    if (urlStr.includes("/v1/config")) {
      return new Response(JSON.stringify(mockConfig), { status: 200 });
    }
    if (urlStr.includes("/auth")) {
      return new Response(JSON.stringify({ token: "token-1" }), { status: 200 });
    }
    if (urlStr.includes("/v1/artifacts")) {
      const body = JSON.parse(String(init?.body));
      const decoded = Buffer.from(body.content_base64, "base64").toString("utf8");
      return new Response(
        JSON.stringify({
          content_hash: "hash-" + decoded,
          storage_ref: "db://artifact/1",
        }),
        { status: 200 }
      );
    }
    return new Response(JSON.stringify({ error: "not found" }), { status: 404 });
  };

  try {
    const client = new VerityClient({
      apiUrl: "http://api.test",
      account: "GA...",
      signer: async () => "signed",
    });
    // Prime token
    (client as any).cachedToken = "pre-cached-token";

    const res = await client.uploadArtifact("hello artifact");
    assert.equal(res.content_hash, "hash-hello artifact");
    assert.equal(res.storage_ref, "db://artifact/1");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("VerityClient.submit uploads artifacts, signs and relays submission", async () => {
  const originalFetch = globalThis.fetch;
  let relayed = false;

  globalThis.fetch = async (url: string | URL | Request, init?: RequestInit) => {
    const urlStr = String(url);
    if (urlStr.includes("/v1/config")) {
      return new Response(JSON.stringify(mockConfig), { status: 200 });
    }
    if (urlStr.includes("/v1/artifacts")) {
      return new Response(
        JSON.stringify({
          content_hash: "artifact_hash",
          storage_ref: "db://ref",
        }),
        { status: 200 }
      );
    }
    if (urlStr.endsWith("/v1/submissions") && init?.method === "POST") {
      return new Response(
        JSON.stringify({
          submission: { id: "sub-1", status: "pending", chain_submission_id: null },
          unsigned_transaction_xdr: "unsigned_tx_xdr",
        }),
        { status: 200 }
      );
    }
    if (urlStr.includes("/v1/submissions/sub-1/relay")) {
      relayed = true;
      return new Response(
        JSON.stringify({
          submission: { id: "sub-1", status: "submitted", chain_submission_id: "42" },
          tx_hash: "tx-hash-123",
        }),
        { status: 200 }
      );
    }
    return new Response(JSON.stringify({ error: "not found" }), { status: 404 });
  };

  try {
    const client = new VerityClient({
      apiUrl: "http://api.test",
      account: "GA...",
      signer: async (xdr) => "signed_" + xdr,
    });
    (client as any).cachedToken = "token";

    const result = await client.submit({
      escrowRef: "ref-1",
      taskType: "deterministic",
      input: { a: 1 },
      claimedOutput: { b: 2 },
      functionSource: "function f() {}",
      escrowValue: "1000",
      bondAmount: "100",
    });

    assert.equal(result.id, "sub-1");
    assert.equal(result.status, "submitted");
    assert.equal(result.chainSubmissionId, "42");
    assert.equal(result.txHash, "tx-hash-123");
    assert.equal(relayed, true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("VerityClient.waitForVerdict polls until resolution", async () => {
  const originalFetch = globalThis.fetch;
  let polls = 0;

  globalThis.fetch = async (url: string | URL | Request) => {
    polls++;
    if (polls < 3) {
      return new Response(JSON.stringify({ id: "sub-1", status: "pending" }), { status: 200 });
    }
    return new Response(JSON.stringify({ id: "sub-1", status: "verified" }), { status: 200 });
  };

  try {
    const client = new VerityClient({ apiUrl: "http://api.test" });
    const result = await client.waitForVerdict("sub-1", { pollIntervalMs: 10, timeoutMs: 1000 });
    assert.equal(result.status, "verified");
    assert.equal(polls, 3);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("VerityClient.getAttestation fetches attestation endpoint", async () => {
  const originalFetch = globalThis.fetch;

  globalThis.fetch = async (url: string | URL | Request) => {
    assert.match(String(url), /\/v1\/submissions\/sub-123\/attestation$/);
    return new Response(
      JSON.stringify({
        payload: { schema: "verity.attestation.v2" },
        canonical: "{}",
        signature: "sig",
        signature_algorithm: "ed25519",
        signer: "GA...",
        issued_at: "",
      }),
      { status: 200 }
    );
  };

  try {
    const client = new VerityClient({ apiUrl: "http://api.test" });
    const att = await client.getAttestation("sub-123");
    assert.equal(att.payload.schema, "verity.attestation.v2");
  } finally {
    globalThis.fetch = originalFetch;
  }
});
