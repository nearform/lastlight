/**
 * The PR state machine (issues #251, #252) — the eval harness's wiring.
 *
 * In production a PR-scoped workflow is never *called*; it is **dispatched**.
 * `dispatchWorkflow` resolves ONE `PrState` snapshot per dispatch and projects
 * it into the template context through `renderContext`, and that projection is
 * where the fix and merge prompts get essentially everything they reason with:
 * `{{ciSection}}`, `{{attempt}}` / `{{maxAttempts}}`, `{{priorAttempts}}`,
 * `{{priorNotes}}`, `{{verifyScript}}`, `{{flakyPromoted}}`, `{{mayMerge}}` and
 * its reason, `{{checksState}}`, `{{settledCheckCount}}`.
 *
 * A harness that builds its own `TemplateContext` by hand therefore does not run
 * a smaller version of production — it runs a DIFFERENT one, in which every
 * `{{#if}}` guard takes the empty branch and the agent is asked to diagnose a
 * red PR it has been told nothing about. Measuring that would be measuring the
 * harness, not the model.
 *
 * So this module does what `./repo-config.ts` does for the per-repo layer: it
 * supplies the one thing core normally reads from live GitHub (the snapshot),
 * and lets **core's own** `renderContext` do the projection, unmodified. There
 * is deliberately no second copy of that projection here — a copy is exactly the
 * defect issue #256 was filed about.
 *
 * ## How a case declares one
 *
 * ```jsonc
 * {
 *   "instance_id": "fix__flaky-timeout",
 *   "pr_state": {
 *     "attempt": 2,
 *     "checks_state": "failing",
 *     "ci_jobs": [{ "name": "CI / test", "log_excerpt": "…timed out…" }],
 *     "prior_attempts": ["DIAGNOSIS_COMPLETE: … class=flaky …"]
 *   }
 * }
 * ```
 *
 * Everything is optional; what a case omits takes a default that cannot itself
 * cause the agent to reason differently (a green-ish, first-attempt PR). The
 * fields are snake_case to match the rest of the dataset schema, and are mapped
 * onto core's camelCase `PrState` here rather than in the fixtures — so a
 * rename in core is a change in one place.
 *
 * ## What this does NOT do
 *
 * It does not evaluate the dispatch gate. `resolveFixDisposition` and friends
 * are pure functions over the snapshot, already table-tested in core without a
 * model; running them here would measure nothing new. What an eval can measure
 * — and unit tests cannot — is the half that needs a model: given a genuinely
 * red repository and a faithful context, does the agent reach the right
 * `class=`, and does it behave differently on the attempt where `flakyPromoted`
 * is set. The snapshot is therefore an INPUT here, never an assertion target.
 */

import {
  defaultDependenciesConfig,
  defaultFixConfig,
  renderContext,
  type CiFailureReport,
  type CiJobFailure,
  type DependenciesConfig,
  type FixConfig,
  type PrState,
} from "lastlight-core/evals";

/** One failing CI job, as a case writes it. */
export interface CiJobSeed {
  /** Check-run name, e.g. `CI / test (22)`. */
  name: string;
  /** `failure` (default) or `timed_out`. */
  conclusion?: string;
  /** The log tail the agent is handed — the evidence the diagnosis rests on. */
  log_excerpt: string;
  workflow_path?: string;
  failing_step?: string;
  /**
   * Whether the excerpt came from a real Actions log. Default true. Set false
   * to exercise the degraded path, where the prompt is told the excerpt is an
   * annotation fallback rather than a log.
   */
  logs_available?: boolean;
}

/**
 * The snapshot a case seeds. Every field optional — see the module header for
 * why the defaults are the inert ones.
 */
export interface PrStateSeed {
  head_sha?: string;
  head_ref?: string;
  base_ref?: string;
  is_draft?: boolean;
  is_fork?: boolean;
  labels?: string[];
  /** Aggregate over the head SHA's check runs. */
  checks_state?: "passing" | "failing" | "pending" | "none";
  settled_check_count?: number;
  base_checks_state?: "passing" | "failing" | "pending" | "none";
  /** Failing jobs. Present ⇒ the prompt's `{{ciSection}}` block is populated. */
  ci_jobs?: CiJobSeed[];
  /** Which attempt this run is. Drives `{{attempt}} of {{maxAttempts}}`. */
  attempt?: number;
  flaky_deferrals?: number;
  /** One marker line per prior attempt, oldest first — replayed into the prompt. */
  prior_attempts?: string[];
  /** The class the immediately preceding run diagnosed. */
  prior_diagnosis_class?: string;
  /** Journal notes earlier runs left (`<kind>: <line>`), rendered as `{{priorNotes}}`. */
  notes?: { kind: string; text: string; stale?: boolean }[];
  cumulative_cost_usd?: number;
  cost_baseline_usd?: number;
  /** Overrides on the two policy blocks; anything omitted takes the shipped default. */
  fix?: Partial<FixConfig>;
  dependencies?: Partial<DependenciesConfig>;
}

