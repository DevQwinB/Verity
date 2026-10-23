import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { describe, it, test } from "node:test";
import { RetrievalTransientError, hasConnectivity, isInconclusiveStatus, runRetrieval } from "./retrieval.js";

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

async function listen(): Promise<{ server: http.Server; url: string }> {
  const server = http.createServer((_req, res) => res.end("ok"));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return { server, url: `http://127.0.0.1:${port}/` };
}

function close(server: http.Server): Promise<void> {
  return new Promise((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
}

test("hasConnectivity reaches an operator-configured loopback URL", async () => {
  const { server, url } = await listen();
  try {
    assert.equal(await hasConnectivity(url), true);
  } finally {
    await close(server);
  }
});

test("hasConnectivity is false when nothing answers", async () => {
  const { server, url } = await listen();
  await close(server);
  assert.equal(await hasConnectivity(url), false);
});

test("runRetrieval still refuses a loopback target", async () => {
  const { server, url } = await listen();
  try {
    await assert.rejects(runRetrieval({ url }), /non-public address/);
  } finally {
    await close(server);
  }
});
