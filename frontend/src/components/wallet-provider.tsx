"use client";

import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import { WatchWalletChanges } from "@stellar/freighter-api";
import {
  connectWallet,
  evaluateWalletChange,
  signXdr,
  WalletError,
  type WalletErrorCode,
} from "../lib/wallet";
import {
  fetchChallenge,
  exchangeChallenge,
  getConfig,
  getSession,
  logout as apiLogout,
  SESSION_EXPIRED_EVENT,
  type SessionInfo,
} from "../lib/client-api";
import { NETWORK_PASSPHRASE } from "../lib/config";

export interface WalletProblem {
  message: string;
  /** Set when the wallet itself is the problem, so the UI can offer the fix. */
  code: WalletErrorCode | null;
}

/** "restoring" covers the wait for /api/session, so nobody is shown as signed
 * out (and offered "Connect wallet") while the session is still being
 * checked. It is the initial state on the server too, so the first client
 * render matches the server-rendered HTML. */
export type SessionStatus = "restoring" | "signed-in" | "signed-out";

interface WalletState {
  status: SessionStatus;
  account: string | null;
  connecting: boolean;
  networkOk: boolean;
  networkPassphrase: string;
  problem: WalletProblem | null;
  login: () => Promise<void>;
  logout: () => Promise<void>;
  dismissProblem: () => void;
  reportWrongNetwork: (message: string) => void;
}

const SESSION_EXPIRED_PROBLEM: WalletProblem = {
  message: "Your session has expired. Connect your wallet again to continue.",
  code: null,
};

const WalletContext = createContext<WalletState | null>(null);

