import { isIP } from "node:net";
import { lookup } from "node:dns/promises";
import { HttpError } from "../../http-error.js";

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

/** A webhook URL is caller-supplied, and this server is the one that calls
 * it: without this check any account could aim Verity at its operator's
 * internal network (cloud metadata endpoints, localhost admin ports). Same
 * rule as the re-executor agent applies to retrieval targets. */
export async function assertPublicHttpUrl(raw: string): Promise<URL> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new HttpError(400, "webhook url is not a valid URL");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new HttpError(400, `unsupported webhook protocol: ${url.protocol}`);
  }
  const host = url.hostname.replace(/^\[|\]$/g, "");
  let addresses: string[];
  try {
    addresses = isIP(host) ? [host] : (await lookup(host, { all: true })).map((a) => a.address);
  } catch {
    throw new HttpError(400, `webhook host ${host} does not resolve`);
  }
  if (addresses.length === 0 || addresses.some(isPrivateAddress)) {
    throw new HttpError(400, `webhook host ${host} resolves to a non-public address`);
  }
  return url;
}
