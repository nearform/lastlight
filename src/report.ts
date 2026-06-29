/**
 * Scorecard rendering + SWE-bench-compatible artifacts.
 *
 *  - A stdout table comparing models on resolved% / triage-correct% / tokens /
 *    cost / latency.
 *  - `scorecard.json`  — the structured roll-up.
 *  - `predictions.jsonl` — SWE-bench predictions shape
 *    (`{ instance_id, model_name_or_path, model_patch }`), so the same artifact
 *    is consumable by SWE-bench's own harness.
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { InstanceResult } from "./schema.js";

/** A case still running / queued (live runs only — surfaced in the dashboard). */
export interface PendingCase {
  tier: string;
  model: string;
  instance_id: string;
  status: "running" | "pending";
  /** For a running case: the archived session jsonl path (live-updated during
   * the run), so the dashboard can open + follow the transcript as it streams. */
  sessionLog?: string;
}

/**
 * Run-level metadata persisted into `scorecard.json` so the dashboard can label,
 * order, and live-poll runs without re-deriving from the current config.
 */
export interface RunMeta {
  runId: string;
  generatedAt: string;
  tiers: string[];
  /**
   * The comparison axis for this run. `"models"` (default) compares N models,
   * each forced across every workflow step. `"config"` compares N deployment
   * configs (per-step model maps merged from an overlay's `config.yaml`) — the
   * setup you actually ship. Absent ⇒ `"models"` (back-compat with older runs).
   */
  runType?: "models" | "config";
  /** Axis labels under test (model ids in `models` runs, config/overlay names
   * in `config` runs) — what the scorecard table displays as rows. */
  models: string[];
  /** Trials per case (`--runs N`). */
  runs: number;
  /** Short git SHA of the code/workflows under test, when in a repo. */
  gitSha?: string;
  /** Display labels keyed by model id (so the dashboard reads them off disk). */
  labels?: Record<string, string>;
  /** While the run is in flight: the dashboard polls + shows a "live" badge.
   * Absent/false on the final write so the published scorecard is static. */
  live?: boolean;
  /** Progress text for the live badge (e.g. "7/30"). */
  progress?: string;
  /** Cases not yet finished (live runs): shown as running/queued rows. */
  pending?: PendingCase[];
}

export interface Scorecard {
  models: ModelSummary[];
  results: InstanceResult[];
  /** Present on the final, on-disk scorecard; absent on live in-flight writes. */
  meta?: RunMeta;
}

export interface ModelSummary {
  model: string;
  total: number;
  codeFixResolved: number;
  codeFixTotal: number;
  behavioralOk: number;
  behavioralTotal: number;
  avgInputTokens: number;
  avgCachedTokens: number;
  avgOutputTokens: number;
  totalCostUsd: number;
  p50DurationMs: number;
  errors: number;
}

/**
 * Fold N trials of ONE case (same model + instance) into a single result:
 *   - binary verdicts (behavioral / resolved) are WORST-case — true only if
 *     every non-errored trial passed (a reliability measure), with the pass
 *     count kept alongside for variance.
 *   - cost / tokens / latency are the MEAN across non-errored trials.
 * A single trial is returned unchanged. If every trial errored, the aggregate
 * carries that error.
 */
