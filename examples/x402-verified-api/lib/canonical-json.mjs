/** Canonical JSON, mirroring backend/src/chain/canonical.ts: object keys
 * sorted, undefined values dropped, everything else JSON.stringify'd.
 * Attestation signatures are over exactly these bytes, so the buyer must
 * reproduce them byte for byte. */
export function canonicalJson(value) {
  if (value === undefined) return "null";
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const keys = Object.keys(value).filter((k) => value[k] !== undefined).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(",")}}`;
}
