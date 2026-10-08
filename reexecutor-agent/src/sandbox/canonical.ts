import { createHash } from "node:crypto";

/**
 * The one canonical byte form every party hashes an output in: JSON with
 * object keys sorted recursively and no insignificant whitespace. Without
 * this, two honest parties whose runtimes happen to emit keys in a different
 * order would produce different hashes for the same result.
 *
 * The same function lives in frontend/src/lib/canonical.ts — the agent's
 * claimed_output_hash and a re-executor's replay hash must agree byte for byte.
 */
export function canonicalJson(value: unknown): string {
  if (value === undefined) return "null";
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj)
    .filter((k) => obj[k] !== undefined)
    .sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`).join(",")}}`;
}

export function canonicalHash(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}
