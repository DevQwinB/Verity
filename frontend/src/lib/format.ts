const STROOPS_PER_XLM = 10_000_000;

export function stroopsToXlm(stroops: string | number): string {
  const n = typeof stroops === "string" ? BigInt(stroops) : BigInt(Math.trunc(stroops));
  const whole = n / BigInt(STROOPS_PER_XLM);
  const frac = n % BigInt(STROOPS_PER_XLM);
  const fracStr = frac.toString().padStart(7, "0").replace(/0+$/, "");
  return fracStr.length > 0 ? `${whole}.${fracStr}` : whole.toString();
}

export function truncateMiddle(value: string, head = 6, tail = 6): string {
  if (value.length <= head + tail + 3) return value;
  return `${value.slice(0, head)}...${value.slice(-tail)}`;
}

/** Formats an ISO timestamp into a human-readable relative time (e.g. "3 minutes ago").
 * Degrades gracefully to "\u2014" on invalid dates and never throws. */
export function formatRelativeTime(iso: string): string {
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return "\u2014";
  const diffMs = t - Date.now();
  const diffSec = Math.round(diffMs / 1000);
  const abs = Math.abs(diffSec);
  const units: [Intl.RelativeTimeFormatUnit, number][] = [
    ["year", 31536000],
    ["month", 2592000],
    ["day", 86400],
    ["hour", 3600],
    ["minute", 60],
    ["second", 1],
  ];
  const rtf = new Intl.RelativeTimeFormat("en", { numeric: "auto" });
  for (let i = 0; i < units.length; i++) {
    const [unit, secondsInUnit] = units[i]!;
    if (abs >= secondsInUnit || unit === "second") {
      let chosenUnit = unit;
      let chosenDivisor = secondsInUnit;
      const count = Math.round(abs / secondsInUnit);
      if (i > 0 && unit !== "month" && count * secondsInUnit >= units[i - 1]![1]) {
        chosenUnit = units[i - 1]![0];
        chosenDivisor = units[i - 1]![1];
      }
      return rtf.format(Math.round(diffSec / chosenDivisor), chosenUnit);
    }
  }
  return rtf.format(diffSec, "second");
}

/** Formats a deadline into a live countdown string (e.g. "59m 59s remaining").
 * Degrades gracefully to "\u2014" on invalid dates and never throws. */
export function formatCountdown(deadlineIso: string): string {
  const t = new Date(deadlineIso).getTime();
  if (Number.isNaN(t)) return "\u2014";
  const ms = t - Date.now();
  if (ms <= 0) return "window closed";
  const totalSec = Math.floor(ms / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  if (h > 0) return `${h}h ${m}m remaining`;
  if (m > 0) return `${m}m ${s}s remaining`;
  return `${s}s remaining`;
}

export function windowDeadlineIso(submittedAtIso: string, windowSeconds: number): string {
  return new Date(new Date(submittedAtIso).getTime() + windowSeconds * 1000).toISOString();
}

/** Parses an XLM amount a person typed into stroops. Null when it is not a
 * positive amount with at most 7 decimal places — so a form can say so,
 * instead of a number conversion throwing somewhere downstream. */
export function xlmToStroops(input: string): bigint | null {
  const value = input.trim();
  if (!/^\d+(\.\d{1,7})?$/.test(value)) return null;
  const [whole, frac = ""] = value.split(".");
  const stroops = BigInt(whole) * BigInt(STROOPS_PER_XLM) + BigInt(frac.padEnd(7, "0"));
  return stroops > BigInt(0) ? stroops : null;
}

/** "10 minutes", "1 hour", "24 hours" — for windows and waits. */
export function formatDuration(seconds: number): string {
  const plural = (n: number, unit: string) => `${n} ${unit}${n === 1 ? "" : "s"}`;
  if (seconds % 3600 === 0) return plural(seconds / 3600, "hour");
  if (seconds % 60 === 0) return plural(seconds / 60, "minute");
  return plural(seconds, "second");
}

/** Basis points as a percentage: 500 -> "5%", 6600 -> "66%", 1250 -> "12.5%". */
export function bpsToPercent(bps: number): string {
  return `${(bps / 100).toString()}%`;
}
