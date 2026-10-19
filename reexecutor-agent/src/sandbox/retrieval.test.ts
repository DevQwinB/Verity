import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { resolvePointer } from "./retrieval.js";

describe("resolvePointer", () => {
  it("returns whole document for empty pointer", () => {
    const doc = { a: 1 };
    assert.deepEqual(resolvePointer(doc, ""), doc);
  });

  it("throws for pointer without leading slash", () => {
    assert.throws(() => resolvePointer({ a: 1 }, "a"), /invalid JSON pointer: a/);
  });

  it("resolves basic object members", () => {
    assert.equal(resolvePointer({ a: 1 }, "/a"), 1);
  });

  it("does not resolve prototype properties on objects", () => {
    const doc = { a: 1 };
    assert.throws(() => resolvePointer(doc, "/constructor"), /JSON pointer \/constructor does not resolve in the response/);
    assert.throws(() => resolvePointer(doc, "/__proto__"), /JSON pointer \/__proto__ does not resolve in the response/);
    assert.throws(() => resolvePointer(doc, "/toString"), /JSON pointer \/toString does not resolve in the response/);
  });

  it("resolves own __proto__ property from JSON.parse", () => {
    const doc = JSON.parse('{"__proto__":5}');
    assert.equal(resolvePointer(doc, "/__proto__"), 5);
  });

  it("resolves valid array indices", () => {
    assert.equal(resolvePointer([1, 2], "/0"), 1);
    assert.equal(resolvePointer([1, 2], "/1"), 2);
  });

  it("rejects invalid array index tokens and length", () => {
    const arr = [1, 2];
    for (const p of ["/length", "/01", "/-", "/+1", "/1.0", "/2", "/constructor", "/__proto__"]) {
      assert.throws(
        () => resolvePointer(arr, p),
        /does not resolve in the response/,
        `expected pointer ${p} to fail`
      );
    }
  });

  it("handles RFC 6901 ~0 and ~1 unescaping correctly", () => {
    assert.equal(resolvePointer({ "a/b": 1 }, "/a~1b"), 1);
    assert.equal(resolvePointer({ "m~n": 2 }, "/m~0n"), 2);
    assert.equal(resolvePointer({ "a~/b": 3 }, "/a~0~1b"), 3);
  });

  it("throws when descending into a primitive or missing key", () => {
    assert.throws(() => resolvePointer({ a: 1 }, "/a/b"), /does not resolve in the response/);
    assert.throws(() => resolvePointer({ a: 1 }, "/b"), /does not resolve in the response/);
    assert.throws(() => resolvePointer(null, "/a"), /does not resolve in the response/);
    assert.throws(() => resolvePointer(123, "/a"), /does not resolve in the response/);
  });
});
