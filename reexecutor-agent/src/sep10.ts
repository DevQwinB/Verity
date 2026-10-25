import type { FeeBumpTransaction, Transaction } from "@stellar/stellar-sdk";

/**
 * A SEP-10 challenge is a never-submittable transaction: sequence 0, only
 * manageData operations, the first one sourced from the account logging in.
 * The agent signs whatever the backend sends back, so anything else (a
 * payment, a fee bump, a real sequence number) means the backend, or someone
 * between us and it, is asking for a signature on a transaction that could
 * move funds. Throws instead of signing it.
 */
export function assertSep10Challenge(tx: Transaction | FeeBumpTransaction, account: string): void {
  if ("innerTransaction" in tx) throw new Error("SEP-10 challenge is a fee bump transaction; refusing to sign");
  if (tx.sequence !== "0") throw new Error("SEP-10 challenge has a non-zero sequence number; refusing to sign");
  if (tx.operations.length === 0 || tx.operations.some((op) => op.type !== "manageData")) {
    throw new Error("SEP-10 challenge contains operations other than manageData; refusing to sign");
  }
  if (tx.operations[0]?.source !== account) {
    throw new Error("SEP-10 challenge does not name this account in its first operation; refusing to sign");
  }
}