export function aggregateTrials(trials: InstanceResult[]): InstanceResult {
  if (trials.length === 1) return trials[0];
  const base = trials[0];
  const ok = trials.filter((t) => !t.error);
  if (!ok.length) {
    return { ...base, trials: 0, trialErrors: trials.length, error: base.error ?? "all trials errored" };
  }

  const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
  const out: InstanceResult = {
    ...base,
    error: undefined,
    inputTokens: Math.round(mean(ok.map((t) => t.inputTokens))),
    cachedTokens: Math.round(mean(ok.map((t) => t.cachedTokens))),
    outputTokens: Math.round(mean(ok.map((t) => t.outputTokens))),
    costUsd: mean(ok.map((t) => t.costUsd)),
    durationMs: Math.round(mean(ok.map((t) => t.durationMs))),
    githubMutations: Math.round(mean(ok.map((t) => t.githubMutations ?? 0))),
    trials: ok.length,
    trialErrors: trials.length - ok.length,
    // Worst-case (matches resolved/behavioral): marked blocked only if every
    // non-errored trial was a deliberate gate block.
    blocked: ok.every((t) => t.blocked) || undefined,
  };

  // behavioral: worst-case ok, checks AND'd by name, keep a failing detail.
  if (ok.some((t) => t.behavioral)) {
    const passes = ok.filter((t) => t.behavioral?.ok).length;
    const names = [...new Set(ok.flatMap((t) => t.behavioral?.checks.map((c) => c.name) ?? []))];
    const checks = names.map((name) => {
      const perTrial = ok.map((t) => t.behavioral?.checks.find((c) => c.name === name));
      const failing = perTrial.find((c) => c && !c.ok);
      return { name, ok: perTrial.every((c) => c?.ok), detail: failing?.detail };
    });
    out.behavioral = { ok: passes === ok.length, checks };
    out.behavioralPass = passes;
  }

  // resolved: worst-case; keep a failing trial's test breakdown + a patch.
  if (ok.some((t) => t.resolved !== undefined)) {
    const passes = ok.filter((t) => t.resolved).length;
    const rep = ok.find((t) => !t.resolved) ?? ok[0];
    out.resolved = passes === ok.length;
    out.resolvedPass = passes;
    out.failToPass = rep.failToPass;
    out.passToPass = rep.passToPass;
    out.model_patch = (ok.find((t) => t.resolved) ?? ok[0]).model_patch;
  }

  return out;
}

/** Per-model aggregation over a set of results (one tier or all of them). */
export function summarizeModels(results: InstanceResult[]): ModelSummary[] {
  const byModel = new Map<string, InstanceResult[]>();
  for (const r of results) {
    const list = byModel.get(r.model) ?? [];
    list.push(r);
    byModel.set(r.model, list);
  }

  const models: ModelSummary[] = [];
  for (const [model, list] of byModel) {
    const codeFix = list.filter((r) => r.resolved !== undefined);
    const behavioral = list.filter((r) => r.behavioral !== undefined && !r.error);
    const durations = list.map((r) => r.durationMs).sort((a, b) => a - b);
    models.push({
      model,
      total: list.length,
      codeFixResolved: codeFix.filter((r) => r.resolved).length,
      codeFixTotal: codeFix.length,
      behavioralOk: behavioral.filter((r) => r.behavioral?.ok).length,
      behavioralTotal: behavioral.length,
      avgInputTokens: avg(list.map((r) => r.inputTokens)),
      avgCachedTokens: avg(list.map((r) => r.cachedTokens)),
      avgOutputTokens: avg(list.map((r) => r.outputTokens)),
      totalCostUsd: list.reduce((s, r) => s + r.costUsd, 0),
      p50DurationMs: durations[Math.floor(durations.length / 2)] ?? 0,
      errors: list.filter((r) => r.error).length,
    });
  }
  return models;
}

export function summarize(results: InstanceResult[]): Scorecard {
  return { models: summarizeModels(results), results };
}

export function renderTable(card: Scorecard, labels: Record<string, string> = {}): string {
  const header = ["model", "code-fix", "behavioral", "in tok", "cached", "out tok", "cost $", "p50", "err"];
  const rows = card.models.map((m) => [
    labels[m.model] ?? m.model,
    m.codeFixTotal ? `${m.codeFixResolved}/${m.codeFixTotal}` : "—",
    m.behavioralTotal ? `${m.behavioralOk}/${m.behavioralTotal}` : "—",
    fmtTokens(m.avgInputTokens),
    fmtTokens(m.avgCachedTokens),
    fmtTokens(m.avgOutputTokens),
    m.totalCostUsd.toFixed(4),
    fmtMs(m.p50DurationMs),
    String(m.errors),
  ]);
  return table([header, ...rows]);
}

