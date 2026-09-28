import { useMutation, useQueries, useQuery, useQueryClient } from "@tanstack/react-query";

import { microStatus, withMicroEntryDefaults } from "../../../src/micro-survey.js";
import { unitSurveyStatus } from "../../../src/unit-survey-index.js";
import { phaseReplayStatus } from "../../../src/phase-replay.js";
import type {
  DashboardIndex,
  FindingLabel,
  FindingsResponse,
  LabelInput,
  MicroSurveyIndex,
  MicroSurveyReport,
  PhaseReplayIndex,
  PhaseReplayReport,
  ReplayReport,
  Scorecard,
  UnitSurveyIndex,
} from "../types";
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

/**
 * A micro-survey run rewrites its report after EVERY repeat, so a replay is
 * visible while it happens: `live` is true on every write but the last, and
 * `heartbeat` is refreshed each time. {@link microStatus} turns the pair into
 * running / interrupted / complete — the same function the index uses, so the
 * two cannot disagree.
 *
 * The list polls fast while anything is genuinely running. It also polls fast
 * for a while after the newest report landed, because the file for a replay
 * that has just been launched does not exist yet and recency is the only signal
 * that another is probably on its way.
 */
const MICRO_ACTIVE_WINDOW_MS = 10 * 60 * 1000;

const microActive = (idx?: MicroSurveyIndex): boolean => {
  if (!idx?.reports.length) return false;
  const now = Date.now();
  if (idx.reports.some((r) => microStatus(r, now) === "running")) return true;
  const t = Date.parse(idx.reports[0]?.generatedAt ?? "");
  return Number.isFinite(t) && now - t < MICRO_ACTIVE_WINDOW_MS;
};

/**
 * The micro-survey index. A 404 is an EMPTY list, not an error: a dashboard
 * built before this endpoint existed (the baked static site on
 * evals.lastlight.dev) has no `/api/micro`, and that must read as "no replays
 * here", exactly as an absent `eval-results/micro-survey/` directory does.
 */
export function useMicroIndex() {
  return useQuery({
    queryKey: ["micro-index"],
    queryFn: async (): Promise<MicroSurveyIndex> => {
      const res = await fetch("/api/micro", { headers: { accept: "application/json" } });
      if (res.status === 404) return { generatedAt: new Date().toISOString(), reports: [] };
      if (!res.ok) throw new Error(`${res.status} ${res.statusText} — /api/micro`);
      const idx = (await res.json()) as MicroSurveyIndex;
      // The index may have been computed — or BAKED, by `scripts/build-site.ts`
      // — by an older harness that knew nothing about the live/fire-rate
      // fields. Degrade those entries rather than render holes.
      return { ...idx, reports: (idx.reports ?? []).map(withMicroEntryDefaults) };
    },
    refetchInterval: (q) => (microActive(q.state.data) ? 1500 : 15000),
  });
}

/**
 * One micro-survey report in full (per-repeat stats + claim lines).
 *
 * A report used to be written once, at the end, which is why this cached it
 * forever. It is now rewritten after every repeat, so a LIVE one must be
 * re-fetched at the live cadence and must not be served from cache — while a
 * settled one keeps the old treatment, because that file really never changes
 * again. `live` is part of the query key so the transition live→done forces one
 * last fetch of the final write, with the previous data held on screen
 * meanwhile rather than flashing a loading state on every poll.
 */
export function useMicroReport(url: string | undefined, live = false) {
  return useQuery({
    queryKey: ["micro-report", url, live],
    queryFn: () => getJson<MicroSurveyReport>(url as string),
    enabled: !!url,
    refetchInterval: live ? 1500 : false,
    staleTime: live ? 0 : Infinity,
    placeholderData: (prev) => prev,
  });
}

/**
 * The unit-survey replay index (`/api/unit-survey`). A 404 is an EMPTY list,
 * for the same reason as {@link useMicroIndex}: a server or baked site that
 * predates the endpoint has no replays to show, and that is not an error.
 *
 * `scripts/unit-survey-replay.ts` writes its report at START and after every
 * case (plus a 15 s heartbeat), so a replay in flight is listed with progress.
 * The list polls at the live cadence while any report is genuinely running
 * ({@link unitSurveyStatus} — the index's own derivation) and at the slow
 * heartbeat otherwise. App mounts this on every route, so the home page's
 * merged list refreshes at the same cadence.
 */
