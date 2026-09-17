"use client";

import { requestAccess, getAddress, signTransaction, isConnected } from "@stellar/freighter-api";

export class WalletError extends Error {}

export async function connectWallet(): Promise<string> {
  const connected = await isConnected();
  if (connected.error) {
    throw new WalletError(
      "Freighter is not installed or unavailable in this browser. Install the Freighter extension to continue."
    );
  }
  const result = await requestAccess();
  if (result.error || !result.address) {
    throw new WalletError(result.error?.message ?? "Freighter access was denied.");
  }
  return result.address;
}

export async function currentWalletAddress(): Promise<string | null> {
  const result = await getAddress();
  if (result.error || !result.address) return null;
  return result.address;
}

export async function signXdr(
  xdr: string,
  opts: { networkPassphrase: string; address: string }
): Promise<string> {
  const result = await signTransaction(xdr, opts);
  if (result.error || !result.signedTxXdr) {
    throw new WalletError(result.error?.message ?? "Transaction signing was rejected.");
  }
  return result.signedTxXdr;
}
