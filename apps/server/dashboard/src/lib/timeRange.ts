/**
 * Map a header time-range key (`hour`, `day`, `week`, `all`, `live`) to an ISO
 * `since` value the API can filter on. `all` and `live` return undefined —
 * `live` is handled separately as a status filter, not a date filter. Shared by
 * the Workflow Runs and Artifacts tabs so the window semantics stay identical.
 */
export function timeRangeToSince(timeRange: string): string | undefined {
  if (timeRange === "all" || timeRange === "live") return undefined;
  const cutoffs: Record<string, number> = {
    hour: 3600 * 1000,
    day: 86400 * 1000,
    week: 604800 * 1000,
  };
  const ms = cutoffs[timeRange];
  if (!ms) return undefined;
  return new Date(Date.now() - ms).toISOString();
}
