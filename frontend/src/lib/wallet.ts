"use client";

import { requestAccess, signTransaction, isConnected, getNetwork } from "@stellar/freighter-api";

export type WalletErrorCode = "not-installed" | "wrong-network" | "rejected" | "timeout";

export class WalletError extends Error {
  constructor(
    public readonly code: WalletErrorCode,
    message: string
  ) {
    super(message);
    this.name = "WalletError";
  }
}

/** Freighter answers through the extension; if nothing ever answers, the
 * promise never settles. Nobody should watch a button say "Connecting..."
 * forever, so every wait on the wallet has an end. */
function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new WalletError("timeout", message)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      }
    );
  });
}

/** Asks Freighter for the active account, on the network this deployment uses. */
export async function connectWallet(expectedPassphrase: string): Promise<string> {
  // Without the extension this resolves to isConnected: false (after a short
  // internal timeout) rather than to an error.
  const connected = await isConnected();
  if (connected.error || !connected.isConnected) {
    throw new WalletError("not-installed", "Freighter is not installed in this browser.");
  }
  const result = await withTimeout(
    requestAccess(),
    120_000,
    "Freighter did not respond. Open the extension, unlock it, and try again."
  );
  if (result.error || !result.address) {
    throw new WalletError("rejected", result.error?.message ?? "Freighter access was declined.");
  }
  const network = await getNetwork();
  if (!network.error && network.networkPassphrase !== expectedPassphrase) {
    throw new WalletError(
      "wrong-network",
      `Freighter is set to ${network.network || "another network"}. Switch it to Testnet and connect again.`
    );
  }
  return result.address;
}

export async function signXdr(
  xdr: string,
  opts: { networkPassphrase: string; address: string }
): Promise<string> {
  const result = await withTimeout(
    signTransaction(xdr, opts),
    300_000,
    "Freighter did not respond to the signing request. Open the extension and try again."
  );
  if (result.error || !result.signedTxXdr) {
    throw new WalletError("rejected", result.error?.message ?? "The signing request was declined.");
  }
  return result.signedTxXdr;
}
