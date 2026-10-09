"use client";

import { useState } from "react";
import { useWallet } from "./wallet-provider";
import { Button } from "./ui/button";
import { fundTestnetAccount } from "../lib/client-api";

/** Asks the testnet faucet for test XLM for the connected account. Bonds and
 * stakes need a balance, and a new Freighter account starts with none. */
export function FundAccountButton() {
  const { account, connecting, login } = useWallet();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);

  async function handleFund() {
    setBusy(true);
    setMessage(null);
    try {
      const result = await fundTestnetAccount();
      setMessage({ ok: true, text: result.message });
    } catch (err) {
      setMessage({ ok: false, text: err instanceof Error ? err.message : "The faucet request failed." });
    } finally {
      setBusy(false);
    }
  }

  if (!account) {
    return (
      <Button variant="secondary" onClick={login} disabled={connecting}>
        {connecting ? "Connecting..." : "Connect wallet"}
      </Button>
    );
  }
  return (
    <div className="space-y-2">
      <Button variant="secondary" onClick={handleFund} disabled={busy}>
        {busy ? "Asking Friendbot..." : "Fund my testnet account"}
      </Button>
      {message && (
        <p role={message.ok ? "status" : "alert"} className={message.ok ? "text-sm text-text-secondary" : "text-sm text-status-slashed"}>
          {message.text}
        </p>
      )}
    </div>
  );
}
