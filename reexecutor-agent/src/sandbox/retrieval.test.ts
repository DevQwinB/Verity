import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { isInconclusiveStatus } from "./retrieval.js";

describe("isInconclusiveStatus", () => {
  const testCases: Array<{ status: number; expected: boolean }> = [
    // Inconclusive statuses specified by the issue
    { status: 401, expected: true },
    { status: 403, expected: true },
    { status: 408, expected: true },
    { status: 429, expected: true },
    { status: 451, expected: true },
    { status: 500, expected: true },
    { status: 502, expected: true },
    { status: 503, expected: true },
    { status: 599, expected: true },

    // Definitive non-inconclusive statuses
    { status: 200, expected: false },
    { status: 204, expected: false },
    { status: 301, expected: false },
    { status: 400, expected: false },
    { status: 404, expected: false },
    { status: 410, expected: false },
    { status: 418, expected: false },
  ];

  for (const { status, expected } of testCases) {
    it(`returns ${expected} for HTTP ${status}`, () => {
      assert.equal(isInconclusiveStatus(status), expected);
    });
  }
});
