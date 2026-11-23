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
 * fingerprint changes. A failed poll therefore leaves the last good page on
 * screen (router.refresh() would otherwise throw the backend's 5xx into
 * app/error.tsx) and backs off 5s, 10s, 20s… up to a minute. */
export function AutoRefresh({ everyMs = 5000, statusPath }: { everyMs?: number; statusPath: string }) {
  const router = useRouter();
  const [, startTransition] = useTransition();
  const [paused, setPaused] = useState(false);

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let failures = 0;
    let cancelled = false;
    let lastFingerprint: string | null = null;
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
        const fingerprint = JSON.stringify(await res.json());
        failures = 0;
        setPaused(false);
        if (lastFingerprint !== null && fingerprint !== lastFingerprint) {
          // Keep the old fingerprint until the refresh is accepted, so a
          // failed attempt is retried on the next tick.
          startTransition(() => {
            router.refresh();
          });
        }
        lastFingerprint = fingerprint;
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
  }, [router, everyMs, statusPath, startTransition]);

  if (!paused) return null;
  return (
    <p role="status" className="text-xs text-text-tertiary">
      Live updates paused, retrying.
    </p>
  );
}
