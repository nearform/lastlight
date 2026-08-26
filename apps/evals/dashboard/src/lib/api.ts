import { useQueries, useQuery } from "@tanstack/react-query";

import type { DashboardIndex, Scorecard } from "../types";

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url, { headers: { accept: "application/json" } });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} — ${url}`);
  return (await res.json()) as T;
}

const anyLive = (idx?: DashboardIndex): boolean =>
  !!idx?.tiers.some((t) => t.runs.some((r) => r.live));

/** The whole index, re-fetched from the filesystem scan. Polls quickly while any
 * run is live (so in-flight runs fill in), then settles to a slow heartbeat. */
export function useIndex() {
  return useQuery({
    queryKey: ["index"],
    queryFn: () => getJson<DashboardIndex>("/api/index"),
    refetchInterval: (q) => (anyLive(q.state.data) ? 1500 : 15000),
  });
}

/** One run's full scorecard (per-instance rows). Polls while the run is live;
 * `live` is part of the key so a run going live→done forces one final fetch of
 * the settled scorecard (placeholderData keeps the prior data visible meanwhile). */
export function useScorecard(url: string | undefined, live: boolean) {
  return useQuery({
    queryKey: ["scorecard", url, live],
    queryFn: () => getJson<Scorecard>(url as string),
    enabled: !!url,
    refetchInterval: live ? 1500 : false,
    placeholderData: (prev) => prev,
  });
}

/**
 * Several finished scorecards at once — the repeat-group view needs each
 * repeat's full `results` (for `review.trace`), which `/api/index` does not
 * carry. Deliberately parallel and progressive rather than awaited as a batch,
 * and the query key matches {@link useScorecard}'s at `live: false` so opening a
 * run afterwards reuses what this already loaded. A finished scorecard never
 * changes, hence `staleTime: Infinity`.
 */
export function useScorecards(urls: (string | undefined)[]) {
  return useQueries({
    queries: urls.map((url) => ({
      queryKey: ["scorecard", url, false],
      queryFn: () => getJson<Scorecard>(url as string),
      enabled: !!url,
      staleTime: Infinity,
    })),
  });
}
