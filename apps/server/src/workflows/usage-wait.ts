/**
 * A run whose phase hit a model provider's usage limit is not failed: it goes
 * back to the queue with a `not_before`, and admission promotes it again once
 * the window has reset.
 */
const MIN_WAIT_MS = 5 * 60_000;
const UNKNOWN_RESET_WAIT_MS = 60 * 60_000;
/** The longest usage window (weekly): a later reset is not believed. */
const MAX_WAIT_MS = 7 * 24 * 60 * 60_000;

/**
 * When a run that hit a usage limit may be admitted again: the provider's
 * reset time, but never sooner than 5 minutes from now (a reset already past,
 * or a clock skew, must not spin the run), and never later than 7 days (the
 * time is parsed from transcript text); an hour from now when the reset is
 * unknown.
 */
export function nextNotBefore(resetsAt: string | null | undefined, now: Date): string {
  const at = resetsAt ? Date.parse(resetsAt) : NaN;
  if (Number.isNaN(at)) return new Date(now.getTime() + UNKNOWN_RESET_WAIT_MS).toISOString();
  const t = now.getTime();
  return new Date(Math.min(Math.max(at, t + MIN_WAIT_MS), t + MAX_WAIT_MS)).toISOString();
}
