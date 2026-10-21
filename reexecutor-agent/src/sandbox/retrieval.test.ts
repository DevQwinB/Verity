import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { hasConnectivity, runRetrieval } from "./retrieval.js";

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
