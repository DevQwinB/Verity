import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { resolvePointer } from "./retrieval.js";

describe("resolvePointer", () => {
  it("returns whole document when pointer is empty", () => {
    const doc = { a: 1, b: [2, 3] };
    assert.deepEqual(resolvePointer(doc, ""), doc);
  });

  it("throws error for pointer without a leading slash", () => {
    assert.throws(
      () => resolvePointer({ a: 1 }, "a"),
      /invalid JSON pointer/
    );
  });

  it("throws error when descending into a primitive", () => {
    assert.throws(
      () => resolvePointer({ a: 1 }, "/a/b"),
      /JSON pointer \/a\/b does not resolve in the response/
    );
  });

  it("resolves unescaped ~0 and ~1 tokens in the correct RFC 6901 order", () => {
    assert.equal(resolvePointer({ "a/b": 1 }, "/a~1b"), 1);
    assert.equal(resolvePointer({ "m~n": 2 }, "/m~0n"), 2);
    assert.equal(resolvePointer({ "x~/y": 3 }, "/x~0~1y"), 3);
  });

  it("does not resolve prototype properties on plain objects", () => {
    const doc = { a: 1 };
    for (const pointer of ["/constructor", "/__proto__", "/toString", "/valueOf"]) {
      assert.throws(
        () => resolvePointer(doc, pointer),
        /does not resolve in the response/,
        `expected ${pointer} to not resolve on plain object`
      );
    }
  });

  it("resolves own __proto__ property parsed with JSON.parse", () => {
    const doc = JSON.parse('{"__proto__": 5}');
    assert.equal(resolvePointer(doc, "/__proto__"), 5);
  });

  it("resolves valid canonical indices on arrays", () => {
    const arr = [10, 20, 30];
    assert.equal(resolvePointer(arr, "/0"), 10);
    assert.equal(resolvePointer(arr, "/1"), 20);
    assert.equal(resolvePointer(arr, "/2"), 30);
  });

  it("does not resolve length, non-canonical numbers, or out-of-range indices on arrays", () => {
    const arr = [1, 2];
    const invalidArrayPointers = ["/length", "/01", "/-", "/+1", "/1.0", "/2", "/99"];
    for (const pointer of invalidArrayPointers) {
      assert.throws(
        () => resolvePointer(arr, pointer),
        /does not resolve in the response/,
        `expected ${pointer} to not resolve on array`
      );
    }
  });
});
