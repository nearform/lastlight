/**
 * Eval data model — SWE-bench-compatible.
 *
 * A benchmark case is a {@link SweBenchInstance}. The core fields mirror the
 * SWE-bench / SWE-bench Lite dataset schema field-for-field (`instance_id`,
 * `base_commit`, `problem_statement`, gold `patch`, held-out `test_patch`,
 * `FAIL_TO_PASS`, `PASS_TO_PASS`), so a case is interchangeable with a real
 * SWE-bench row and our results export to SWE-bench's predictions format.
 *
 * The `Last Light extensions` block (ignored by real SWE-bench) carries the
 * GitHub fixtures + behavioral expectations that let us drive — and grade —
 * the REAL production workflow with a mocked GitHub.
 */

/** A comment to seed onto an issue in the fake GitHub. */
export interface IssueCommentSeed {
  user: string;
  body: string;
}

/** Seed state for one GitHub issue, served by the fake GitHub. */
export interface IssueSeed {
  number: number;
  title: string;
  body: string;
  /** Labels already on the issue before the workflow runs. */
  labels?: string[];
  comments?: IssueCommentSeed[];
  user?: string;
  state?: "open" | "closed";
}

/** Assertions on the GitHub mutations the workflow performed (recorded by the
 * fake server). Every field is optional — only the ones present are checked. */
export interface ExpectGithub {
  /** All of these labels must end up on the target issue. */
  labels_added?: string[];
  /** None of these labels may be added. */
  labels_absent?: string[];
  /** The issue must be closed (state → closed). */
  issue_closed?: boolean;
  /** At least one comment whose body matches this (case-insensitive) regex. */
  comment_matches?: string;
  /** A pull request must have been opened, optionally constrained. */
  pr_opened?: {
    base?: string;
    /** The PR head ref must equal the run's working branch. */
    head_is_branch?: boolean;
    /** PR title must match this (case-insensitive) regex. */
    title_matches?: string;
  };
}

export interface SweBenchInstance {
  // ── SWE-bench core (schema-compatible) ──────────────────────────────────
  instance_id: string;
  /** "owner/name" — logical; the fixture origin is a local bare repo. */
  repo: string;
  base_commit?: string;
  /** The issue text handed to the agent (also seeded into the fake GitHub). */
  problem_statement: string;
  /** Gold patch — reference only; NOT used to grade. */
  patch?: string;
  /** Held-out tests, applied AFTER the agent runs (kept out of the agent's repo). */
  test_patch?: string;
  /** Test ids expected to go red→green. */
  FAIL_TO_PASS?: string[];
  /** Test ids that must stay green. */
  PASS_TO_PASS?: string[];
  environment_setup_commit?: string;
  version?: string;

  // ── Last Light extensions (ignored by real SWE-bench) ───────────────────
  /** Which real production workflow to run (default depends on the tier). */
  workflow?: string;
  /** Issue fixtures served by the fake GitHub (triage & code-fix). */
  issue?: IssueSeed;
  /** Behavioral grading expectations on recorded GitHub calls. */
  expect_github?: ExpectGithub;
  /** For triage: the gold triage decision (category + state role names). */
  triage_gold?: { category?: string; state?: string };
}

// ── Results ───────────────────────────────────────────────────────────────

export interface PhaseMetric {
  phase: string;
  success: boolean;
  /** The model this phase resolved to. In `models` runs it equals the run's
   * forced model; in `config` runs it's the per-step model the merged config
   * assigned (the payoff signal that surfaces the per-phase model map). */
  model?: string;
  inputTokens?: number;
  outputTokens?: number;
  costUsd?: number;
  durationMs?: number;
}

/** One workflow phase's archived agent session, for the dashboard log viewer. */
export interface PhaseSession {
  /** Workflow node name (e.g. `guardrails`, `architect`, `build`; `issue-triage`
   * for the single-phase triage workflow). */
  phase: string;
  success?: boolean;
  /** Relative path (under the run dir) of this phase's session jsonl. */
  log: string;
}

/** One trial's archived session: the per-phase logs plus a `full` consolidated
 * transcript (the whole agent run across phases, also used for live-follow). */
export interface TrialSession {
  /** 1-based trial index (>1 only when `--runs N`). */
  trial: number;
  /** Relative path of the consolidated transcript across all phases. */
  full?: string;
  phases: PhaseSession[];
}

export interface InstanceResult {
  instance_id: string;
  /** The run arm's axis label: a model id in `models` runs, the config/overlay
   * name in `config` runs (see {@link RunMeta.runType}). Results group by this
   * field into scorecard rows, and the per-case session dir is keyed on it. */
  model: string;
  /** Which tier this instance belongs to (triage / code-fix). */
  tier?: string;
  /** Workflow completed without a hard failure. */
  workflowSucceeded: boolean;
  /** Execution grade (code-fix): all FAIL_TO_PASS green + all PASS_TO_PASS green. */
  resolved?: boolean;
  failToPass?: { id: string; pass: boolean }[];
  passToPass?: { id: string; pass: boolean }[];
  /** Behavioral grade: did the workflow take the expected GitHub actions? */
  behavioral?: { ok: boolean; checks: { name: string; ok: boolean; detail?: string }[] };
  /** When `--runs N` (N>1): how many non-errored trials this result aggregates,
   * and how many of them passed each verdict. The binary `behavioral.ok` /
   * `resolved` above are WORST-case (true only if every trial passed); these
   * counts expose the variance. Absent for single-run (N=1) results. */
  trials?: number;
  trialErrors?: number;
  behavioralPass?: number;
  resolvedPass?: number;
  /** Count of mutating GitHub calls the workflow made against the fake server.
   * A mechanism signal: >0 proves the real github_* tools reached the mock. */
  githubMutations?: number;
  /** SWE-bench predictions: unified diff of the agent's edits. */
  model_patch?: string;
  /** Archived agent sessions for this case — one {@link TrialSession} per trial
   * (`--runs N` keeps them all), each split per workflow phase. The dashboard
   * resolves the relative paths against the run's scorecard URL to render the
   * transcript. Absent if no log was captured. */
  sessions?: TrialSession[];
  /** Set on a single trial's result by run-instance (one trial = one
   * TrialSession); the runner folds these into {@link sessions}. */
  sessionTrial?: TrialSession;
  /** Aggregate metrics across phases. */
  inputTokens: number;
  /** Cached prompt tokens (Anthropic cache read + creation), tracked separately
   * from `inputTokens` — see RunMetrics in metrics.ts. */
  cachedTokens: number;
  outputTokens: number;
  costUsd: number;
  durationMs: number;
  phases: PhaseMetric[];
  /** A real RUN failure — provider auth/credit/rate, timeout, or a crash. Counts
   * toward the runner's non-zero exit. NOT set for a {@link blocked} workflow. */
  error?: string;
  /** The workflow stopped on a deliberate gate decision (e.g. guardrails judged
   * the repo/issue unfit to build) rather than failing. A legitimate measured
   * outcome — the case is unresolved, but this is NOT a harness error and does
   * not affect the exit code. */
  blocked?: boolean;
}
