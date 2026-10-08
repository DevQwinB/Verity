"use client"; // Error boundaries must be Client Components

import { useEffect } from "react";
import { Button } from "../components/ui/button";

/** Shown when a page could not be rendered — in practice, when the Verity
 * backend or the chain it reads is not answering. Nothing on these pages is
 * cached or made up, so there is no stale copy to fall back on: say what
 * happened and offer to try again. */
export default function RouteError({
  error,
  retry,
}: {
  error: Error & { digest?: string };
  retry: () => void;
}) {
  useEffect(() => {
    console.error(error);
  }, [error]);

  return (
    <div className="mx-auto max-w-xl py-16">
      <p className="font-mono text-xs uppercase tracking-wider text-status-slashed">Could not load</p>
      <h1 className="mt-3 text-2xl font-semibold tracking-tight">This page did not load</h1>
      <p className="mt-3 text-sm leading-relaxed text-text-secondary">
        Verity shows live data from its backend and the Stellar testnet, and one of them did not
        answer. Your funds and anything already on-chain are unaffected. This usually clears up in
        a few seconds.
      </p>
      <div className="mt-6 flex flex-wrap items-center gap-4">
        <Button onClick={() => retry()}>Try again</Button>
        {error.digest && (
          <span className="font-mono text-xs text-text-tertiary">Reference {error.digest}</span>
        )}
      </div>
    </div>
  );
}
