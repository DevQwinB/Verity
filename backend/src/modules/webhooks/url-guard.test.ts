import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { isPrivateAddress, assertPublicHttpUrl, resolvePublicTarget } from "./url-guard.js";
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
  // Ranges the first version of the guard missed
  ["198.17.255.255", false],
  ["198.18.0.1", true],
  ["198.19.255.255", true],
  ["198.20.0.0", false],
  ["224.0.0.1", true],
  ["239.255.255.250", true],
  ["240.0.0.1", true],
  ["255.255.255.255", true],
  ["192.0.2.1", true],
  ["203.0.113.9", true],
  ["fec0::1", true],
  ["febf::1", true],
  ["ff02::1", true],
  ["2001:db8::1", true],
  ["100::1", true],
  // IPv4 carried inside IPv6: judged by the IPv4 address inside
  ["::ffff:7f00:1", true],
  ["::ffff:a00:1", true],
  ["::ffff:c0a8:101", true],
  ["::ffff:a9fe:a9fe", true],
  ["::ffff:808:808", false],
  ["::ffff:8.8.8.8", false],
  ["0:0:0:0:0:ffff:7f00:1", true],
  ["64:ff9b::7f00:1", true],
  ["64:ff9b::a9fe:a9fe", true],
  ["64:ff9b::808:808", false],
  ["2002:7f00:1::", true],
  ["2002:808:808::", false],
  ["::8.8.8.8", true],
  // Malformed input is never public
  ["not-an-ip", true],
  ["1:2:3:4:5:6:7:8:9", true],
  ["1::2::3", true],
  ["", true],
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

test("resolvePublicTarget returns the checked address for the request to connect to", async () => {
  const target = await resolvePublicTarget("https://8.8.4.4:8443/hook");
  assert.equal(target.address, "8.8.4.4");
  assert.equal(target.family, 4);
  assert.equal(target.url.href, "https://8.8.4.4:8443/hook");

  const v6 = await resolvePublicTarget("http://[2606:4700::1111]/hook");
  assert.equal(v6.address, "2606:4700::1111");
  assert.equal(v6.family, 6);
});

test("resolvePublicTarget rejects IPv4 hidden in IPv6 literals", async () => {
  for (const url of ["http://[::ffff:7f00:1]/", "http://[::ffff:169.254.169.254]/", "http://[64:ff9b::a9fe:a9fe]/"]) {
    await assert.rejects(
      () => resolvePublicTarget(url),
      (err: unknown) => err instanceof HttpError && err.statusCode === 400 && /non-public/.test(err.message),
      url
    );
  }
});

// The README is the operator-facing contract for the URL guard: every CIDR it
// names must be present in both guard implementations (backend webhooks and
// re-executor retrieval), and the stale "does not cover every non-public
// range" wording must stay gone.
test("README-documented blocked ranges match url-guard.ts and sandbox/address.ts", () => {
  const repoRoot = new URL("../../../../", import.meta.url);
  const readme = readFileSync(new URL("README.md", repoRoot), "utf8");
  const backendGuard = readFileSync(new URL("./url-guard.ts", import.meta.url), "utf8");
  const agentGuard = readFileSync(
    new URL("../../../../reexecutor-agent/src/sandbox/address.ts", import.meta.url),
    "utf8"
  );

  assert.ok(!readme.includes("do not cover every non-public"), "stale README wording must stay removed");

  const ipv4 = readme.match(/\b(?:\d{1,3}\.){3}\d{1,3}\/\d{1,2}\b/g) ?? [];
  const ipv6 = readme.match(/(?<![0-9a-f:])(?:[0-9a-f]{0,4}:){2,}[0-9a-f]{0,4}\/\d{1,3}(?!\d)/gi) ?? [];
  const cidrs = [...new Set([...ipv4, ...ipv6])];
  // The README's "Webhooks" section must name the full non-public table.
  assert.ok(cidrs.length >= 23, `expected >= 23 CIDRs documented in README, got ${cidrs.length}: ${cidrs}`);

  for (const cidr of cidrs) {
    const slash = cidr.indexOf("/");
    const net = cidr.slice(0, slash);
    const prefix = cidr.slice(slash + 1);
    // Sources store subnets as ["net", prefix] pairs.
    const entry = `"${net}", ${prefix}`;
    assert.ok(backendGuard.includes(entry), `url-guard.ts is missing README range ${cidr}`);
    assert.ok(agentGuard.includes(entry), `sandbox/address.ts is missing README range ${cidr}`);
  }
});

