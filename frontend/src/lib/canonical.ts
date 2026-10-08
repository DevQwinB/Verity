/**
 * The one canonical byte form every party hashes an output in: JSON with
 * object keys sorted recursively and no insignificant whitespace.
 *
 * Must stay byte-for-byte identical to
 * reexecutor-agent/src/sandbox/canonical.ts — the claimed output hash made
 * here and a re-executor's replay hash only match if both sides serialize
 * the same value the same way.
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

/** What the user typed, as a value: JSON when it parses, otherwise the
 * trimmed text itself (a plain-text result is a JSON string). */
export function parseJsonOrText(text: string): unknown {
  const trimmed = text.trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    return trimmed;
  }
}
