import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  parseRetryAfter,
  RetrievalTransientError,
} from "./retrieval.js";

describe("parseRetryAfter", () => {
  it("parses numeric seconds into milliseconds", () => {
    assert.equal(parseRetryAfter("30"), 30_000);
    assert.equal(parseRetryAfter("0"), 0);
    assert.equal(parseRetryAfter("120"), 120_000);
  });

  it("parses HTTP date string into future milliseconds", () => {
    const future = new Date(Date.now() + 15_000).toUTCString();
    const parsed = parseRetryAfter(future);
    assert(parsed !== undefined && parsed > 0 && parsed <= 16_000);
  });

  it("returns undefined for undefined, empty or invalid strings", () => {
    assert.equal(parseRetryAfter(undefined), undefined);
    assert.equal(parseRetryAfter(""), undefined);
    assert.equal(parseRetryAfter("invalid-date-or-num"), undefined);
  });
});

describe("RetrievalTransientError with retryAfterMs", () => {
  it("stores and surfaces retryAfterMs", () => {
    const err = new RetrievalTransientError("rate limited", 30_000);
    assert.equal(err.message, "rate limited");
    assert.equal(err.retryAfterMs, 30_000);
  });
});
