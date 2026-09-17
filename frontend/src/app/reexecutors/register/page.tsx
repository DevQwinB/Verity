"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useWallet } from "../../../components/wallet-provider";
import { Card, CardBody, CardHeader } from "../../../components/ui/card";
import { Button } from "../../../components/ui/button";
import { registerReexecutor, relayReexecutorStake } from "../../../lib/client-api";
import { signXdr } from "../../../lib/wallet";
import { NETWORK_PASSPHRASE, TESTNET_EXPLORER_TX } from "../../../lib/config";

export default function RegisterReexecutorPage() {
  const router = useRouter();
  const { account, connecting, login } = useWallet();
  const [stakeXlm, setStakeXlm] = useState("1000");
  const [status, setStatus] = useState<"idle" | "building" | "signing" | "relaying" | "done" | "error">(
    "idle"
  );
  const [error, setError] = useState<string | null>(null);
  const [txHash, setTxHash] = useState<string | null>(null);

  async function handleRegister() {
    if (!account) return;
    setError(null);
    try {
      setStatus("building");
      const stakeStroops = String(BigInt(Math.round(Number(stakeXlm) * 10_000_000)));
      const { reexecutor, unsigned_transaction_xdr } = await registerReexecutor(stakeStroops);

      setStatus("signing");
      const signed = await signXdr(unsigned_transaction_xdr, {
        networkPassphrase: NETWORK_PASSPHRASE,
        address: account,
      });

      setStatus("relaying");
      const { tx_hash } = await relayReexecutorStake(reexecutor.id, signed);
      setTxHash(tx_hash);
      setStatus("done");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Registration failed.");
      setStatus("error");
    }
  }

  return (
    <div className="max-w-lg space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Register as a re-executor</h1>
        <p className="mt-1 text-sm text-text-secondary">
          Staking is a real, signed Stellar testnet transaction against the EscrowGate contract.
          Your stake is custodied on-chain, weighted assignment, and slashed on a provable mismatch.
        </p>
      </div>

      <Card>
        <CardHeader>
          <span className="font-medium">Stake amount</span>
        </CardHeader>
        <CardBody className="space-y-4">
          <div className="space-y-2">
            <label htmlFor="stake" className="text-sm text-text-secondary">
              Amount (XLM)
            </label>
            <input
              id="stake"
              type="number"
              min="1"
              value={stakeXlm}
              onChange={(e) => setStakeXlm(e.target.value)}
              className="w-full rounded-lg border border-border-strong bg-surface px-3 py-2 text-sm outline-none focus:border-accent"
            />
          </div>

          {error && <p className="text-sm text-status-slashed">{error}</p>}

          {status === "done" && txHash ? (
            <div className="space-y-2 rounded-lg bg-status-verified/10 p-4 text-sm">
              <p className="text-status-verified">Stake confirmed on testnet.</p>
              <a
                href={TESTNET_EXPLORER_TX(txHash)}
                target="_blank"
                rel="noreferrer"
                className="text-accent hover:underline"
              >
                View transaction
              </a>
              <div>
                <Button variant="secondary" onClick={() => router.push("/reexecutors")}>
                  View re-executor directory
                </Button>
              </div>
            </div>
          ) : account ? (
            <Button onClick={handleRegister} disabled={status !== "idle" && status !== "error"}>
              {status === "building"
                ? "Building transaction..."
                : status === "signing"
                  ? "Awaiting signature in Freighter..."
                  : status === "relaying"
                    ? "Submitting to testnet..."
                    : "Stake and register"}
            </Button>
          ) : (
            <Button onClick={login} disabled={connecting}>
              {connecting ? "Connecting..." : "Connect wallet to continue"}
            </Button>
          )}
        </CardBody>
      </Card>
    </div>
  );
}
