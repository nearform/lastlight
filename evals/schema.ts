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
  inputTokens?: number;
  outputTokens?: number;
  costUsd?: number;
  durationMs?: number;
}

export interface InstanceResult {
  instance_id: string;
  model: string;
  /** Workflow completed without a hard failure. */
  workflowSucceeded: boolean;
  /** Execution grade (code-fix): all FAIL_TO_PASS green + all PASS_TO_PASS green. */
  resolved?: boolean;
  failToPass?: { id: string; pass: boolean }[];
  passToPass?: { id: string; pass: boolean }[];
  /** Behavioral grade: did the workflow take the expected GitHub actions? */
  behavioral?: { ok: boolean; checks: { name: string; ok: boolean; detail?: string }[] };
  /** Count of mutating GitHub calls the workflow made against the fake server.
   * A mechanism signal: >0 proves the real github_* tools reached the mock. */
  githubMutations?: number;
  /** SWE-bench predictions: unified diff of the agent's edits. */
  model_patch?: string;
  /** Aggregate metrics across phases. */
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  durationMs: number;
  phases: PhaseMetric[];
  error?: string;
}
