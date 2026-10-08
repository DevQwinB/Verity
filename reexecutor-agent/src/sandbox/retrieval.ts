import { isIP } from "node:net";
import { lookup } from "node:dns/promises";
import { canonicalHash } from "./canonical.js";

/**
 * The input artifact of a retrieval task: the request the agent claims to
 * have made. A re-executor re-issues exactly this request and compares the
 * (optionally JSON-pointer-extracted) result with the agent's claimed output.
 */
export interface RetrievalSpec {
  url: string;
  /** RFC 6901 JSON pointer into a JSON response body, e.g. "/data/0/price". */
  pointer?: string;
}

const MAX_BODY_BYTES = 1_000_000;
const TIMEOUT_MS = 10_000;

function isPrivateAddress(ip: string): boolean {
  if (ip.includes(":")) {
    const v6 = ip.toLowerCase();
    return v6 === "::1" || v6 === "::" || v6.startsWith("fc") || v6.startsWith("fd") || v6.startsWith("fe80") || v6.startsWith("::ffff:");
  }
  const [a, b] = ip.split(".").map(Number);
  return (
    a === 10 || a === 127 || a === 0 ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 169 && b === 254) ||
    (a === 100 && b >= 64 && b <= 127)
  );
}

/** A retrieval spec is attacker-controlled input: without this, any agent
 * could point re-executors at their operator's internal network (cloud
 * metadata endpoints, localhost admin ports) and read the result back. */
async function assertPublicHttpUrl(raw: string): Promise<URL> {
  const url = new URL(raw);
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error(`unsupported retrieval protocol: ${url.protocol}`);
  }
  const host = url.hostname.replace(/^\[|\]$/g, "");
  const addresses = isIP(host) ? [host] : (await lookup(host, { all: true })).map((a) => a.address);
  if (addresses.length === 0 || addresses.some(isPrivateAddress)) {
    throw new Error(`retrieval target ${host} resolves to a non-public address`);
  }
  return url;
}

function resolvePointer(doc: unknown, pointer: string): unknown {
  if (pointer === "") return doc;
  if (!pointer.startsWith("/")) throw new Error(`invalid JSON pointer: ${pointer}`);
  let node: any = doc;
  for (const raw of pointer.slice(1).split("/")) {
    const key = raw.replace(/~1/g, "/").replace(/~0/g, "~");
    if (node === null || typeof node !== "object" || !(key in node)) {
      throw new Error(`JSON pointer ${pointer} does not resolve in the response`);
    }
    node = node[key];
  }
  return node;
}

export async function runRetrieval(spec: RetrievalSpec): Promise<{ outputHash: string; output: unknown; engine: string }> {
  if (!spec || typeof spec.url !== "string") {
    throw new Error('retrieval input artifact must be JSON of the form {"url": "...", "pointer"?: "/..."}');
  }
  const url = await assertPublicHttpUrl(spec.url);
  // redirect: "error" — a redirect could bounce to a private address after
  // the check above, and a moved resource is a legitimate mismatch anyway.
  const res = await fetch(url, {
    redirect: "error",
    signal: AbortSignal.timeout(TIMEOUT_MS),
    headers: { accept: "application/json, text/plain;q=0.9, */*;q=0.1" },
  });
  if (!res.ok) throw new Error(`retrieval target answered HTTP ${res.status}`);
  const text = await res.text();
  if (Buffer.byteLength(text) > MAX_BODY_BYTES) throw new Error("retrieval response too large");

  let body: unknown = text;
  try {
    body = JSON.parse(text);
  } catch {
    if (spec.pointer) throw new Error("a JSON pointer was given but the response is not JSON");
  }
  const output = spec.pointer !== undefined ? resolvePointer(body, spec.pointer) : body;
  return { outputHash: canonicalHash(output), output, engine: "http-refetch (public egress only)" };
}
