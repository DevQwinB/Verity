import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { isInconclusiveStatus } from "./retrieval.js";

describe("isInconclusiveStatus", () => {
  it("returns true for inconclusive statuses (401, 403, 408, 429, 451, 5xx)", () => {
    const trueCases = [401, 403, 408, 429, 451, 500, 502, 503, 599];
    for (const status of trueCases) {
      assert.equal(isInconclusiveStatus(status), true, `expected status ${status} to be inconclusive`);
    }
  });

  it("returns false for definitive statuses (2xx, 3xx, non-inconclusive 4xx)", () => {
    const falseCases = [200, 204, 301, 400, 404, 410, 418];
    for (const status of falseCases) {
      assert.equal(isInconclusiveStatus(status), false, `expected status ${status} to NOT be inconclusive`);
    }
  });
});
