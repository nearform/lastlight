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

/** A prior PR-level review to seed (the pr-review skill reads the existing
 * discussion and must not re-raise resolved threads). */
export interface ReviewSeed {
  user: string;
  body: string;
  /** APPROVED / CHANGES_REQUESTED / COMMENTED. */
  state?: "APPROVED" | "CHANGES_REQUESTED" | "COMMENTED";
}

/** A prior inline review comment to seed (path + line + body). */
export interface ReviewCommentSeed {
  user: string;
  path: string;
  line?: number;
  body: string;
}

/** Seed state for one pull request, served by the fake GitHub for the
 * `pr-review` tier. The head/base refs + commits also drive the workspace
 * checkout (see {@link seedWorkspacePrReview}); the `pull_number` lets the seed
 * fetch the immutable `refs/pull/<n>/head` ref so a squash-merged PR's head
 * commit is still reachable. */
export interface PullSeed {
  number: number;
  title: string;
  body: string;
  base_ref: string;
  head_ref: string;
  base_commit: string;
  head_commit: string;
  state?: "open" | "closed";
  user?: string;
  /** Prior PR discussion the skill reads (advance, don't restart). */
  reviews?: ReviewSeed[];
  review_comments?: ReviewCommentSeed[];
  issue_comments?: IssueCommentSeed[];
}

/** One changed file in a PR, in GitHub's `GET /pulls/:n/files` shape. The fake
 * GitHub serves these so a review agent that lists a PR's files via the API
 * (instead of a local `git diff`) gets the real changed set + per-file patch.
 * Computed from `git diff base..head` in the seeded workspace — see
 * `prFilesFromGit`. */
export interface PullFile {
  sha: string;
  filename: string;
  status: "added" | "removed" | "modified";
  additions: number;
  deletions: number;
  changes: number;
  /** The unified-diff hunks for this file (GitHub's `patch`); absent for binary
   * files, which carry no textual hunks. */
  patch?: string;
}

/** One human-verified "golden comment" — a real issue a reviewer should catch.
 * Mirrors Martian's Code Review Bench gold-set shape. Used only to grade the
 * `pr-review` tier (LLM judge match → precision/recall/F-beta). */
export interface GoldComment {
  /** File the issue lives in. Optional — Martian's gold set carries only a
   * description + severity, so the judge matches on substance, not location. */
  file?: string;
  line?: number;
  severity: "low" | "medium" | "high" | "critical";
  description: string;
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
  /** A formal PR review must have been submitted (pr-review tier). A cheap
   * deterministic proxy alongside the LLM-judge precision/recall grade. */
  review_submitted?: {
    event?: "APPROVE" | "REQUEST_CHANGES" | "COMMENT";
    /** The review body must match this (case-insensitive) regex. */
    body_matches?: string;
  };
}

export interface SweBenchInstance {
  // ── SWE-bench core (schema-compatible) ──────────────────────────────────
  instance_id: string;
  /** "owner/name". For a vendored fixture (`repos/<id>/`) the origin is a local
   * bare repo and this is logical. For a **git-source** case (no fixture dir) it
   * is the real GitHub repo the harness clones at run time. */
  repo: string;
  /** SWE-bench base commit. Unused for vendored fixtures (the harness synthesizes
   * its own base). For a git-source case it is the real upstream SHA checked out
   * into the sandbox — see `seedWorkspaceFromGit`. */
  base_commit?: string;
  /** The issue text handed to the agent (also seeded into the fake GitHub). */
  problem_statement: string;
  /** Gold patch — reference only; NOT used to grade. */
  patch?: string;
  /** Held-out tests, applied AFTER the agent runs (kept out of the agent's repo).
   * Only used when {@link hold_out_tests} is set — otherwise ignored. */
  test_patch?: string;
  /** Opt into SWE-bench-style **held-out** grading: the maintainer's `test_patch`
   * is hidden from the agent and applied only at grade time, scored by named
   * `FAIL_TO_PASS` / `PASS_TO_PASS`. Default (absent/false) is **suite mode**: run
   * the repo's own `test_cmd` on the agent's final tree, resolved iff it exits 0 —
   * nothing held out, nothing applied. */
  hold_out_tests?: boolean;
  /** Test ids expected to go red→green (hold-out mode only). Empty/absent ⇒ suite
   * mode (graded on the test command's exit code rather than per-test TAP names). */
  FAIL_TO_PASS?: string[];
  /** Test ids that must stay green (hold-out mode only). */
  PASS_TO_PASS?: string[];
  environment_setup_commit?: string;
  version?: string;
  /** Held-out test command argv (default: `node --test` over discovered files).
   * Set for repos that use another runner, e.g. `["npm","test"]`. */
  test_cmd?: string[];
  /** Optional install/build argv run in the workspace BEFORE the held-out tests
   * (e.g. `["npm","ci"]`). Runs untrusted repo code — git-source cases only. */
  setup_cmd?: string[];
  /** PR head SHA — reference/authoring provenance (the gold `patch` is its diff
   * against `base_commit`). Not used at run time. */
  head_commit?: string;

