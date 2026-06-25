/**
 * Supported input types for time-difference helpers.
 * - Date: uses getTime()
 * - number: treated as milliseconds since Unix epoch
 * - string: parsed via Date.parse (throws on invalid input)
 */
export type DateInput = Date | string | number;

export type TimeUnit = "second" | "minute" | "hour" | "day" | "week";

export interface HumanTimeDiff {
  value: number;
  unit: TimeUnit;
}

function toMillis(input: DateInput): number {
  if (input instanceof Date) {
    return input.getTime();
  }

  if (typeof input === "number") {
    return input;
  }

  const ms = Date.parse(input);
  if (Number.isNaN(ms)) {
    throw new Error(`Invalid date input: ${input}`);
  }

  return ms;
}

/**
 * Compute a human-readable time difference between two instants.
 *
 * The result is symmetric (order of inputs does not matter) and always
 * non-negative. Units are chosen from seconds, minutes, hours, days, weeks
 * based on the magnitude of the elapsed time and rounded to the nearest
 * whole unit.
 */
export function humanTimeDiff(a: DateInput, b: DateInput): HumanTimeDiff {
  const aMs = toMillis(a);
  const bMs = toMillis(b);

  const diffMs = Math.abs(bMs - aMs);
  const totalSeconds = diffMs / 1000;

  let unit: TimeUnit;
  let value: number;

  if (totalSeconds < 60) {
    unit = "second";
    value = Math.round(totalSeconds);
  } else if (totalSeconds < 60 * 60) {
    unit = "minute";
    value = Math.round(totalSeconds / 60);
  } else if (totalSeconds < 24 * 60 * 60) {
    unit = "hour";
    value = Math.round(totalSeconds / (60 * 60));
  } else if (totalSeconds < 7 * 24 * 60 * 60) {
    unit = "day";
    value = Math.round(totalSeconds / (24 * 60 * 60));
  } else {
    unit = "week";
    value = Math.round(totalSeconds / (7 * 24 * 60 * 60));
  }

  if (value === 0) {
    return { value: 0, unit: "second" };
  }

  return { value, unit };
}

/**
 * Format a HumanTimeDiff into an English phrase with basic pluralization.
 */
export function formatHumanTimeDiff(diff: HumanTimeDiff): string {
  const { value, unit } = diff;
  const unitLabel = value === 1 ? unit : `${unit}s`;
  return `${value} ${unitLabel}`;
}

/**
 * Convenience helper that computes and formats the difference between two dates.
 */
export function formatDateDifference(a: DateInput, b: DateInput): string {
  return formatHumanTimeDiff(humanTimeDiff(a, b));
}
