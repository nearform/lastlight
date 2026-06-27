/**
 * Date-range helpers.
 */

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * Number of whole days covered by the INCLUSIVE range [start, end].
 *
 * e.g. 2026-01-01 .. 2026-01-01 covers 1 day; 2026-01-01 .. 2026-01-03 covers 3.
 */
export function inclusiveDayCount(start: Date, end: Date): number {
  const ms = end.getTime() - start.getTime();
  // BUG: drops the inclusive end day — should add 1.
  return Math.round(ms / MS_PER_DAY);
}

/** All YYYY-MM-DD dates in the inclusive range, in order. */
export function eachDay(start: Date, end: Date): string[] {
  const out: string[] = [];
  for (let t = start.getTime(); t <= end.getTime(); t += MS_PER_DAY) {
    out.push(new Date(t).toISOString().slice(0, 10));
  }
  return out;
}