// Boundary sweep derived from the README-documented CIDRs: the first and last
// address of every documented range must be refused by isPrivateAddress, and
// the address immediately after a range must be public unless it falls inside
// another documented range.
function expandIpv6(ip: string): bigint {
  let text = ip.toLowerCase();
  const halves = text.split("::");
  const head = halves[0] ? halves[0].split(":") : [];
  const rest = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const missing = 8 - head.length - rest.length;
  const groups = [...head, ...Array<string>(halves.length === 2 ? missing : 0).fill("0"), ...rest];
  let value = 0n;
  for (const g of groups) value = (value << 16n) | BigInt(parseInt(g, 16));
  return value;
}

function formatIpv6(value: bigint): string {
  const groups: string[] = [];
  for (let i = 7; i >= 0; i--) {
    groups.push(((value >> BigInt(16 * i)) & 0xffffn).toString(16));
  }
  return groups.join(":");
}

function ipv4ToInt(ip: string): number {
  const [a, b, c, d] = ip.split(".").map(Number);
  return (((a << 24) | (b << 16) | (c << 8) | d) >>> 0);
}

function intToIpv4(value: number): string {
  return `${(value >>> 24) & 255}.${(value >>> 16) & 255}.${(value >>> 8) & 255}.${value & 255}`;
}

function cidrBounds(cidr: string): [string, string] {
  const [net, prefixStr] = cidr.split("/");
  const prefix = Number(prefixStr);
  if (net.includes(":")) {
    const mask = prefix === 0 ? 0n : (((1n << BigInt(prefix)) - 1n) << BigInt(128 - prefix));
    const base = expandIpv6(net) & mask;
    const last = base | (~mask & ((1n << 128n) - 1n));
    return [formatIpv6(base), formatIpv6(last)];
  }
  const mask = prefix === 0 ? 0 : ((0xffffffff << (32 - prefix)) >>> 0);
  const base = (ipv4ToInt(net) & mask) >>> 0;
  const last = (base | (~mask >>> 0)) >>> 0;
  return [intToIpv4(base), intToIpv4(last)];
}

function addressInCidr(ip: string, cidr: string): boolean {
  const [first, last] = cidrBounds(cidr);
  if (ip.includes(":")) {
    const value = expandIpv6(ip);
    return value >= expandIpv6(first) && value <= expandIpv6(last);
  }
  const value = ipv4ToInt(ip);
  return value >= ipv4ToInt(first) && value <= ipv4ToInt(last);
}

test("every README-documented blocked range is enforced at its boundaries", () => {
  const repoRoot = new URL("../../../../", import.meta.url);
  const readme = readFileSync(new URL("README.md", repoRoot), "utf8");
  const ipv4 = readme.match(/\b(?:\d{1,3}\.){3}\d{1,3}\/\d{1,2}\b/g) ?? [];
  const ipv6 = readme.match(/(?<![0-9a-f:])(?:[0-9a-f]{0,4}:){2,}[0-9a-f]{0,4}\/\d{1,3}(?!\d)/gi) ?? [];
  const cidrs = [...new Set([...ipv4, ...ipv6])];
  assert.ok(cidrs.length >= 23, `expected >= 23 CIDRs documented in README, got ${cidrs.length}`);

  for (const cidr of cidrs) {
    const [first, last] = cidrBounds(cidr);
    assert.equal(isPrivateAddress(first), true, `first address of ${cidr} must be blocked`);
    assert.equal(isPrivateAddress(last), true, `last address of ${cidr} must be blocked`);

    // The address just past the range is public unless it belongs to another
    // documented (blocked) range.
    let outside: string;
    if (last.includes(":")) {
      const next = expandIpv6(last) + 1n;
      if (next >= 1n << 128n) continue; // wraps past ::ffff:ffff:... — skip
      outside = formatIpv6(next);
    } else {
      const next = (ipv4ToInt(last) + 1) >>> 0;
      if (next === 0) continue; // wrapped past 255.255.255.255 — skip
      outside = intToIpv4(next);
    }
    // The guard also refuses the whole deprecated IPv4-compatible space ::/96
    // (and judges ::ffff:a.b.c.d by its embedded IPv4), so an outside address
    // inside ::/96 is blocked by that wrapper rule, not by the CIDR table.
    if (outside.includes(":") && addressInCidr(outside, "::/96")) continue;
    if (cidrs.some((other) => addressInCidr(outside, other))) continue;
    assert.equal(isPrivateAddress(outside), false, `address just outside ${cidr} (${outside}) must be public`);
  }
});
