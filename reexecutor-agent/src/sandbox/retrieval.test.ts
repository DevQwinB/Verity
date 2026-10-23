import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { RetrievalTransientError, isInconclusiveStatus, resolvePointer, runRetrieval } from "./retrieval.js";

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
