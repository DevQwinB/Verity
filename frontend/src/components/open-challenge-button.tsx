"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useWallet } from "./wallet-provider";
import { Button } from "./ui/button";
import { openChallenge, relayChallenge } from "../lib/client-api";
import { signXdr } from "../lib/wallet";
import { NETWORK_PASSPHRASE } from "../lib/config";

export function OpenChallengeButton({ submissionId }: { submissionId: string }) {
  const router = useRouter();
  const { account, connecting, login } = useWallet();
  const [bondXlm, setBondXlm] = useState("5");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleChallenge() {
    if (!account) return;
    setBusy(true);
    setError(null);
    try {
      const bondStroops = String(BigInt(Math.round(Number(bondXlm) * 10_000_000)));
      const { unsigned_transaction_xdr } = await openChallenge(submissionId, bondStroops);
      const signed = await signXdr(unsigned_transaction_xdr, {
        networkPassphrase: NETWORK_PASSPHRASE,
        address: account,
      });
      await relayChallenge(submissionId, signed);
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Challenge failed.");
    } finally {
      setBusy(false);
    }
  }

  if (!account) {
    return (
      <Button variant="secondary" onClick={login} disabled={connecting}>
        Connect wallet to open a challenge
      </Button>
    );
  }

  return (
    <div className="flex flex-wrap items-center gap-3">
      <input
        type="number"
        value={bondXlm}
        onChange={(e) => setBondXlm(e.target.value)}
        className="w-24 rounded-lg border border-border-strong bg-surface px-3 py-2 text-sm outline-none focus:border-accent"
      />
      <span className="text-sm text-text-tertiary">XLM challenger bond</span>
      <Button variant="danger" onClick={handleChallenge} disabled={busy}>
        {busy ? "Submitting challenge..." : "Open challenge"}
      </Button>
      {error && <p className="w-full text-sm text-status-slashed">{error}</p>}
    </div>
  );
}
