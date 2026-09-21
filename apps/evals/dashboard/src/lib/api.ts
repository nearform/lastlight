import { useQueries, useQuery } from "@tanstack/react-query";

import type { DashboardIndex, Scorecard } from "../types";
import {
  buildFamilyDrilldown,
  type FamilyDrilldown,
  type FindingsDoc,
  type DispositionDoc,
  type ObligationsDoc,
} from "./pipelineArtifacts";

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

/**
 * A `/data/*` artifact that may legitimately not exist.
 *
 * `undefined` on a 404 and a THROW on anything else, because "the pipeline
 * never wrote this document" and "the server is broken" must not render
 * identically — the whole point of the drill-down is that absent and zero are
 * different facts.
 */
async function getOptional(url: string): Promise<string | undefined> {
  const res = await fetch(url, { headers: { accept: "application/json, text/plain" } });
  if (res.status === 404) return undefined;
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} — ${url}`);
  return await res.text();
}

const parseOptional = <T,>(text: string | undefined): T | undefined => {
  if (text === undefined) return undefined;
  try {
    return JSON.parse(text) as T;
  } catch {
    return undefined; // a half-written document on a live run
  }
};

/** One case's artifacts, fetched and joined for one family. */
export interface CaseDrilldown {
  instanceId: string;
  /** Where the artifacts are (a `/data/…/pr-review` URL), for the honest
   * "nothing here" message and for a copyable path. */
  base: string;
  drilldown: FamilyDrilldown;
}

/**
 * Fetch the four documents behind one family's funnel row, for each case that
 * recorded a `pipelineArtifactRel`, and join them.
 *
 * **Lazy on purpose** — `enabled` is the modal's open state. Each case is a few
 * KB of JSON, but there is no reason to pull them for every run in the index
 * when nobody has asked a question of them yet. A finished run's artifacts never
 * change, hence `staleTime: Infinity`.
 */
export function useFamilyDrilldowns(
  cases: { instanceId: string; base: string }[],
  family: string,
  enabled: boolean,
) {
  return useQueries({
    queries: cases.map((c) => ({
      queryKey: ["pipeline-artifacts", c.base, family],
      enabled,
      staleTime: Infinity,
      queryFn: async (): Promise<CaseDrilldown> => {
        const [obligations, findings, disposition, hypothesesText] = await Promise.all([
          getOptional(`${c.base}/obligations.json`),
          getOptional(`${c.base}/findings.json`),
          getOptional(`${c.base}/disposition.json`),
          getOptional(`${c.base}/hypotheses/${encodeURIComponent(family)}.jsonl`),
        ]);
        return {
          instanceId: c.instanceId,
          base: c.base,
          drilldown: buildFamilyDrilldown({
            family,
            obligations: parseOptional<ObligationsDoc>(obligations),
            findings: parseOptional<FindingsDoc>(findings),
            disposition: parseOptional<DispositionDoc>(disposition),
            hypothesesText,
          }),
        };
      },
    })),
  });
}
