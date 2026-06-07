/**
 * Returns the number of full weeks between two dates.
 *
 * - Order agnostic: the absolute difference between the dates is used.
 * - Always non-negative.
 * - Partial weeks are truncated (i.e. rounded down).
 *
 * This works in terms of UTC timestamps (via `Date.getTime()`), so leap years
 * and daylight saving time transitions are naturally accounted for by the
 * underlying JavaScript Date implementation.
 */
export function getWeekDifference(a: Date, b: Date): number {
  const MS_PER_WEEK = 7 * 24 * 60 * 60 * 1000;
  const diffMs = Math.abs(a.getTime() - b.getTime());
  return Math.floor(diffMs / MS_PER_WEEK);
}