const CHECKS_DEFAULT = "none" as const;

function toCiReport(seeds: CiJobSeed[] | undefined): CiFailureReport | null {
  if (!seeds || seeds.length === 0) return null;
  const jobs: CiJobFailure[] = seeds.map((j) => ({
    name: j.name,
    conclusion: j.conclusion ?? "failure",
    logExcerpt: j.log_excerpt,
    logsAvailable: j.logs_available ?? true,
    ...(j.workflow_path ? { workflowPath: j.workflow_path } : {}),
    ...(j.failing_step ? { failingStep: j.failing_step } : {}),
    // A job whose logs are absent must carry a cause, or the renderer's banner
    // has nothing to name — `forbidden` is the one a case is realistically
    // reproducing (the App without `Actions: read`).
    ...(j.logs_available === false ? { logUnavailableCause: "forbidden" as const } : {}),
  }));
  const logsAvailable = jobs.some((j) => j.logsAvailable);
  return {
    jobs,
    logsAvailable,
    ...(logsAvailable ? {} : { logUnavailableCause: "forbidden" as const }),
  };
}

/**
 * Build the snapshot a dispatch would have resolved, from the case's seed.
 *
 * `repo`, `prNumber`, the refs and the title come from the instance itself
 * where the seed does not override them, so a case that declares no `pr_state`
 * at all still gets a coherent snapshot rather than an empty one.
 */
export function buildPrState(args: {
  repo: string;
  prNumber: number;
  title: string;
  body: string;
  branch: string;
  seed?: PrStateSeed;
}): PrState {
  const s = args.seed ?? {};
  const at = new Date().toISOString();
  return {
    repo: args.repo,
    prNumber: args.prNumber,
    headSha: s.head_sha ?? "e7a1d09",
    // The bot did not author the head unless a case says so — `headIsOurs` only
    // gates attempt bookkeeping, which this harness does not run.
    headAuthor: "dependabot[bot]",
    headIsOurs: false,
    headRef: s.head_ref ?? args.branch,
    baseRef: s.base_ref ?? "main",
    isDraft: s.is_draft ?? false,
    isFork: s.is_fork ?? false,
    headRepoFullName: args.repo,
    labels: s.labels ?? [],
    title: args.title,
    body: args.body,
    checksState: s.checks_state ?? CHECKS_DEFAULT,
    settledCheckCount: s.settled_check_count ?? 0,
    baseChecksState: s.base_checks_state ?? CHECKS_DEFAULT,
    botReviewAtHead: null,
    ciReport: toCiReport(s.ci_jobs),
    attempt: s.attempt ?? 1,
    flakyDeferrals: s.flaky_deferrals ?? 0,
    escalatedAtSha: null,
    escalatedBy: null,
    forkNoticedAtSha: null,
    priorAttempts: s.prior_attempts ?? [],
    notes: (s.notes ?? []).map((n) => ({
      at,
      runId: "eval",
      workflow: "eval",
      phase: "seed",
      kind: n.kind as never,
      text: n.text,
      ...(n.stale ? { stale: true } : {}),
    })),
    priorDiagnosisClass: (s.prior_diagnosis_class ?? null) as never,
    cumulativeCostUsd: s.cumulative_cost_usd ?? 0,
    costBaselineUsd: s.cost_baseline_usd ?? 0,
    assessedHeadShaByWorkflow: {},
    runInFlight: null,
    // A seeded snapshot is by construction a complete read. Leaving this empty
    // matters: a non-empty `readErrors` is what production treats as
    // `read-degraded`, and a case must not silently look like a 403.
    readErrors: [],
  };
}

/** The effective policy blocks for a case: shipped defaults under its overrides. */
export function prPolicy(seed?: PrStateSeed): {
  fix: FixConfig;
  dependencies: DependenciesConfig;
} {
  return {
    fix: { ...defaultFixConfig(), ...(seed?.fix ?? {}) },
    dependencies: { ...defaultDependenciesConfig(), ...(seed?.dependencies ?? {}) },
  };
}

/**
 * The context additions a PR-scoped run carries in production: core's own
 * projection of the snapshot, plus the two policy blocks `simple.ts` seeds
 * top-level so a prompt can render `{{fix.maxAttempts}}` /
 * `{{dependencies.autoMergeMaxImpact}}`.
 *
 * Returned as a patch rather than applied in place so the caller can see
 * exactly what the seam contributes — and so a workflow that is not PR-scoped
 * gets nothing at all.
 */
export function prContextPatch(args: {
  repo: string;
  prNumber: number;
  title: string;
  body: string;
  branch: string;
  seed?: PrStateSeed;
}): Record<string, unknown> {
  const state = buildPrState(args);
  const { fix, dependencies } = prPolicy(args.seed);
  return {
    ...renderContext(state, fix, dependencies),
    prNumber: args.prNumber,
    fix: fix as unknown as Record<string, unknown>,
    dependencies: dependencies as unknown as Record<string, unknown>,
  };
}
