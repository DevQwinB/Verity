import { cn } from "../../lib/utils";
import type { ReactNode } from "react";

export function Badge({
  children,
  className,
  tone = "neutral",
}: {
  children: ReactNode;
  className?: string;
  tone?: "neutral" | "accent" | "verified" | "pending" | "disputed" | "slashed" | "expired";
}) {
  const tones: Record<string, string> = {
    neutral: "bg-surface-hover text-text-secondary",
    accent: "bg-accent-soft text-accent",
    verified: "bg-status-verified/15 text-status-verified",
    pending: "bg-status-pending/15 text-status-pending",
    disputed: "bg-status-disputed/15 text-status-disputed",
    slashed: "bg-status-slashed/15 text-status-slashed",
    expired: "bg-status-expired/15 text-status-expired",
  };
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium",
        tones[tone],
        className
      )}
    >
      {children}
    </span>
  );
}
