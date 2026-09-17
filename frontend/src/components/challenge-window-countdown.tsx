"use client";

import { useEffect, useState } from "react";
import { formatCountdown } from "../lib/format";

export function ChallengeWindowCountdown({ deadlineIso }: { deadlineIso: string }) {
  const [label, setLabel] = useState(() => formatCountdown(deadlineIso));

  useEffect(() => {
    const id = setInterval(() => setLabel(formatCountdown(deadlineIso)), 1000);
    return () => clearInterval(id);
  }, [deadlineIso]);

  return (
    <>
      <p className="text-xs uppercase tracking-wide text-text-tertiary">Challenge window</p>
      <p className="mt-2 font-mono text-sm">{label}</p>
    </>
  );
}
