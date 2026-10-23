"use client";

import { useEffect, useState } from "react";
import { formatCountdown } from "../lib/format";

export function ChallengeWindowCountdown({ deadlineIso }: { deadlineIso: string }) {
  const [label, setLabel] = useState<string | null>(null);

  useEffect(() => {
    let id: NodeJS.Timeout | undefined;
    const tick = () => {
      setLabel(formatCountdown(deadlineIso));
      if (!(Date.parse(deadlineIso) - Date.now() > 0)) {
        if (id !== undefined) clearInterval(id);
      }
    };
    id = setInterval(tick, 1000);
    tick();
    return () => {
      if (id !== undefined) clearInterval(id);
    };
  }, [deadlineIso]);

  return (
    <>
      <p className="text-xs uppercase tracking-wide text-text-tertiary">Challenge window</p>
      <p className="mt-2 font-mono text-sm">{label ?? "\u2014"}</p>
    </>
  );
}
