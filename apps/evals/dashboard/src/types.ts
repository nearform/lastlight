/**
 * The JSON contracts the dashboard reads: `/api/index` and
 * `/data/.../scorecard.json`.
 *
 * **Result-shaped types are imported from the harness itself**, not mirrored.
 * `../../src/schema.ts` is types-only at runtime (its single import is an
 * `import type`), so Vite erases it entirely and tsc still checks us against the
 * real definitions. A hand-kept copy is how the dashboard came to be missing
 * `micro` for the whole life of that field — the copy could drift silently and
 * did.
 *
 * The *report*-shaped types (`ModelSummary`, `RunMeta`, the index) still live
 * here because their definitions sit in `../../src/report.ts`, which imports
 * `node:fs`/`node:path` and therefore cannot be pulled into a browser bundle or
 * type-checked under this package's DOM-only tsconfig. `lib/summarize.test.ts`
 * is the guard for that remaining copy: it runs the harness's own
 * `summarizeModels` in Node and asserts field-for-field agreement.
 */

import type {
  InstanceResult,
  PhaseMetric,
  PhaseSession,
  ReviewGradeResult,
  TrialSession,
} from "../../src/schema.js";
import type { BoundaryMetrics, FamilyFunnel, MicroReview } from "../../src/review-metrics.js";

export type {
  InstanceResult,
  PhaseMetric,
  PhaseSession,
  ReviewGradeResult,
  TrialSession,
  BoundaryMetrics,
  FamilyFunnel,
  MicroReview,
};

/** The judge's inspectable working for one pr-review grade — the harness declares
 * it inline on {@link ReviewGradeResult}, so name it here rather than re-typing it. */
export type ReviewTrace = NonNullable<ReviewGradeResult["trace"]>;

/** One behavioral/marker check result. */
export interface Check {
  name: string;
  ok: boolean;
  detail?: string;
}

export interface ModelSummary {
  model: string;
  total: number;
  codeFixResolved: number;
  codeFixTotal: number;
  behavioralOk: number;
  behavioralTotal: number;
  /** PR-review tier: N cases graded + mean precision/recall/F-beta. */
  reviewTotal: number;
  avgPrecision: number;
  avgRecall: number;
  avgFbeta: number;
  /** The β the graded cases used (F1 by default). Undefined when nothing graded. */
  reviewBeta?: number;
  /**
   * Micro-aggregated review metrics — **the headline for recall-first work**, and
   * the number every planning document reasons in. The `avg*` fields above are
   * means of per-case ratios: they weight a 1-gold case like a 6-gold one and hand
   * a free 1.00 to a case with no gold at all. Absent on scorecards written before
   * the field existed — {@link ../lib/summarize} recomputes it from the results.
   */
  micro?: MicroReview;
  /** Internal recall vs. posted vs. inline. Absent for an arm that emits no
   * evidence packet — a clean degrade, never zeros. */
  boundaries?: BoundaryMetrics;
  /** Per-family funnel (obligations → hypotheses → posted → matched). Absent for
   * an arm that emits no evidence packet. */
  families?: FamilyFunnel[];
  avgInputTokens: number;
  avgCachedTokens: number;
  avgOutputTokens: number;
  totalCostUsd: number;
  p50DurationMs: number;
  errors: number;
}

export interface PendingCase {
  tier: string;
  model: string;
  instance_id: string;
  status: "running" | "pending";
  /** For a running case: the live-updating session jsonl path to follow. */
  sessionLog?: string;
}

/** Comparison axis: `models` compares N models forced across every step;
 * `config` compares deployment configs (per-step model maps). Absent ⇒ `models`. */
export type RunType = "models" | "config";

/** Which `lastlight-core` produced a run — a working tree or a published package. */
export interface CoreProvenance {
  root?: string;
  version?: string;
  published?: boolean;
}

/** Explicit repeat-group marker: N runs of one arm, deliberately repeated.
 * Optional — runs measured before it existed are grouped heuristically by
 * {@link ../lib/repeats}. */
export interface RepeatMeta {
  group: string;
  index?: number;
  of?: number;
  /** `--repeat-concurrency` when the band's repeats ran OVERLAPPED. Latency
   * reads on such a run are contaminated by contention; scores are not. */
  concurrency?: number;
}

export interface RunMeta {
  runId: string;
  generatedAt: string;
  runType?: RunType;
  tiers: string[];
  models: string[];
  runs: number;
  /** Cases of one arm run at once (`--concurrency N`). >1 ⇒ the arm's elapsed
   * time is not the sum of its cases; per-case/per-phase timings still are. */
  concurrency?: number;
  gitSha?: string;
  /** Which core produced the run. `gitSha` is the CWD's repo (often the evals
   * workspace, not the monorepo), so it does not answer this on its own. */
  core?: CoreProvenance;
  /** The overlay whose workflows/prompts/datasets the run used. */
  overlay?: string;
  /** Sandbox backend (`none` / `gondolin` / …). */
  sandbox?: string;
  /** Resolved analyser/tool versions, so silent version drift is detectable. */
  toolchain?: Record<string, string>;
  /** Set when this run is one of a deliberate repeat group. */
  repeat?: RepeatMeta;
  labels?: Record<string, string>;
  live?: boolean;
  progress?: string;
  pending?: PendingCase[];
  interrupted?: boolean;
  /** pr-review: this run's rank among Martian's Code Review Bench tools over the
   * PRs it covered (subset-fair). Absent unless the tier ships the sidecar. */
  martian?: MartianRanking;
}

/** One tool's (or our model's) micro-aggregated score over the covered PR subset. */
export interface MartianScore {
  key: string;
  name: string;
  tp: number;
  fp: number;
  fn: number;
  precision: number;
  recall: number;
  f1: number;
}

export interface MartianModelRank extends MartianScore {
  rank: number;
  of: number;
}

export interface MartianRanking {
  judgeModel: string;
  prCount: number;
  coveredInstances: string[];
  tools: MartianScore[];
  models: MartianModelRank[];
}

export interface Scorecard {
  models: ModelSummary[];
  results: InstanceResult[];
  meta?: RunMeta;
}

export interface TierSummary {
  tier: string;
  models: ModelSummary[];
}

export interface IndexRun {
  id: string;
  scorecard: string;
  runId: string;
  generatedAt: string;
  gitSha?: string;
  runType?: RunType;
  /** Arm labels under test (`meta.models`). Present even when `byTier` is still
   * empty (a live run with nothing graded yet), which is why the overview names
   * an arm from this rather than from the summaries. */
  models?: string[];
  /** The primary `--overlay` — the other half of the arm's identity. */
  overlay?: string;
  /** Set when this run is one repeat of a deliberate band; the key the overview
   * folds sibling runs into one row on. */
  repeat?: RepeatMeta;
  tiers: string[];
  labels: Record<string, string>;
  byTier: TierSummary[];
  runs: number;
  live: boolean;
  /** Was `live` but its writer died (killed/crashed) — show "interrupted". */
  interrupted?: boolean;
  progress?: string;
  running?: number;
  queued?: number;
}

export interface IndexTier {
  key: string;
  runs: IndexRun[];
}

export interface DashboardIndex {
  generatedAt: string;
  tiers: IndexTier[];
}
