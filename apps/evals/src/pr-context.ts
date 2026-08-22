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
  defaultReviewConfig,
  renderContext,
  resolveSpecContext,
  type CiFailureReport,
  type CiJobFailure,
  type DependenciesConfig,
  type FixConfig,
  type PrState,
  type ReviewConfig,
} from "lastlight-core/evals";

/**
 * The two reads `resolveSpecContext` makes. Declared structurally so the fake
 * only has to satisfy what is actually called — the same reasoning that lets a
 * `FakeGitHub` stand in as a `GitHubClient` for `fetchRepoConfigTree`.
 */
export interface SpecGitHub {
  listPullRequestClosingIssues: (
    owner: string,
    repo: string,
    pullNumber: number,
  ) => Promise<{ number: number; title: string; body: string; url?: string; state?: string }[]>;
  listPullRequestFilePaths: (
    owner: string,
    repo: string,
    pullNumber: number,
  ) => Promise<string[] | null>;
}

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
  /**
   * The issues the PR says it closes, with their bodies — the FIRST end of every
   * `spec` obligation (`docs/plans/review-evidence-pipeline/` §D7).
   *
   * Seeded rather than read, for the same reason the whole snapshot is: in
   * production `resolveSpecContext` fetches it from
   * `closingIssuesReferences`, and the fake GitHub answers GraphQL for one
   * mutation only. A case that omits it measures the axis with the PR body as
   * its only source, which is a weaker arm — not a broken one.
   */
  closes?: { number: number; title: string; body: string; state?: string; url?: string }[];
  /**
   * The PR's changed paths — the SECOND end. Absent ⇒ `null` ⇒ the obligation
   * builder emits nothing at all, which is the correct degradation: a
   * one-ended seed measured WORSE than no seed in IRIS's ablation.
   */
  changed_files?: string[];
  /** Overrides on the three policy blocks; anything omitted takes the shipped default. */
  fix?: Partial<FixConfig>;
  dependencies?: Partial<DependenciesConfig>;
  /**
   * `review:` overrides — in practice `{ analysis: { enabled: true } }`, which
   * is what turns the `spec` axis on for an arm. Off by default so every
   * existing case keeps measuring the shipped two-phase review.
   */
  review?: Partial<ReviewConfig>;
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
  /** Harness-derived changed paths; the case's own seed beats it. See {@link prContextPatch}. */
  changedFiles?: string[];
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
    // No prior posted review, so the generated-only re-review gate (issue #271)
    // has no baseline and never fires — an eval case reviews the diff it was
    // handed, every time.
    lastBotReview: null,
    pathsSinceLastBotReview: null,
    ciReport: toCiReport(s.ci_jobs),
    // The `spec` axis's two ends. Both inert unless the case seeds them AND the
    // arm turns `review.analysis` on — with the axis off, `renderContext` omits
    // every variable they feed, so a case that seeds neither is byte-identical
    // to one written before WP0.
    closes: (s.closes ?? []).map((c) => ({
      number: c.number,
      title: c.title,
      body: c.body,
      ...(c.state ? { state: c.state } : {}),
      ...(c.url ? { url: c.url } : {}),
    })),
    // `??`, not `||`: a case seeding `[]` is asserting "this PR changes no
    // files", which is a different fact from "we could not read the list" and
    // yields a different degraded message. Only a genuinely absent seed falls
    // through to the harness-derived set.
    changedFiles: s.changed_files ?? args.changedFiles ?? null,
    attempt: s.attempt ?? 1,
    flakyDeferrals: s.flaky_deferrals ?? 0,
    escalatedAtSha: null,
    // No seed key: an intervention is a fact about a HUMAN having asked, and
    // the harness has no human. It re-arms the budgets, so a case that seeded
    // one would be asserting against a snapshot the eval itself had un-stuck.
    intervention: null,
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

/**
 * A `review:` override as an ARM declares it — an overlay's `config.yaml` block,
 * which names only the keys it changes (and, inside `analysis`, only the leaves
 * it changes). `Partial<ReviewConfig>` is shallow, so `analysis` is widened here
 * rather than requiring a whole `ReviewAnalysisConfig`.
 */
export type ReviewOverride = Partial<Omit<ReviewConfig, "analysis">> & {
  analysis?: Partial<ReviewConfig["analysis"]>;
};

