/**
 * Mirror of the JSON the harness writes (`src/report.ts` + `src/schema.ts`).
 * The dashboard is a separate Vite app, so these are hand-kept in sync with the
 * harness — the `/api/index` and `/data/.../scorecard.json` contracts.
 */

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
  avgInputTokens: number;
  avgCachedTokens: number;
  avgOutputTokens: number;
  totalCostUsd: number;
  p50DurationMs: number;
  errors: number;
}

export interface Check {
  name: string;
  ok: boolean;
  detail?: string;
}

/** One workflow phase's archived session (mirrors harness `schema.ts`). */
export interface PhaseSession {
  phase: string;
  success?: boolean;
  /** Relative path (under the run dir) of this phase's session jsonl. */
  log: string;
}

/** One trial's archived session: per-phase logs + a consolidated `full`. */
export interface TrialSession {
  trial: number;
  full?: string;
  phases: PhaseSession[];
}

/** Per-phase metrics (mirrors harness `schema.ts`). `model` is the model the
 * phase resolved to — the forced model in `models` runs, the per-step model the
 * merged config assigned in `config` runs. */
export interface PhaseMetric {
  phase: string;
  success: boolean;
  model?: string;
  inputTokens?: number;
  outputTokens?: number;
  costUsd?: number;
  durationMs?: number;
}

/** The judge's inspectable working for one pr-review grade. `matchedGold` /
 * `matchedFinding` are the paired index into the sibling array, or null when
 * unmatched (a false positive / a missed gold). */
export interface ReviewTrace {
  judgeModel: string;
  reviewText: string;
  findings: { description: string; file?: string; matchedGold: number | null }[];
  gold: { description: string; severity: string; matchedFinding: number | null }[];
  rawExtract?: string;
  rawMatch?: string;
  /** Whether the PR diff was fed to the judge (`--judge-with-diff`). */
  usedDiff?: boolean;
}

export interface InstanceResult {
  instance_id: string;
  model: string;
  tier?: string;
  workflowSucceeded: boolean;
  /** Per-phase metrics; carries the per-step model map in `config` runs. */
  phases?: PhaseMetric[];
  resolved?: boolean;
  /** Per-test verdicts from the held-out test run (code-fix). */
  failToPass?: { id: string; pass: boolean }[];
  passToPass?: { id: string; pass: boolean }[];
  /** Run-relative path of the captured held-out test output (setup log + TAP),
   * shown in the "tests" view for resolved and unresolved cases alike. */
  executionLog?: string;
  /** Run-relative path of the agent's diff (`changes.diff`), captured vs the
   * seeded base (code-fix only). Resolves against the scorecard URL like
   * `executionLog`; powers the "files" diff viewer. Absent for triage. */
  modelPatchFile?: string;
  behavioral?: { ok: boolean; checks: Check[] };
  /** PR-review grade (pr-review tier): the posted review scored against the gold
   * set via LLM judge (F-beta; F1 by default).  */
  review?: {
    precision: number;
    recall: number;
    fbeta: number;
    beta: number;
    posted: number;
    gold: number;
    matched: number;
    falsePositives: { description: string; file?: string }[];
    falseNegatives: { description: string; file?: string; severity: string }[];
    /** The judge's inspectable working, shown by the "judge" button. */
    trace?: ReviewTrace;
  };
  reviewTrials?: number;
  trials?: number;
  trialErrors?: number;
  behavioralPass?: number;
  resolvedPass?: number;
  githubMutations?: number;
  /** Archived agent sessions — one per trial, each split per workflow phase.
   * Relative paths resolve against the run's scorecard URL. */
  sessions?: TrialSession[];
  inputTokens: number;
  cachedTokens: number;
  outputTokens: number;
  costUsd: number;
  durationMs: number;
  /** A real run failure (provider/credit/timeout/crash). */
  error?: string;
  /** The workflow stopped on a deliberate gate decision (e.g. guardrails) — a
   * legitimate "unresolved" outcome, NOT an error. */
  blocked?: boolean;
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

export interface RunMeta {
  runId: string;
  generatedAt: string;
  runType?: RunType;
  tiers: string[];
  models: string[];
  runs: number;
  gitSha?: string;
  labels?: Record<string, string>;
  live?: boolean;
  progress?: string;
  pending?: PendingCase[];
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
