import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { runRetrieval, RetrievalTransientError } from "./retrieval.js";

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