/**
 * The effective policy blocks for a case: shipped defaults under its overrides.
 *
 * Two override layers for `review`, applied in that order:
 *   1. the case's `pr_state.review` (gold), then
 *   2. the ARM's `review:` (its overlay `config.yaml`), which wins on the keys
 *      it names.
 *
 * The arm goes last because it is the axis under measurement: an overlay that
 * says `analysis.enabled: true` must produce a pipeline-on run for every case in
 * the tier, and a baseline overlay that says nothing about `analysis` must leave
 * whatever the case declared alone. A gold file can therefore never flip an arm.
 */
export function prPolicy(
  seed?: PrStateSeed,
  armReview?: ReviewOverride,
): {
  fix: FixConfig;
  dependencies: DependenciesConfig;
  review: ReviewConfig;
} {
  const reviewDefaults = defaultReviewConfig();
  return {
    fix: { ...defaultFixConfig(), ...(seed?.fix ?? {}) },
    dependencies: { ...defaultDependenciesConfig(), ...(seed?.dependencies ?? {}) },
    review: {
      ...reviewDefaults,
      ...(seed?.review ?? {}),
      ...(armReview ?? {}),
      // A one-level spread would drop `maxSpecObligations` the moment a case
      // seeded `{ analysis: { enabled: true } }`, so the nested block merges
      // leaf-by-leaf.
      analysis: {
        ...reviewDefaults.analysis,
        ...(seed?.review?.analysis ?? {}),
        ...(armReview?.analysis ?? {}),
      },
    },
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
export async function prContextPatch(args: {
  repo: string;
  prNumber: number;
  title: string;
  body: string;
  branch: string;
  seed?: PrStateSeed;
  /**
   * A `GitHubClient` pointed at the fake — the seam that makes the `spec` axis
   * production-shaped.
   *
   * `closes` and `changedFiles` are the only two fields on the snapshot that are
   * not facts a case *declares* but facts GitHub *computes*, and both went
   * missing here, one at a time, precisely because the harness was seeding them.
   * Given a client, core's own `resolveSpecContext` does both reads against the
   * fake exactly as `dispatchWorkflow` does against real GitHub — one GraphQL
   * (`closingIssuesReferences`) and one REST (`GET /pulls/:n/files`). No copy of
   * the resolution lives here.
   *
   * Omit it and the snapshot keeps whatever the case seeded, which is what every
   * non-pr-review tier does.
   */
  github?: SpecGitHub;
  /**
   * The ARM's `review:` policy (its overlay `config.yaml` block). This is how
   * `review.analysis.enabled` reaches a run — and therefore how core's
   * `specContext` comes to project `analysisEnabled`, the one key the review
   * evidence pipeline's phases gate on. See {@link prPolicy} for the precedence.
   */
  review?: ReviewOverride;
  /**
   * The PR's changed paths as the HARNESS derived them from the seeded checkout
   * — the fallback for the spec axis's second end.
   *
   * Production reads this from `listPullRequestFilePaths` inside
   * `resolveSpecContext`; the eval builds its own snapshot and so never calls
   * that. Without this the field stays `null`, which
   * `buildSpecObligations` correctly treats as "could not read" and refuses to
   * emit a one-ended seed for — silencing the entire `spec` family.
   *
   * A case's own `pr_state.changed_files` still wins, so a case can deliberately
   * measure the degraded path.
   */
  changedFiles?: string[];
}): Promise<Record<string, unknown>> {
  const state = buildPrState(args);

  // Production order, then the case's overrides. `resolveSpecContext` fills both
  // ends unconditionally and never throws (a failed read lands in `readErrors`
  // and leaves the field at the value that cannot cause a wrong claim), so the
  // seeds are re-applied AFTER it — otherwise a case that deliberately seeds
  // `changed_files: []` to measure the degraded path would have the resolver
  // quietly answer its question for it.
  if (args.github) {
    await resolveSpecContext(state, { github: args.github as never });
    if (args.seed?.closes) {
      state.closes = args.seed.closes.map((c) => ({
        number: c.number,
        title: c.title,
        body: c.body,
        ...(c.state ? { state: c.state } : {}),
        ...(c.url ? { url: c.url } : {}),
      }));
    }
    if (args.seed?.changed_files) state.changedFiles = args.seed.changed_files;
  }

  const { fix, dependencies, review } = prPolicy(args.seed, args.review);
  return {
    // `review` is passed but deliberately NOT seeded top-level the way `fix` and
    // `dependencies` are: `build.yaml` already emits `output_var: review`, and a
    // top-level object would shadow it (see `apps/server/CLAUDE.md`).
    ...renderContext(state, fix, dependencies, review),
    prNumber: args.prNumber,
    fix: fix as unknown as Record<string, unknown>,
    dependencies: dependencies as unknown as Record<string, unknown>,
  };
}
