"use client";

import { useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";

/** Longest wait between polls after repeated failures. */
const MAX_DELAY_MS = 60_000;

/** Re-reads the current page's live data while it is mounted. Pages render it
 * only while something is still expected to change (a pending verdict, an
 * unsettled submission), and it pauses while the tab is in the background.
 *
 * A cheap status route is polled first; the page is only re-rendered when its
 * fingerprint differs from the one the page was rendered with. A failed poll
 * leaves the last good page on screen and backs off 5s, 10s, 20s… up to a
 * minute. A refresh whose own read fails renders the page's last copy rather
 * than app/error.tsx, so the page is kept and the change retried.
 *
 * `initialFingerprint` comes from the data this page rendered with, so a
 * change that lands between that render and the first poll is still seen. The
 * effect's baseline is only ever replaced by a render that commits, so a
 * refresh that did not succeed leaves the old baseline in place and the same
 * change is retried on the next tick. */
export function AutoRefresh({
  everyMs = 5000,
  statusPath,
  initialFingerprint,
}: {
  everyMs?: number;
  statusPath: string;
  initialFingerprint: string;
}) {
  const router = useRouter();
  const [, startTransition] = useTransition();
  const [paused, setPaused] = useState(false);

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let failures = 0;
    let cancelled = false;
    let lastFingerprint = initialFingerprint;
    const controller = new AbortController();

    const schedule = (ms: number) => {
      timer = setTimeout(tick, ms);
    };

    async function tick() {
      if (cancelled) return;
      if (document.visibilityState !== "visible") {
        // Keep polling on the normal cadence, but do not spend requests while
        // the tab is in the background.
        schedule(everyMs);
        return;
      }
      try {
        const res = await fetch(statusPath, { cache: "no-store", signal: controller.signal });
        if (!res.ok) throw new Error(`status ${res.status}`);
        const { fingerprint } = (await res.json()) as { fingerprint: string };
        failures = 0;
        setPaused(false);
        if (fingerprint !== lastFingerprint) {
          // Deliberately not advancing lastFingerprint: only a committed
          // render re-runs this effect with a new baseline, so a refresh that
          // fails is retried instead of the change being forgotten.
          startTransition(() => {
            router.refresh();
          });
        }
        schedule(everyMs);
      } catch {
        if (cancelled) return;
        failures += 1;
        setPaused(true);
        schedule(Math.min(everyMs * 2 ** (failures - 1), MAX_DELAY_MS));
      }
    }

    schedule(everyMs);
    return () => {
      cancelled = true;
      controller.abort();
      if (timer) clearTimeout(timer);
    };
  }, [router, everyMs, statusPath, initialFingerprint, startTransition]);

  if (!paused) return null;
  return (
    <p role="status" className="text-xs text-text-tertiary">
      Live updates paused, retrying.
    </p>
  );
}
