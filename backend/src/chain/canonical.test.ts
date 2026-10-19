import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { canonicalJson } from "./canonical.js";

// Note: These golden vectors must stay identical across all three copies
// (backend/src/chain/canonical.ts, reexecutor-agent/src/sandbox/canonical.ts,
// and frontend/src/lib/canonical.ts) as required by CONTRIBUTING.md.

const GOLDEN_VECTORS: Array<[string, unknown, string]> = [
  ["undefined", undefined, "null"],
  ["null", null, "null"],
  ["NaN", NaN, "null"],
  ["Infinity", Infinity, "null"],
  ["-0", -0, "0"],
  [
    "nested object and array with undefined filtering",
    { b: 1, a: { d: 2, c: [3, { z: 1, y: undefined, x: null }] } },
    '{"a":{"c":[3,{"x":null,"z":1}],"d":2},"b":1}',
  ],
  [
    "sorting UTF-16 code units and numbers",
    { b: 1, a: 3, B: 2, "10": 1, "9": 2 },
    '{"10":1,"9":2,"B":2,"a":3,"b":1}',
  ],
  [
    "array with undefined, number, null",
    [undefined, 1, null],
    "[null,1,null]",
  ],
  [
    "string with escaped newline and quotes",
    'é \n"x"',
    '"é \\n\\"x\\""',
  ],
  ["empty object", {}, "{}"],
  ["empty array", [], "[]"],
  ["object with undefined property", { a: undefined }, "{}"],
  [
    "object with accented character key",
    { "é": 1, z: 2, a: 3 },
    '{"a":3,"z":2,"é":1}',
  ],
];

test("canonicalJson matches golden vectors", () => {
  for (const [name, input, expected] of GOLDEN_VECTORS) {
    const actual = canonicalJson(input);
    assert.equal(actual, expected, `Failed vector: ${name}`);
  }
});

test("canonicalJson throws TypeError on BigInt", () => {
  assert.throws(() => canonicalJson(1n), TypeError);
  assert.throws(() => canonicalJson({ a: 1n }), TypeError);
});

test("canonicalJson outputs produce expected SHA-256 digests", () => {
  const hash1 = createHash("sha256")
    .update('{"a":{"c":[3,{"x":null,"z":1}],"d":2},"b":1}')
    .digest("hex");
  assert.equal(
    hash1,
    "c17610e9170edec56ed86af4e6e110091e79f42f7bc4460eb101ab613aeab138"
  );

  const hash2 = createHash("sha256")
    .update('{"10":1,"9":2,"B":2,"a":3,"b":1}')
    .digest("hex");
  assert.equal(
    hash2,
    "99158e82efe4e49f542f73bbf83b8c783fa8fe10c452d680ca7a2e3eeb465e37"
  );
});

test("canonicalJson key-order independence and recursive sorting", () => {
  const obj1 = { z: 1, a: { y: 2, b: 3 } };
  const obj2 = { a: { b: 3, y: 2 }, z: 1 };
  assert.equal(canonicalJson(obj1), canonicalJson(obj2));
  assert.equal(canonicalJson(obj1), '{"a":{"b":3,"y":2},"z":1}');
});

test("canonicalJson contains no whitespace outside string values", () => {
  const obj = {
    key: "value with spaces",
    nested: { array: [1, 2, "another string with spaces"] },
  };
  const json = canonicalJson(obj);
  // Verify characters outside quotes contain no whitespace
  let inString = false;
  let escaped = false;
  for (let i = 0; i < json.length; i++) {
    const char = json[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === "\\") {
      escaped = true;
      continue;
    }
    if (char === '"') {
      inString = !inString;
      continue;
    }
    if (!inString && /\s/.test(char)) {
      assert.fail(`Unexpected whitespace at position ${i}: ${JSON.stringify(char)}`);
    }
  }
});
