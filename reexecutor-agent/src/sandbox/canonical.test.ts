import test from "node:test";
import assert from "node:assert/strict";
import { canonicalJson, canonicalHash } from "./canonical.js";

test("canonicalJson sorts keys recursively and preserves array element order", () => {
  const input = { b: { y: 1, x: 2 }, a: [3, { d: 1, c: 2 }] };
  assert.equal(canonicalJson(input), '{"a":[3,{"c":2,"d":1}],"b":{"x":2,"y":1}}');
});

test("canonicalJson drops undefined object properties and converts NaN/Infinity/-0", () => {
  const input = { b: 1, a: [{ z: undefined, y: Number.NaN }], c: -0, d: Number.POSITIVE_INFINITY };
  assert.equal(canonicalJson(input), '{"a":[{"y":null}],"b":1,"c":0,"d":null}');

  assert.equal(canonicalJson({ negInf: Number.NEGATIVE_INFINITY }), '{"negInf":null}');
});

test("canonicalJson handles undefined at top level, in arrays, and in objects", () => {
  assert.equal(canonicalJson(undefined), "null");
  assert.equal(canonicalJson([undefined]), "[null]");
  assert.equal(canonicalJson({ u: undefined }), "{}");
});

test("canonicalJson formats primitives and escapes strings properly", () => {
  assert.equal(canonicalJson('a"b'), '"a\\"b"');
  assert.equal(canonicalJson(1.5), "1.5");
  assert.equal(canonicalJson(true), "true");
  assert.equal(canonicalJson(false), "false");
});

test("canonicalJson sorts keys in UTF-16 code unit order", () => {
  const input = { b: 1, B: 2, a: 3, "10": 1, "9": 2 };
  assert.equal(canonicalJson(input), '{"10":1,"9":2,"B":2,"a":3,"b":1}');
});

test("canonicalJson throws TypeError when serializing BigInt", () => {
  assert.throws(() => canonicalJson(1n), TypeError);
  assert.throws(() => canonicalJson({ val: 100n }), TypeError);
});

test("canonicalJson and canonicalHash are key-order independent", () => {
  const obj1 = { a: 1, b: 2, c: { d: 3, e: 4 } };
  const obj2 = { b: 2, c: { e: 4, d: 3 }, a: 1 };

  assert.equal(canonicalJson(obj1), canonicalJson(obj2));
  assert.equal(canonicalHash(obj1), canonicalHash(obj2));
});

test("canonicalHash matches independently computed golden SHA-256 digests", () => {
  const goldenVectors: Array<{ input: unknown; expectedJson: string; expectedHash: string }> = [
    {
      input: null,
      expectedJson: "null",
      expectedHash: "74234e98afe7498fb5daf1f36ac2d78acc339464f950703b8c019892f982b90b",
    },
    {
      input: {},
      expectedJson: "{}",
      expectedHash: "44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a",
    },
    {
      input: [],
      expectedJson: "[]",
      expectedHash: "4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945",
    },
    {
      input: { a: 1 },
      expectedJson: '{"a":1}',
      expectedHash: "015abd7f5cc57a2dd94b7590f04ad8084273905ee33ec5cebeae62276a97f862",
    },
    {
      input: { doubled: 42 },
      expectedJson: '{"doubled":42}',
      expectedHash: "27d4958085af3032ba46babb9e0b71690f9e2cc745ff7bb403a3d54e12152f82",
    },
    {
      input: { b: 1, a: [{ z: undefined, y: Number.NaN }], c: -0, d: Number.POSITIVE_INFINITY },
      expectedJson: '{"a":[{"y":null}],"b":1,"c":0,"d":null}',
      expectedHash: "ae6459ea2d1a080918a450c55b6daab9791024c7db75e46064a903f9e3a2c482",
    },
  ];

  for (const { input, expectedJson, expectedHash } of goldenVectors) {
    assert.equal(canonicalJson(input), expectedJson);
    assert.equal(canonicalHash(input), expectedHash);
  }
});
