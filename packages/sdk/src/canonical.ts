import { createHash } from "node:crypto";

/**
 * Canonical JSON: object keys sorted recursively in UTF-16 code unit order,
 * no insignificant whitespace. BigInt serialisation throws TypeError.
 * NaN, Infinity, and undefined serialize as null (or are omitted from object keys).
 */
export function canonicalJson(value: unknown): string {
  if (value === undefined) return "null";
  if (typeof value === "bigint") {
    throw new TypeError("Do not know how to serialize a BigInt to canonical JSON");
  }
  if (value === null || typeof value !== "object") {
    if (typeof value === "number") {
      if (Number.isNaN(value) || !Number.isFinite(value)) return "null";
      if (Object.is(value, -0)) return "0";
    }
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj)
    .filter((k) => obj[k] !== undefined)
    .sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`).join(",")}}`;
}

/**
 * Computes the SHA-256 digest of the canonical JSON representation.
 */
export function canonicalHash(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value), "utf8").digest("hex");
}
