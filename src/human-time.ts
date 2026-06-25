/**
 * Human-readable differences between two dates. Pure utility with no CLI
 * concerns (no colors, no I/O).
 */

export type DateLike = Date | string | number;

export interface HumanDateDiffOptions {
  /**
   * Output style: long ("3 minutes") or short ("3m"). Defaults to "long".
   */
  style?: "short" | "long";
}

const INVALID_SENTINEL = "[invalid date]";

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

/**
 * Normalize a DateLike value to milliseconds since the Unix epoch.
 *
 * - Date instances: use getTime().
 * - string: Date.parse(), returning null on NaN.
 * - number: treat as seconds when it looks like a unix seconds value
 *   (< 1e12 in magnitude), otherwise as milliseconds. This keeps
 *   unix-seconds inputs working while allowing direct ms values.
 */
export function toMillis(input: DateLike): number | null {
  if (input instanceof Date) {
    const t = input.getTime();
    return Number.isNaN(t) ? null : t;
  }

  if (typeof input === "string") {
    const t = Date.parse(input);
    return Number.isNaN(t) ? null : t;
  }

  if (typeof input === "number") {
    if (!isFiniteNumber(input)) return null;
    const abs = Math.abs(input);
    // Heuristic: values smaller than 1e12 are assumed to be seconds.
    if (abs > 0 && abs < 1e12) {
      return input * 1000;
    }
    return input;
  }

  return null;
}

/**
 * Compute a human-readable description of the elapsed time between two dates.
 *
 * The result is direction-agnostic (absolute span). Callers are responsible
 * for adding "ago" / "in" phrasing based on their own comparison of the
 * inputs if direction matters.
 */
export function humanDateDiff(
  from: DateLike,
  to: DateLike,
  options: HumanDateDiffOptions = {},
): string {
  const fromMs = toMillis(from);
  const toMs = toMillis(to);

  if (fromMs === null || toMs === null) {
    return INVALID_SENTINEL;
  }

  const diffMs = Math.abs(toMs - fromMs);

  const style = options.style ?? "long";

  const secondMs = 1000;
  const minuteMs = 60 * secondMs;
  const hourMs = 60 * minuteMs;
  const dayMs = 24 * hourMs;

  const totalSeconds = Math.round(diffMs / secondMs);

  // Treat sub-second / zero differences as 0 seconds so callers always see
  // an explicit value.
  if (totalSeconds === 0) {
    return style === "short" ? "0s" : "0 seconds";
  }

  if (totalSeconds < 60) {
    return formatUnit(totalSeconds, style, "second", "s");
  }

  const totalMinutes = Math.round(totalSeconds / 60);
  if (totalMinutes < 60) {
    return formatUnit(totalMinutes, style, "minute", "m");
  }

  const totalHours = Math.round(totalMinutes / 60);
  if (totalHours < 48) {
    return formatUnit(totalHours, style, "hour", "h");
  }

  const totalDays = Math.round(totalHours / 24);
  if (totalDays < 60) {
    return formatUnit(totalDays, style, "day", "d");
  }

  const approxMonths = Math.round(totalDays / 30);
  if (approxMonths < 24) {
    return formatUnit(approxMonths, style, "month", "mo");
  }

  const approxYears = Math.round(totalDays / 365);
  return formatUnit(approxYears, style, "year", "y");
}

function formatUnit(
  value: number,
  style: "short" | "long",
  longLabel: string,
  shortLabel: string,
): string {
  if (style === "short") {
    return `${value}${shortLabel}`;
  }
  const plural = value === 1 ? longLabel : `${longLabel}s`;
  return `${value} ${plural}`;
}