export const unitSurveyActive = (idx?: UnitSurveyIndex, now = Date.now()): boolean =>
  !!idx?.reports.some((r) => unitSurveyStatus(r, now) === "running");

export function useUnitSurveyIndex() {
  return useQuery({
    queryKey: ["unit-survey-index"],
    queryFn: async (): Promise<UnitSurveyIndex> => {
      const res = await fetch("/api/unit-survey", { headers: { accept: "application/json" } });
      if (res.status === 404) return { generatedAt: new Date().toISOString(), reports: [] };
      if (!res.ok) throw new Error(`${res.status} ${res.statusText} — /api/unit-survey`);
      const idx = (await res.json()) as UnitSurveyIndex;
      return { ...idx, reports: idx.reports ?? [] };
    },
    refetchInterval: (q) => (unitSurveyActive(q.state.data) ? 1500 : 15000),
  });
}

/**
 * One unit-survey report in full. A RUNNING report is rewritten after every
 * case, so it is re-fetched at the live cadence and never served from cache; a
 * settled one never changes again and is cached for good. `live` is in the key
 * so running→done forces one last fetch of the final write, with the previous
 * data held on screen meanwhile (as {@link useMicroReport}).
 */
export function useUnitSurveyReport(url: string | undefined, live = false) {
  return useQuery({
    queryKey: ["unit-survey-report", url, live],
    queryFn: () => getJson<ReplayReport>(url as string),
    enabled: !!url,
    refetchInterval: live ? 1500 : false,
    staleTime: live ? 0 : Infinity,
    placeholderData: (prev) => prev,
  });
}

/**
 * The phase-replay index (`/api/phase-replay`) — micro-falsify and
 * micro-adjudicate reports. Same contract as {@link useUnitSurveyIndex}: a 404
 * is an empty list, and it polls at the live cadence while any report is
 * genuinely running (the scripts write after every case plus a 15 s heartbeat).
 */
export const phaseReplayActive = (idx?: PhaseReplayIndex, now = Date.now()): boolean =>
  !!idx?.reports.some((r) => phaseReplayStatus(r, now) === "running");

export function usePhaseReplayIndex() {
  return useQuery({
    queryKey: ["phase-replay-index"],
    queryFn: async (): Promise<PhaseReplayIndex> => {
      const res = await fetch("/api/phase-replay", { headers: { accept: "application/json" } });
      if (res.status === 404) return { generatedAt: new Date().toISOString(), reports: [] };
      if (!res.ok) throw new Error(`${res.status} ${res.statusText} — /api/phase-replay`);
      const idx = (await res.json()) as PhaseReplayIndex;
      return { ...idx, reports: idx.reports ?? [] };
    },
    refetchInterval: (q) => (phaseReplayActive(q.state.data) ? 1500 : 15000),
  });
}

/** One phase-replay report in full; live while running, cached once settled. */
export function usePhaseReplayReport(url: string | undefined, live = false) {
  return useQuery({
    queryKey: ["phase-replay-report", url, live],
    queryFn: () => getJson<PhaseReplayReport>(url as string),
    enabled: !!url,
    refetchInterval: live ? 1500 : false,
    staleTime: live ? 0 : Infinity,
    placeholderData: (prev) => prev,
  });
}

/**
 * Every flagged finding + its human label (`/api/findings`). A scan over the
 * reports and fixtures, so it polls slowly; a saved label patches the cache in
 * place rather than refetching the whole list under the grader's cursor.
 */
export function useFindings(enabled = true) {
  return useQuery({
    queryKey: ["findings"],
    queryFn: () => getJson<FindingsResponse>("/api/findings"),
    enabled,
    refetchInterval: 60000,
    refetchOnWindowFocus: false,
  });
}

export function useSaveLabel() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: LabelInput): Promise<FindingLabel> => {
      const res = await fetch("/api/labels", {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify(input),
      });
      const body = (await res.json().catch(() => ({}))) as FindingLabel & { error?: string };
      if (!res.ok) throw new Error(body.error ?? `${res.status} ${res.statusText}`);
      return body;
    },
    onSuccess: (label) =>
      qc.setQueryData<FindingsResponse>(["findings"], (prev) =>
        prev && {
          ...prev,
          findings: prev.findings.map((f) => (f.key === label.key ? { ...f, label: label.real === null ? null : label } : f)),
        },
      ),
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
