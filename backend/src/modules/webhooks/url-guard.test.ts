import test from "node:test";
import assert from "node:assert/strict";
import { isPrivateAddress, assertPublicHttpUrl } from "./url-guard.js";
import { HttpError } from "../../http-error.js";

const IP_TEST_CASES: Array<[string, boolean]> = [
  // IPv4 Private
  ["10.0.0.1", true],
  ["127.0.0.1", true],
  ["0.0.0.0", true],
  ["169.254.169.254", true],
  ["192.168.1.1", true],
  // 172.16.0.0/12 boundaries
  ["172.15.255.255", false],
  ["172.16.0.0", true],
  ["172.31.255.255", true],
  ["172.32.0.0", false],
  ["192.167.0.1", false],
  // 100.64.0.0/10 boundaries
  ["100.63.255.255", false],
  ["100.64.0.0", true],
  ["100.127.255.255", true],
  ["100.128.0.0", false],
  // Public IPv4
  ["8.8.8.8", false],
  ["1.1.1.1", false],
  // IPv6 Private / Loopback / Link-local / ULA / IPv4-mapped
  ["::1", true],
  ["::", true],
  ["fc00::1", true],
  ["fd12::1", true],
  ["fe80::1", true],
  ["::ffff:127.0.0.1", true],
  ["::ffff:10.0.0.1", true],
  // Public IPv6
  ["2001:4860:4860::8888", false],
  ["2606:4700::1111", false],
];

test("isPrivateAddress correctly classifies IP addresses and range boundaries", () => {
  for (const [ip, expected] of IP_TEST_CASES) {
    assert.equal(
      isPrivateAddress(ip),
      expected,
      `Expected isPrivateAddress(${ip}) to be ${expected}`
    );
  }
});

test("assertPublicHttpUrl rejects unparseable URL", async () => {
  await assert.rejects(
    () => assertPublicHttpUrl("not a url"),
    (err: unknown) =>
      err instanceof HttpError &&
      err.statusCode === 400 &&
      err.message === "webhook url is not a valid URL"
  );
});

test("assertPublicHttpUrl rejects unsupported protocols", async () => {
  const unsupported = [
    ["ftp://example.com/x", "unsupported webhook protocol: ftp:"],
    ["file:///etc/passwd", "unsupported webhook protocol: file:"],
    ["javascript:alert(1)", "unsupported webhook protocol: javascript:"],
  ];

  for (const [url, expectedMessage] of unsupported) {
    await assert.rejects(
      () => assertPublicHttpUrl(url),
      (err: unknown) =>
        err instanceof HttpError &&
        err.statusCode === 400 &&
        err.message === expectedMessage
    );
  }
});

test("assertPublicHttpUrl rejects private IP literals", async () => {
  const privateUrls = [
    ["http://127.0.0.1/", "webhook host 127.0.0.1 resolves to a non-public address"],
    ["http://192.168.0.5:8080/a", "webhook host 192.168.0.5 resolves to a non-public address"],
    ["http://[::1]/", "webhook host ::1 resolves to a non-public address"],
  ];

  for (const [url, expectedMessage] of privateUrls) {
    await assert.rejects(
      () => assertPublicHttpUrl(url),
      (err: unknown) =>
        err instanceof HttpError &&
        err.statusCode === 400 &&
        err.message === expectedMessage
    );
  }
});

test("assertPublicHttpUrl accepts public IP literals without DNS lookup", async () => {
  const url = await assertPublicHttpUrl("https://8.8.8.8/hook");
  assert.equal(url.href, "https://8.8.8.8/hook");
});
