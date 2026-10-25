import assert from "node:assert/strict";
import test from "node:test";
import { BUILT_TX_VALIDITY_MS, decideSupersede } from "./supersede.js";

const now = Date.parse("2026-10-25T12:00:00Z");
const ago = (ms: number) => new Date(now - ms);

test("a draft that was never relayed is rebuilt", () => {
  assert.equal(decideSupersede({ relayStartedAt: null, chainStatus: "NOT_FOUND", now }), "rebuild");
});

test("a relayed transaction that landed is kept, not rebuilt", () => {
  assert.equal(decideSupersede({ relayStartedAt: ago(1_000), chainStatus: "SUCCESS", now }), "landed");
  // Even long after the window: the submission exists on-chain regardless.
  assert.equal(decideSupersede({ relayStartedAt: ago(BUILT_TX_VALIDITY_MS * 3), chainStatus: "SUCCESS", now }), "landed");
});

test("a relayed transaction still inside its validity window is in flight", () => {
  assert.equal(decideSupersede({ relayStartedAt: ago(1_000), chainStatus: "NOT_FOUND", now }), "in_flight");
  assert.equal(decideSupersede({ relayStartedAt: ago(BUILT_TX_VALIDITY_MS - 1), chainStatus: "NOT_FOUND", now }), "in_flight");
});

test("a relayed transaction past its validity window can no longer land", () => {
  assert.equal(decideSupersede({ relayStartedAt: ago(BUILT_TX_VALIDITY_MS), chainStatus: "NOT_FOUND", now }), "rebuild");
});

test("a transaction that failed on-chain cannot land again", () => {
  assert.equal(decideSupersede({ relayStartedAt: ago(1_000), chainStatus: "FAILED", now }), "rebuild");
});
