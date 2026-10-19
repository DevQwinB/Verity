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

/** Formats a timestamp relative to now (e.g. "3 minutes ago", "in 1 hour").
 * Degrades gracefully to "\u2014" on invalid dates and never throws.
 * Avoids impossible boundary values (such as "60 minutes" or "24 hours")
 * by rolling over to the next larger unit when rounding reaches it. */
export function formatRelativeTime(iso: string): string {
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return "\u2014";
  const diffMs = t - Date.now();
  const diffSec = Math.round(diffMs / 1000);
  const sign = Math.sign(diffSec) || 1;
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
  for (const [unit, secondsInUnit] of units) {
    if (abs >= secondsInUnit || unit === "second") {
      const rounded = Math.round(abs / secondsInUnit);
      if (unit === "minute" && rounded >= 60) {
        return rtf.format(sign * Math.round(abs / 3600), "hour");
      }
      if (unit === "hour" && rounded >= 24) {
        return rtf.format(sign * Math.round(abs / 86400), "day");
      }
      if (unit === "day" && rounded >= 30) {
        return rtf.format(sign * Math.round(abs / 2592000), "month");
      }
      return rtf.format(sign * rounded, unit);
    }
  }
  return rtf.format(diffSec, "second");
}

/** Formats remaining time until a deadline (e.g. "59m 59s remaining").
 * Returns "window closed" when the deadline is in the past.
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
