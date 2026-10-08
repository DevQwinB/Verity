/**
 * Canonical JSON: object keys sorted recursively, no insignificant
 * whitespace. The same function as reexecutor-agent/src/sandbox/canonical.ts
 * and frontend/src/lib/canonical.ts. Used here for payloads Verity signs, so
 * anyone can reproduce the exact signed bytes from the stored JSON.
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
