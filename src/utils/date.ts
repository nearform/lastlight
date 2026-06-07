/**
 * Returns the number of whole calendar weeks between two dates.
 *
 * Both inputs are normalized to UTC midnight before computing the
 * difference, so the result is independent of time-of-day or local
 * timezone/DST differences. The result is always a non-negative integer.
 */
export function weeksBetween(a: Date | string, b: Date | string): number {
  const dateA = toValidDate(a, 'a');
  const dateB = toValidDate(b, 'b');

  const normalizedA = normalizeToUtcMidnight(dateA);
  const normalizedB = normalizeToUtcMidnight(dateB);

  const diffMs = Math.abs(normalizedA.getTime() - normalizedB.getTime());
  const MS_PER_WEEK = 7 * 24 * 60 * 60 * 1000;

  return Math.floor(diffMs / MS_PER_WEEK);
}

function toValidDate(value: Date | string, label: string): Date {
  const date = value instanceof Date ? value : new Date(value);

  if (Number.isNaN(date.getTime())) {
    throw new Error(`Invalid date input for ${label}`);
  }

  return date;
}

function normalizeToUtcMidnight(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}
