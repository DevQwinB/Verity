import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { runRetrieval, RetrievalTransientError } from "./retrieval.js";

describe("runRetrieval DNS resolution", () => {
  it("rejects with RetrievalTransientError when host does not exist", async () => {
    await assert.rejects(
      async () => {
        await runRetrieval({ url: "http://does-not-exist.invalid/" });
      },
      (err: unknown) => {
        assert(err instanceof RetrievalTransientError);
        assert.match((err as Error).message, /could not resolve does-not-exist\.invalid/);
        return true;
      }
    );
  });

  it("rejects with plain Error for private-address target", async () => {
    await assert.rejects(
      async () => {
        await runRetrieval({ url: "http://127.0.0.1:8080/" });
      },
      (err: unknown) => {
        assert(!(err instanceof RetrievalTransientError));
        assert(err instanceof Error);
        assert.match(err.message, /resolves to a non-public address/);
        return true;
      }
    );
  });

  it("rejects with plain Error for unsupported protocol", async () => {
    await assert.rejects(
      async () => {
        await runRetrieval({ url: "ftp://example.com/" });
      },
      (err: unknown) => {
        assert(!(err instanceof RetrievalTransientError));
        assert(err instanceof Error);
        assert.match(err.message, /unsupported retrieval protocol/);
        return true;
      }
    );
  });
});