/**
 * Write `scorecard.json` atomically (temp-file + rename) so a dashboard polling
 * the file during a live run never reads a half-written JSON. Used both for the
 * incremental live writes and the final static write.
 */
export function writeScorecard(dir: string, card: Scorecard): string {
  mkdirSync(dir, { recursive: true });
  const file = join(dir, "scorecard.json");
  const tmp = join(dir, ".scorecard.json.tmp");
  writeFileSync(tmp, JSON.stringify(card, null, 2));
  renameSync(tmp, file);
  return file;
}

export function writeArtifacts(dir: string, card: Scorecard): void {
  writeScorecard(dir, card);
  const preds = card.results
    .filter((r) => r.model_patch !== undefined)
    .map((r) => JSON.stringify({ instance_id: r.instance_id, model_name_or_path: r.model, model_patch: r.model_patch ?? "" }))
    .join("\n");
  writeFileSync(join(dir, "predictions.jsonl"), preds ? preds + "\n" : "");
}

// ── dashboard index (filesystem → JSON the SPA fetches) ───────────────────────

/** Per-tier model roll-up — a run can span several tiers (`triage+code-fix`),
 * and the overview trends each tier separately, so the index breaks the summary
 * down per tier rather than aggregating across them. */
export interface TierSummary {
  tier: string;
  models: ModelSummary[];
}

/** One run as the dashboard index sees it: identity + per-tier roll-up + the
 * relative URL of its full `scorecard.json` (fetched lazily for the detail view). */
export interface IndexRun {
  /** URL-safe token used in the SPA route (the run subdir name, or "root" for a
   * legacy flat-layout run written directly into the tier dir). */
  id: string;
  /** Relative URL of this run's scorecard.json, served under `/data/`. */
  scorecard: string;
  runId: string;
  generatedAt: string;
  gitSha?: string;
  /** Comparison axis (see {@link RunMeta.runType}) — lets the SPA badge a run
   * without fetching its scorecard. Absent ⇒ `"models"`. */
  runType?: "models" | "config";
  tiers: string[];
  /** Display labels keyed by model id, carried for the SPA. */
  labels: Record<string, string>;
  /** Per-tier model roll-up (enough for the overview tables; the detail view
   * fetches the full scorecard for per-instance rows). */
  byTier: TierSummary[];
  /** Trials per case (`--runs N`). */
  runs: number;
  /** True while the run is still writing (the SPA keeps polling it). */
  live: boolean;
  /** Progress text for the live badge (e.g. "7/30"). */
  progress?: string;
  /** Live-run case counts (so the overview can show "running" vs "queued"
   * instead of a bare "live" for a tier whose cases haven't started). */
  running?: number;
  queued?: number;
}

/** One tier-combo directory (`eval-results/<key>`) and its runs, newest first. */
export interface IndexTier {
  key: string;
  runs: IndexRun[];
}

export interface DashboardIndex {
  generatedAt: string;
  tiers: IndexTier[];
}

/** Map a parsed scorecard into an {@link IndexRun}. `dir` is the run subdir name
 * ("" for a legacy flat-layout run sitting directly in the tier dir). */
function indexRun(tierKey: string, dir: string, card: Scorecard): IndexRun {
  const meta = card.meta;
  const id = dir || "root";
  const data = dir ? `${dir}/scorecard.json` : "scorecard.json";
  const results = card.results ?? [];

  // Group results by their own tier (a run can span several), preserving
  // first-seen order; fall back to the run's first declared tier / the dir key.
  const fallbackTier = meta?.tiers?.[0] ?? tierKey;
  const tierOrder: string[] = [];
  const byTierResults = new Map<string, InstanceResult[]>();
  for (const r of results) {
    const t = r.tier ?? fallbackTier;
    if (!byTierResults.has(t)) {
      byTierResults.set(t, []);
      tierOrder.push(t);
    }
    byTierResults.get(t)!.push(r);
  }
  const byTier: TierSummary[] = tierOrder.map((tier) => ({
    tier,
    models: summarizeModels(byTierResults.get(tier)!),
  }));

  return {
    id,
    scorecard: `/data/${encodeURIComponent(tierKey)}/${data}`,
    runId: meta?.runId ?? dir ?? tierKey,
    generatedAt: meta?.generatedAt ?? dir ?? "",
    gitSha: meta?.gitSha,
    runType: meta?.runType,
    tiers: meta?.tiers ?? tierOrder,
    labels: meta?.labels ?? {},
    byTier,
    runs: meta?.runs ?? 1,
    live: !!meta?.live,
    progress: meta?.progress,
    running: (meta?.pending ?? []).filter((p) => p.status === "running").length,
    queued: (meta?.pending ?? []).filter((p) => p.status === "pending").length,
  };
}

