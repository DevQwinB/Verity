"use client";

import { createContext, useCallback, useContext, useEffect, useState } from "react";
import { connectWallet, signXdr } from "../lib/wallet";
import { fetchChallenge, exchangeChallenge, getSession, logout as apiLogout } from "../lib/client-api";
import { NETWORK_PASSPHRASE } from "../lib/config";

interface WalletState {
  account: string | null;
  connecting: boolean;
  error: string | null;
  login: () => Promise<void>;
  logout: () => Promise<void>;
}

const WalletContext = createContext<WalletState | null>(null);

export function WalletProvider({ children }: { children: React.ReactNode }) {
  const [account, setAccount] = useState<string | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    getSession()
      .then((s) => setAccount(s.account))
      .catch(() => setAccount(null));
  }, []);

  const login = useCallback(async () => {
    setConnecting(true);
    setError(null);
    try {
      const address = await connectWallet();
      const { transaction, network_passphrase } = await fetchChallenge(address);
      const signed = await signXdr(transaction, {
        networkPassphrase: network_passphrase || NETWORK_PASSPHRASE,
        address,
      });
      const { account: authedAccount } = await exchangeChallenge(signed);
      setAccount(authedAccount);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Wallet connection failed.");
    } finally {
      setConnecting(false);
    }
  }, []);

  const logout = useCallback(async () => {
    await apiLogout();
    setAccount(null);
  }, []);

  return (
    <WalletContext.Provider value={{ account, connecting, error, login, logout }}>
      {children}
    </WalletContext.Provider>
  );
}

export function useWallet(): WalletState {
  const ctx = useContext(WalletContext);
  if (!ctx) throw new Error("useWallet must be used within WalletProvider");
  return ctx;
}