export function WalletProvider({ children }: { children: React.ReactNode }) {
  const [status, setStatus] = useState<SessionStatus>("restoring");
  const [account, setAccount] = useState<string | null>(null);
  // The session's exp from the cookie, unverified, used only to schedule the
  // sign-out; null when the token carries no exp.
  const [expiresAt, setExpiresAt] = useState<number | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [networkOk, setNetworkOk] = useState(true);
  const [networkPassphrase, setNetworkPassphrase] = useState(NETWORK_PASSPHRASE);
  const [problem, setProblem] = useState<WalletProblem | null>(null);

  const applySession = useCallback((session: SessionInfo) => {
    setAccount(session.account);
    setExpiresAt(session.account ? session.expires_at : null);
    setStatus(session.account ? "signed-in" : "signed-out");
  }, []);

  /** Drop the session locally. Pass a problem to explain it to the user. */
  const endSession = useCallback((nextProblem: WalletProblem | null) => {
    setAccount(null);
    setExpiresAt(null);
    setStatus("signed-out");
    if (nextProblem) setProblem(nextProblem);
  }, []);

  // The visibility check runs outside React and has to tell "was signed in and
  // now is not" from "was never signed in", so keep the last status to hand.
  const statusRef = useRef<SessionStatus>("restoring");
  useEffect(() => {
    statusRef.current = status;
  }, [status]);

  useEffect(() => {
    let cancelled = false;
    getSession()
      .then((session) => {
        if (!cancelled) applySession(session);
      })
      .catch(() => {
        if (!cancelled) applySession({ account: null, expires_at: null });
      });
    return () => {
      cancelled = true;
    };
  }, [applySession]);
      .then((s) => setAccount(s.account))
      .catch(() => setAccount(null));
    getConfig()
      .then((cfg) => {
        if (cfg.network_passphrase) setNetworkPassphrase(cfg.network_passphrase);
      })
      .catch(() => {});
  }, []);

  // The session lives an hour. When the server stops recognising it, show
  // that here rather than leaving a connected-looking account that cannot act.
  useEffect(() => {
    const onExpired = () => endSession(SESSION_EXPIRED_PROBLEM);
    const onExpired = () => {
      setAccount(null);
      setNetworkOk(true);
      setProblem({ message: "Your session has expired. Connect your wallet again to continue.", code: null });
    };
    window.addEventListener(SESSION_EXPIRED_EVENT, onExpired);
    return () => window.removeEventListener(SESSION_EXPIRED_EVENT, onExpired);
  }, [endSession]);

  // Expire on time rather than on the next failed action: the cookie's exp is
  // in hand, so sign out when it passes instead of waiting for a 401.
  useEffect(() => {
    if (status !== "signed-in" || expiresAt === null) return;
    const id = setTimeout(
      () => endSession(SESSION_EXPIRED_PROBLEM),
      Math.max(0, expiresAt - Date.now())
    );
    return () => clearTimeout(id);
  }, [status, expiresAt, endSession]);

  // Background tabs throttle timers, so the expiry above can fire late (or not
  // at all until the tab is focused). Re-check the session whenever the tab
  // comes back to the foreground.
  useEffect(() => {
    const onVisibilityChange = () => {
      if (document.visibilityState !== "visible") return;
      getSession()
        .then((session) => {
          if (session.account) applySession(session);
          else if (statusRef.current === "signed-in") endSession(SESSION_EXPIRED_PROBLEM);
          else applySession(session);
        })
        .catch(() => {
          // A failed check says nothing about the session, so keep what we have.
        });
    };
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => document.removeEventListener("visibilitychange", onVisibilityChange);
  }, [applySession, endSession]);

  // The session is for one account on one network. If Freighter switches
  // accounts, sign out; if it switches networks, keep the session and block
  // signing until it returns to the deployment's network.
  useEffect(() => {
    if (!account) return;
    const watcher = new WatchWalletChanges(3000);
    watcher.watch(({ address, network, networkPassphrase: walletPassphrase }) => {
      const effect = evaluateWalletChange(
        { address, network, networkPassphrase: walletPassphrase },
        account,
        networkPassphrase
      );
      if (effect.kind === "account-switched") {
        // The wallet is a different account now, so the UI must disconnect
        // either way; if deleting the cookie fails, the old session cookie
        // may simply remain until it expires. The "Freighter switched..."
        // message below stays the one the user sees.
        apiLogout().catch(() => {});
        endSession({
        setAccount(null);
        setNetworkOk(true);
        setProblem({
          message: "Freighter switched to a different account. Connect again to continue as that account.",
          code: null,
        });
        return;
      }
      if (effect.kind === "wrong-network") {
        setNetworkOk(false);
        setProblem({ message: effect.message, code: "wrong-network" });
        return;
      }
      if (effect.kind === "network-ok") {
        setNetworkOk(true);
        setProblem((current) => (current?.code === "wrong-network" ? null : current));
      }
    });
    return () => watcher.stop();
  }, [account, endSession]);
  }, [account, networkPassphrase]);

  const login = useCallback(async () => {
    setConnecting(true);
    setProblem(null);
    try {
      const address = await connectWallet(networkPassphrase);
      const { transaction, network_passphrase } = await fetchChallenge(address);
      const signed = await signXdr(transaction, {
        networkPassphrase: network_passphrase || networkPassphrase,
        address,
      });
      const { account: authedAccount } = await exchangeChallenge(signed);
      // /api/auth answers with the account only; /api/session also carries the
      // cookie's exp, which the expiry timer needs now rather than after the
      // next reload.
      const session = await getSession().catch(() => null);
      if (session?.account) {
        applySession(session);
      } else {
        setAccount(authedAccount);
        setExpiresAt(null);
        setStatus("signed-in");
      }
      setNetworkOk(true);
      setAccount(authedAccount);
    } catch (err) {
      setProblem({
        message: err instanceof Error ? err.message : "Wallet connection failed.",
        code: err instanceof WalletError ? err.code : null,
      });
    } finally {
      setConnecting(false);
    }
  }, [applySession]);
  }, [networkPassphrase]);

  const logout = useCallback(async () => {
    setProblem(null);
    try {
      await apiLogout();
    } catch {
      // The cookie is httpOnly, so the client cannot clear it itself: showing
      // the user as disconnected while it survives would sign them back in on
      // the next reload. Keep the session shown and say what happened.
      setProblem({
        message: "Could not sign you out. Check your connection and try again.",
        code: null,
      });
      return;
    }
    endSession(null);
  }, [endSession]);
    setNetworkOk(true);
    setAccount(null);
  }, []);

  const dismissProblem = useCallback(() => {
    setProblem((current) => (current?.code === "wrong-network" && !networkOk ? current : null));
  }, [networkOk]);

  const reportWrongNetwork = useCallback((message: string) => {
    setNetworkOk(false);
    setProblem({ message, code: "wrong-network" });
  }, []);

  return (
    <WalletContext.Provider
      value={{ status, account, connecting, problem, login, logout, dismissProblem }}
      value={{
        account,
        connecting,
        networkOk,
        networkPassphrase,
        problem,
        login,
        logout,
        dismissProblem,
        reportWrongNetwork,
      }}
    >
      {children}
    </WalletContext.Provider>
  );
}

export function useWallet(): WalletState {
  const ctx = useContext(WalletContext);
  if (!ctx) throw new Error("useWallet must be used within WalletProvider");
  return ctx;
}