const parseCard = (file: string): Scorecard | null => {
  try {
    return JSON.parse(readFileSync(file, "utf8")) as Scorecard;
  } catch {
    return null; // half-written or malformed — skip rather than abort the index
  }
};

/** Scan one tier-combo dir for runs (subdir-per-run, plus a legacy flat run if a
 * scorecard sits directly in the dir), newest first. */
export function indexTier(resultsRoot: string, key: string): IndexRun[] {
  const tierDir = join(resultsRoot, key);
  if (!existsSync(tierDir)) return [];
  const runs: IndexRun[] = [];
  for (const ent of readdirSync(tierDir, { withFileTypes: true })) {
    if (!ent.isDirectory()) continue;
    const card = parseCard(join(tierDir, ent.name, "scorecard.json"));
    if (card) runs.push(indexRun(key, ent.name, card));
  }
  const flat = parseCard(join(tierDir, "scorecard.json"));
  if (flat) runs.push(indexRun(key, "", flat));
  const sortKey = (r: IndexRun) => r.generatedAt || r.runId;
  return runs.sort((a, b) => (sortKey(a) < sortKey(b) ? 1 : sortKey(a) > sortKey(b) ? -1 : 0));
}

/**
 * Build the whole dashboard index from `eval-results/` on disk: one entry per
 * tier-combo dir (those holding at least one run), each with its runs newest
 * first. The server recomputes this per request, so accumulating runs and live
 * in-flight writes show up without any manifest file to keep in sync.
 */
export function buildIndex(resultsRoot: string, generatedAt: string): DashboardIndex {
  if (!existsSync(resultsRoot)) return { generatedAt, tiers: [] };
  const tiers: IndexTier[] = [];
  for (const ent of readdirSync(resultsRoot, { withFileTypes: true })) {
    if (!ent.isDirectory()) continue;
    const runs = indexTier(resultsRoot, ent.name);
    if (runs.length) tiers.push({ key: ent.name, runs });
  }
  // Tier-combos with the most recent activity first.
  tiers.sort((a, b) => {
    const ka = a.runs[0]?.generatedAt ?? "";
    const kb = b.runs[0]?.generatedAt ?? "";
    return ka < kb ? 1 : ka > kb ? -1 : 0;
  });
  return { generatedAt, tiers };
}

// ── helpers ─────────────────────────────────────────────────────────────────

function avg(xs: number[]): number {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;
}
/** Compact token count: <1000 verbatim, else "k" (one decimal under 10k).
 * Tolerates undefined/NaN (e.g. a scorecard.json predating cached-token
 * tracking) → "0". */
export function fmtTokens(n: number): string {
  const v = Number.isFinite(n) ? n : 0;
  if (v < 1000) return String(Math.round(v));
  const k = v / 1000;
  return `${k >= 10 ? Math.round(k) : k.toFixed(1)}k`;
}
function fmtMs(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const s = Math.round(ms / 1000);
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m${String(s % 60).padStart(2, "0")}`;
}
function table(rows: string[][]): string {
  const widths = rows[0].map((_, i) => Math.max(...rows.map((r) => (r[i] ?? "").length)));
  return rows
    .map((r) => r.map((c, i) => (c ?? "").padEnd(widths[i])).join("  "))
    .join("\n");
}
