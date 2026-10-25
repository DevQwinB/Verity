import test from "node:test";
import assert from "node:assert/strict";
import { NO_OUTPUT_HASH, voteMatches } from "./vote.js";

const h = (c: string) => c.repeat(64);

test("a reproduced output that equals the claim matches", () => {
  assert.equal(voteMatches(h("a"), h("a")), true);
});

test("a reproduced output that differs from the claim is a mismatch", () => {
  assert.equal(voteMatches(h("a"), h("b")), false);
});

test("failing to reproduce the work is a mismatch", () => {
  assert.equal(voteMatches(NO_OUTPUT_HASH, h("a")), false);
});

test("failing to reproduce the work is a mismatch even if the claim is the zero hash", () => {
  assert.equal(voteMatches(NO_OUTPUT_HASH, NO_OUTPUT_HASH), false);
});
