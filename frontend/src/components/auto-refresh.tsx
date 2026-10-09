"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";

/** Re-reads the current page's live data on an interval, for as long as it
 * is mounted. Pages render it only while something is still expected to
 * change (a pending verdict, an unsettled submission), and it pauses while
 * the tab is in the background. */
export function AutoRefresh({ everyMs = 5000 }: { everyMs?: number }) {
  const router = useRouter();
  useEffect(() => {
    const id = setInterval(() => {
      if (document.visibilityState === "visible") router.refresh();
    }, everyMs);
    return () => clearInterval(id);
  }, [router, everyMs]);
  return null;
}
