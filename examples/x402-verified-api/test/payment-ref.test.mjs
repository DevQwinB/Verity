import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { decodePaymentResponseHeader, escrowRefFromTxHash, settlementTxHash } from "../lib/payment-ref.mjs";

const HASH = "a".repeat(64);
const UPPER = "B".repeat(64);

describe("escrowRefFromTxHash", () => {
  it("accepts a 64-char hex hash and lowercases it", () => {
    assert.equal(escrowRefFromTxHash(UPPER), "b".repeat(64));
  });
  it("rejects anything that is not exactly 32 bytes of hex", () => {
    for (const bad of ["", "abc", "a".repeat(63), "a".repeat(65), "z".repeat(64), null, 42]) {
      assert.throws(() => escrowRefFromTxHash(bad), /not 32 bytes of hex/);
    }
  });
});

describe("settlementTxHash", () => {
  it("reads the hash from the shapes the x402 packages produce", () => {
    assert.equal(settlementTxHash({ payment: { settleResponse: { transaction: HASH } } }), HASH);
    assert.equal(settlementTxHash({ payment: { response: { transaction: HASH } } }), HASH);
    assert.equal(settlementTxHash({ payment: { transaction: HASH } }), HASH);
  });
  it("reads it from a base64 PAYMENT-RESPONSE header", () => {
    const header = Buffer.from(JSON.stringify({ transaction: HASH, network: "stellar:testnet" })).toString("base64");
    assert.equal(settlementTxHash({ paymentResponseHeader: header }), HASH);
  });
  it("returns null when no valid hash is present (fail closed)", () => {
    assert.equal(settlementTxHash({}), null);
    assert.equal(settlementTxHash({ payment: { settleResponse: { transaction: "not-a-hash" } } }), null);
    assert.equal(settlementTxHash({ paymentResponseHeader: "!!!not-base64!!!" }), null);
  });
});

describe("decodePaymentResponseHeader", () => {
  it("decodes base64 JSON and returns null for junk", () => {
    assert.deepEqual(decodePaymentResponseHeader(Buffer.from('{"transaction":"x"}').toString("base64")), { transaction: "x" });
    assert.equal(decodePaymentResponseHeader(""), null);
    assert.equal(decodePaymentResponseHeader(undefined), null);
    assert.equal(decodePaymentResponseHeader("a b c"), null);
  });
});
