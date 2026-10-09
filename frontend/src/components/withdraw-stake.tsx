"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useWallet } from "./wallet-provider";
import { Button } from "./ui/button";
import { buildStakeWithdrawal, relayReexecutorStake } from "../lib/client-api";
import { signXdr } from "../lib/wallet";
import { NETWORK_PASSPHRASE, TESTNET_EXPLORER_TX } from "../lib/config";
import { stroopsToXlm, xlmToStroops } from "../lib/format";

/** Lets a re-executor take stake back out. Renders nothing unless the
 * connected wallet is this re-executor's own account. */
export function WithdrawStake({
  reexecutorId,
  account,
  stakeStroops,
  floorStroops,
}: {
  reexecutorId: string;
  account: string;
  stakeStroops: string;
  floorStroops: string;
}) {
  const router = useRouter();
  const wallet = useWallet();
  const [amountXlm, setAmountXlm] = useState("");
  const [busy, setBusy] = useState<null | "building" | "signing" | "relaying">(null);
  const [error, setError] = useState<string | null>(null);
  const [txHash, setTxHash] = useState<string | null>(null);

  if (wallet.account !== account || BigInt(stakeStroops) === BigInt(0)) return null;

  async function handleWithdraw() {
    setError(null);
    setTxHash(null);
    const amount = xlmToStroops(amountXlm);
    if (amount === null) {
      setError("Enter the amount as a positive XLM figure, for example 100.");
      return;
    }
    if (amount > BigInt(stakeStroops)) {
      setError(`You have ${stroopsToXlm(stakeStroops)} XLM staked.`);
      return;
    }
    try {
      setBusy("building");
      const { unsigned_transaction_xdr } = await buildStakeWithdrawal(reexecutorId, amount.toString());
      setBusy("signing");
      const signed = await signXdr(unsigned_transaction_xdr, { networkPassphrase: NETWORK_PASSPHRASE, address: account });
      setBusy("relaying");
      const { tx_hash } = await relayReexecutorStake(reexecutorId, signed);
      setTxHash(tx_hash);
      setAmountXlm("");
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "The withdrawal could not be completed.");
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="space-y-3">
      <p className="max-w-prose text-sm text-text-secondary">
        This is your account. Stake above the {stroopsToXlm(floorStroops)} XLM floor can leave at
        any time; going below it stops new assignments, and the contract refuses that while any of
        your votes is on a submission that has not been finalized.
      </p>
      <div className="flex flex-wrap items-end gap-3">
        <div className="space-y-1.5">
          <label htmlFor="withdraw-amount" className="block text-sm text-text-secondary">
            Amount (XLM)
          </label>
          <input
            id="withdraw-amount"
            inputMode="decimal"
            value={amountXlm}
            onChange={(e) => setAmountXlm(e.target.value)}
            placeholder={stroopsToXlm(stakeStroops)}
            className="w-40 rounded-lg border border-border-strong bg-surface px-3 py-2 font-mono text-sm outline-none focus:border-accent"
          />
        </div>
        <Button variant="secondary" onClick={handleWithdraw} disabled={busy !== null}>
          {busy === "building"
            ? "Building transaction..."
            : busy === "signing"
              ? "Awaiting signature in Freighter..."
              : busy === "relaying"
                ? "Submitting to testnet..."
                : "Withdraw stake"}
        </Button>
      </div>
      {error && (
        <p role="alert" className="text-sm text-status-slashed">
          {error}
        </p>
      )}
      {txHash && (
        <p role="status" className="text-sm">
          Withdrawal confirmed on testnet.{" "}
          <a href={TESTNET_EXPLORER_TX(txHash)} target="_blank" rel="noreferrer" className="text-accent underline-offset-2 hover:underline">
            View transaction
          </a>
        </p>
      )}
    </div>
  );
}
