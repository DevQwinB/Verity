/** Maps an x402 settlement to the Verity `escrow_ref` that binds a verdict to
 * that exact payment.
 *
 * The backend stores `escrow_ref` as the string the agent sent and hashes it
 * to the 32-byte BytesN<32> on-chain (backend/src/chain/mappers.ts
 * sha256Bytes), so the settlement transaction hash — 64 hex chars = 32 bytes —
 * is used verbatim. The buyer then checks the attestation's
 * `payload.subject.escrow_ref` equals the same hash. */

const TX_HASH_RE = /^[0-9a-fA-F]{64}$/;

/** Normalises and validates a settlement transaction hash. Throws on anything
 * that is not exactly 32 bytes of hex — a truncated hash would silently bind
 * the verdict to the wrong payment. */
export function escrowRefFromTxHash(txHash) {
  if (typeof txHash !== "string" || !TX_HASH_RE.test(txHash)) {
    throw new Error(`x402 settlement hash is not 32 bytes of hex: ${String(txHash).slice(0, 80)}`);
  }
  return txHash.toLowerCase();
}

/** Extracts the settlement transaction hash from whatever shape the x402
 * packages hand back. Read defensively and fail closed: a paid response
 * served without a payment reference cannot be bonded, so the caller must
 * not serve it. */
export function settlementTxHash({ payment, paymentResponseHeader } = {}) {
  const candidates = [
    payment?.beforeHandlerSettlement?.result?.transaction,
    payment?.result?.transaction,
    payment?.settleResponse?.transaction,
    payment?.settleResponse?.txHash,
    payment?.response?.transaction,
    payment?.transaction,
    payment?.payload?.transactionHash,
    decodePaymentResponseHeader(paymentResponseHeader)?.transaction,
    decodePaymentResponseHeader(paymentResponseHeader)?.txHash,
  ];
  for (const c of candidates) {
    if (typeof c === "string" && TX_HASH_RE.test(c)) return c.toLowerCase();
  }
  return null;
}

/** Decodes the base64 JSON PAYMENT-RESPONSE header the middleware sets on the
 * outgoing response after settling. Returns null when absent or malformed. */
export function decodePaymentResponseHeader(header) {
  if (typeof header !== "string" || header === "") return null;
  try {
    return JSON.parse(Buffer.from(header, "base64").toString("utf8"));
  } catch {
    return null;
  }
}
