import test from "node:test";
import assert from "node:assert/strict";
import { Keypair, StrKey } from "@stellar/stellar-sdk";

Object.assign(process.env, {
  SOROBAN_RPC_URL: "https://soroban-testnet.stellar.org", // never contacted
  NETWORK_PASSPHRASE: "Test SDF Network ; September 2015",
  ESCROW_GATE_CONTRACT_ID: StrKey.encodeContract(Buffer.alloc(32)),
  ZK_VERIFIER_REGISTRY_CONTRACT_ID: StrKey.encodeContract(Buffer.alloc(32)),
  BOND_ASSET_CONTRACT_ID: StrKey.encodeContract(Buffer.alloc(32)),
  DATABASE_URL: "postgres://unused:unused@127.0.0.1:1/unused", // pool is lazy
  KEEPER_SECRET_KEY: Keypair.random().secret(),
  JWT_SECRET: "x".repeat(32),
  WEB_AUTH_DOMAIN: "localhost:3001",
  HOME_DOMAIN: "localhost",
});

const { assignmentSeed, rankBySeed, replayWantCount, filterEligibleReexecutors } = await import("./assignment.js");

test("assignmentSeed produces deterministic sha256 golden vector", () => {
  const seed = assignmentSeed("11111111-1111-1111-1111-111111111111", "7");
  assert.equal(seed, "0162bf36a0368e22c2d3386fd1f53f3af4fe907c8f8dc294fc3f3b95dfa004fa");
});

test("rankBySeed produces deterministic golden orderings for given seeds", () => {
  const seed1 = assignmentSeed("11111111-1111-1111-1111-111111111111", "7");
  const accounts = [
    { stellar_account: "acct-a" },
    { stellar_account: "acct-b" },
    { stellar_account: "acct-c" },
    { stellar_account: "acct-d" },
  ];

  const ranked1 = rankBySeed(seed1, accounts);
  assert.deepEqual(
    ranked1.map((r) => r.stellar_account),
    ["acct-d", "acct-a", "acct-c", "acct-b"]
  );

  const seed2 = assignmentSeed("22222222-2222-2222-2222-222222222222", "7");
  const ranked2 = rankBySeed(seed2, accounts);
  assert.deepEqual(
    ranked2.map((r) => r.stellar_account),
    ["acct-b", "acct-d", "acct-c", "acct-a"]
  );
});

test("rankBySeed is independent of input order and does not mutate input", () => {
  const seed = assignmentSeed("11111111-1111-1111-1111-111111111111", "7");
  const input = [
    { id: "1", stellar_account: "acct-c", meta: "preserve-c" },
    { id: "2", stellar_account: "acct-a", meta: "preserve-a" },
    { id: "3", stellar_account: "acct-d", meta: "preserve-d" },
    { id: "4", stellar_account: "acct-b", meta: "preserve-b" },
  ];
  const inputCopy = JSON.parse(JSON.stringify(input));

  const ranked = rankBySeed(seed, input);
  assert.deepEqual(
    ranked.map((r) => r.stellar_account),
    ["acct-d", "acct-a", "acct-c", "acct-b"]
  );

  // Assert input was not mutated
  assert.deepEqual(input, inputCopy);

  // Assert extra fields are preserved
  assert.equal(ranked[0].id, "3");
  assert.equal(ranked[0].meta, "preserve-d");
  assert.equal(ranked[1].id, "2");
  assert.equal(ranked[1].meta, "preserve-a");
});

test("rankBySeed handles empty list", () => {
  const seed = assignmentSeed("11111111-1111-1111-1111-111111111111", "7");
  const ranked = rankBySeed(seed, []);
  assert.deepEqual(ranked, []);
});

test("replayWantCount calculates seat requirements correctly", () => {
  assert.equal(replayWantCount(3, 1, 0), 4);
  assert.equal(replayWantCount(3, 1, 4), 0);
  assert.equal(replayWantCount(3, 1, 5), -1);
});

test("filterEligibleReexecutors excludes the submitting agent account when present", () => {
  const accounts = [
    { stellar_account: "agent-submitter" },
    { stellar_account: "reexecutor-1" },
    { stellar_account: "reexecutor-2" },
  ];
  const filtered = filterEligibleReexecutors(accounts, "agent-submitter");
  assert.deepEqual(
    filtered.map((r) => r.stellar_account),
    ["reexecutor-1", "reexecutor-2"]
  );
});

test("filterEligibleReexecutors preserves all accounts when excludeAgentId is not provided or not present", () => {
  const accounts = [
    { stellar_account: "reexecutor-1" },
    { stellar_account: "reexecutor-2" },
  ];
  assert.deepEqual(filterEligibleReexecutors(accounts, null), accounts);
  assert.deepEqual(filterEligibleReexecutors(accounts, undefined), accounts);
  assert.deepEqual(filterEligibleReexecutors(accounts, "nonexistent-agent"), accounts);
});

test("rankedLiveReexecutors logic with excluded agent preserves determinism among remaining eligible re-executors", () => {
  const seed = assignmentSeed("11111111-1111-1111-1111-111111111111", "7");
  const accounts = [
    { stellar_account: "acct-a" },
    { stellar_account: "acct-b" },
    { stellar_account: "acct-c" },
    { stellar_account: "acct-d" },
  ];
  // Normally ranked1 is ["acct-d", "acct-a", "acct-c", "acct-b"]
  // If acct-d is the submitting agent, the ranking among the rest should be ["acct-a", "acct-c", "acct-b"]
  const eligible = filterEligibleReexecutors(accounts, "acct-d");
  const ranked = rankBySeed(seed, eligible);
  assert.deepEqual(
    ranked.map((r) => r.stellar_account),
    ["acct-a", "acct-c", "acct-b"]
  );
});