  // ── Last Light extensions (ignored by real SWE-bench) ───────────────────
  /** Which real production workflow to run (default depends on the tier). */
  workflow?: string;
  /** Issue fixtures served by the fake GitHub (triage & code-fix). */
  issue?: IssueSeed;
  /** PR fixture served by the fake GitHub (pr-review tier). Drives both the
   * mocked PR endpoints and the head-ref workspace checkout. */
  pr?: PullSeed;
  /** Behavioral grading expectations on recorded GitHub calls. */
  expect_github?: ExpectGithub;
  /** For triage: the gold triage decision (category + state role names). */
  triage_gold?: { category?: string; state?: string };
  /** For pr-review: the human-verified gold set the posted review is scored
   * against (LLM judge → precision/recall/F-beta). */
  review_gold?: GoldComment[];
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
  /** PR-review grade (pr-review tier): the posted review scored against the gold
   * set via LLM judge. `posted` = distinct findings the agent raised, `gold` =
   * golden comments, `matched` = findings that matched a gold comment. `fbeta` is
   * the F-beta at `beta` — β=1 (F1) by default, matching Martian's leaderboard;
   * `EVAL_F_BETA` reweights (β=0.5 → precision 2×). */
  review?: {
    precision: number;
    recall: number;
    fbeta: number;
    beta: number;
    posted: number;
    gold: number;
    matched: number;
    /** Findings the agent raised that matched no gold comment. */
    falsePositives: { description: string; file?: string }[];
    /** Gold comments the agent missed. */
    falseNegatives: { description: string; file?: string; severity: string }[];
    /** The judge's inspectable working (dashboard "judge" button): what it read,
     * the findings it distilled, the gold set, the finding↔gold pairing, and its
     * raw replies. Absent when the judge never ran. */
    trace?: {
      judgeModel: string;
      reviewText: string;
      findings: { description: string; file?: string; matchedGold: number | null }[];
      gold: { description: string; severity: string; matchedFinding: number | null }[];
      rawExtract?: string;
      rawMatch?: string;
      /** Whether the PR diff was fed to the judge (`--judge-with-diff`). */
      usedDiff?: boolean;
    };
  };
  /** When `--runs N`: how many trials the mean review metrics aggregate. */
  reviewTrials?: number;
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
  /** SWE-bench predictions: unified diff of the agent's edits. Kept in-memory for
   * `predictions.jsonl`, but STRIPPED from the serialized `scorecard.json` (see
   * `writeScorecard`) so the live-polled scorecard stays lean — the dashboard
   * reads the diff from {@link modelPatchFile} instead. */
  model_patch?: string;
  /** Relative path (under the run dir) of the agent's diff persisted as a
   * discrete `changes.diff` artifact beside the trial's logs (mirrors
   * {@link executionLog}). What the dashboard's "files" diff viewer fetches;
   * publishes with the run tree. Code-fix only. */
  modelPatchFile?: string;
  /** Relative path (under the run dir) of the held-out test output captured at
   * grade time (setup log + TAP). The dashboard's "tests" view shows it — for
   * both resolved and unresolved cases — so you can see exactly what ran and why
   * each FAIL_TO_PASS / PASS_TO_PASS test passed or failed. */
  executionLog?: string;
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
