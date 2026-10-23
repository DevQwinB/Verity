import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { isInconclusiveStatus, runRetrieval, RetrievalTransientError } from "./retrieval.js";

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

describe("runRetrieval DNS resolution", () => {
  it("rejects with RetrievalTransientError when host does not exist (.invalid TLD)", async () => {
    await assert.rejects(
      async () => {
        await runRetrieval({ url: "http://does-not-exist.invalid/" });
      },
      (err: unknown) => {
        assert(err instanceof RetrievalTransientError, `expected RetrievalTransientError, got ${String(err)}`);
        assert(/could not resolve does-not-exist\.invalid/i.test((err as Error).message));
        return true;
      }
    );
  });

  it("still throws a plain Error for private addresses and invalid protocols", async () => {
    await assert.rejects(
      async () => {
        await runRetrieval({ url: "ftp://example.com/file" });
      },
      (err: unknown) => {
        assert(!(err instanceof RetrievalTransientError), "should be a plain Error");
        assert(err instanceof Error);
        assert(/unsupported retrieval protocol/i.test(err.message));
        return true;
      }
    );

    await assert.rejects(
      async () => {
        await runRetrieval({ url: "http://127.0.0.1:8080/data" });
      },
      (err: unknown) => {
        assert(!(err instanceof RetrievalTransientError), "should be a plain Error");
        assert(err instanceof Error);
        assert(/non-public address/i.test(err.message));
        return true;
      }
    );
  });
});
