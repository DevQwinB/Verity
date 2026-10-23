import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { canonicalJson } from "./canonical.js";

// These vectors must stay identical across all three copies (backend, frontend, reexecutor-agent)
// as required by CONTRIBUTING.md.

const GOLDEN_VECTORS: Array<{ name: string; input: unknown; expected: string }> = [
  { name: "undefined", input: undefined, expected: "null" },
  { name: "null", input: null, expected: "null" },
  { name: "NaN", input: Number.NaN, expected: "null" },
  { name: "Infinity", input: Number.POSITIVE_INFINITY, expected: "null" },
  { name: "-0", input: -0, expected: "0" },
  {
    name: "nested object with arrays and undefined values",
    input: { b: 1, a: { d: 2, c: [3, { z: 1, y: undefined, x: null }] } },
    expected: '{"a":{"c":[3,{"x":null,"z":1}],"d":2},"b":1}',
  },
  {
    name: "UTF-16 key sorting order with numbers and case",
    input: { b: 1, a: 3, B: 2, "10": 1, "9": 2 },
    expected: '{"10":1,"9":2,"B":2,"a":3,"b":1}',
  },
  {
    name: "array with undefined and null",
    input: [undefined, 1, null],
    expected: "[null,1,null]",
  },
  {
    name: "string with newline and escaped quotes",
    input: 'é \n"x"',
    expected: '"é \\n\\"x\\""',
  },
  { name: "empty object", input: {}, expected: "{}" },
  { name: "empty array", input: [], expected: "[]" },
  { name: "object with only undefined value", input: { a: undefined }, expected: "{}" },
  {
    name: "keys with non-ascii characters (UTF-16 order)",
    input: { "é": 1, z: 2, a: 3 },
    expected: '{"a":3,"z":2,"é":1}',
  },
];

test("canonicalJson matches golden vectors", () => {
  for (const { name, input, expected } of GOLDEN_VECTORS) {
    const actual = canonicalJson(input);
    assert.equal(actual, expected, `Failed on vector: ${name}`);
  }
});

test("canonicalJson hashes match expected SHA-256 digests", () => {
  const hash1 = createHash("sha256")
    .update(canonicalJson({ b: 1, a: { d: 2, c: [3, { z: 1, y: undefined, x: null }] } }))
    .digest("hex");
  assert.equal(hash1, "c17610e9170edec56ed86af4e6e110091e79f42f7bc4460eb101ab613aeab138");

  const hash2 = createHash("sha256")
    .update(canonicalJson({ b: 1, a: 3, B: 2, "10": 1, "9": 2 }))
    .digest("hex");
  assert.equal(hash2, "99158e82efe4e49f542f73bbf83b8c783fa8fe10c452d680ca7a2e3eeb465e37");
});

test("canonicalJson rejects BigInt serialization with TypeError", () => {
  assert.throws(() => canonicalJson(1n), TypeError);
  assert.throws(() => canonicalJson({ a: 1n }), TypeError);
});

test("canonicalJson produces key-order independent output", () => {
  const obj1 = { a: 1, b: 2, c: 3 };
  const obj2 = { c: 3, a: 1, b: 2 };
  const obj3 = { b: 2, c: 3, a: 1 };
  const expected = '{"a":1,"b":2,"c":3}';

  assert.equal(canonicalJson(obj1), expected);
  assert.equal(canonicalJson(obj2), expected);
  assert.equal(canonicalJson(obj3), expected);
});

test("canonicalJson recursively sorts nested objects and objects inside arrays", () => {
  const input = {
    z: [{ b: 2, a: 1 }],
    a: { y: 2, x: 1 },
  };
  const expected = '{"a":{"x":1,"y":2},"z":[{"a":1,"b":2}]}';
  assert.equal(canonicalJson(input), expected);
});

test("canonicalJson contains no whitespace outside of string literals", () => {
  const input = { key: "value with spaces\n\tand newlines", nested: [1, 2, 3] };
  const output = canonicalJson(input);
  // Remove string literal contents and check for any remaining whitespace
  const withoutStrings = output.replace(/"(?:[^"\\]|\\.)*"/g, "");
  assert.equal(/\s/.test(withoutStrings), false);
});
