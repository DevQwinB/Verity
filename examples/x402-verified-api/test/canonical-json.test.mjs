import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { canonicalJson } from "../lib/canonical-json.mjs";

describe("canonicalJson", () => {
  it("sorts object keys and drops undefined values", () => {
    assert.equal(canonicalJson({ b: 1, a: 2, c: undefined }), '{"a":2,"b":1}');
  });
  it("serialises arrays in order and nested objects recursively", () => {
    assert.equal(canonicalJson({ list: [{ y: 1, x: 2 }, 3, null] }), '{"list":[{"x":2,"y":1},3,null]}');
  });
  it("matches JSON.stringify for scalars", () => {
    assert.equal(canonicalJson("x"), '"x"');
    assert.equal(canonicalJson(1.5), "1.5");
    assert.equal(canonicalJson(null), "null");
    assert.equal(canonicalJson(undefined), "null");
    assert.equal(canonicalJson(true), "true");
  });
  it("is byte-stable for the same logical value", () => {
    const a = canonicalJson({ n: 21, nested: { z: [1, 2], a: "b" } });
    const b = canonicalJson({ nested: { a: "b", z: [1, 2] }, n: 21 });
    assert.equal(a, b);
  });
});
