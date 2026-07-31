/**
 * The PR state machine — one resolved snapshot per dispatch.
 *
 * Before this module, what the harness "knew" about a pull request was read
 * from six sites (`dependencyDedupSkip`, `handlePrFix`, `dispatchWorkflow`,
 * `review-discovery`, and both dependency cron sweeps), each fetching an
 * overlapping subset and each free to disagree — while the state itself lived
 * across seven stores (GitHub labels, the `last-light/review` check run, run
 * `context`, run `scratch`, execution status, live GitHub reads, and a file in
 * the sandbox workspace). Three shipped-defect-grade bugs fell out of that; see
 * `docs/plans/dependency-pr-resilience/09-state-machine.md`.
 *
 * The fix is structural, not incremental: **resolve the PR's state once, then
 * decide**. `resolvePrState` is the only place that reads it; every policy
 * question is a PURE function over the result (`../engine/pr-decisions.ts`), so
 * the decisions are table-testable against literal fixtures with no GitHub mock
 * and no sandbox.
 *
 * {@link PrState} is therefore the documentation of the state machine: it can be
 * read, reviewed and diffed, which prose across ten documents cannot.
 */

import type { StateDb } from "../state/db.js";
import type { WorkflowRun } from "../state/workflow-run-store.js";
import type { GitHubClient } from "./github/github.js";
import type { CiFailureReport } from "./github/github.js";
import { PR_FIX_SHAPED_WORKFLOWS } from "../workflows/target-policy.js";
import { REQUIRES_HUMAN_LABEL } from "../cron/dependabot-discovery.js";
import { readHarvestedMarkers, type HarvestedFixMarkers } from "./fix-harvest.js";
import {
  ATTEMPT_FREE_CLASSES,
  boundAttemptLines,
  renderAttemptLine,
  type DiagnosisClass,
} from "./fix-markers.js";
import { boundNotes, coerceNotes, markNotesStale, type PrNote } from "./pr-notes.js";

/** Aggregate check state for a ref, as {@link GitHubClient.getChecksConclusion} reports it. */
export type ChecksState = "passing" | "failing" | "pending" | "none";

/**
 * Everything the harness knows about one pull request at one moment.
 *
 * Two halves, deliberately kept visually separate:
 *
 * - **live from GitHub** — facts about the PR right now. Nothing here is a
 *   verdict of ours, which is what makes it safe to gate dispatch on: a live
 *   precondition re-evaluates every event, whereas a stored verdict freezes
 *   (see `resolveFixDisposition` and 09 → D1).
 * - **derived from our own history, keyed on the PR** — what WE have already
 *   done about it. Keyed on (`PR_FIX_SHAPED_WORKFLOWS`, PR), never on one
 *   workflow, because "how many times have we tried to fix this PR" is a fact
 *   about the pull request (09 → S1).
 *
 * A snapshot is persisted verbatim on the run context (`context.prState`) so
 * the run detail panel can render the decisions that were actually taken, with
 * the inputs that produced them, long after the live state has moved on.
 */
export interface PrState {
  // ── live from GitHub ───────────────────────────────────────────────────────

  /** `owner/repo`. */
  repo: string;
  prNumber: number;

  /** Head commit SHA. The identity of "the problem" for the attempt counter. */
  headSha: string;
  /**
   * The git AUTHOR NAME on the head commit — not a GitHub login.
   *
   * `git-auth.ts` stamps `user.name = botLogin` on the agent's own commits, and
   * the `check_suite` webhook carries the same field, so this is the one value
   * that answers "did we push this head?" identically on both routes.
   */
  headAuthor: string;
  /**
   * `headAuthor === botLogin` — did WE push the head commit?
   *
   * Derived here rather than left to each call site so the decision functions
   * stay pure over the snapshot and never need the bot identity. It is the
   * discriminator behind both the attempt table (our push = same problem;
   * anyone else's = the world moved) and the stateful `requires-human` guard
   * (our own commit on top of an escalation does not count as intervention).
   */
  headIsOurs: boolean;
  /** The PR's head branch — what a fix run clones and pushes to. */
  headRef: string;
  /**
   * The PR's REAL base ref.
   *
   * Not `getDefaultBranch()`. A PR targeting a release branch used to have the
   * fix prompt merge `main` into it (00 → "Other latent bugs found" #3).
   */
  baseRef: string;
  isDraft: boolean;
  /**
   * Cross-repo (fork) PR. Its head branch lives on a repo we cannot push to and
   * its head ref is not on origin, so there is nothing for a fix run to clone
   * or push. `head.repo === null` (the fork was deleted) counts as a fork too:
   * the branch is gone either way.
   */
  isFork: boolean;
  /** `owner/repo` of the head, or null when the source fork was deleted. */
  headRepoFullName: string | null;
  labels: string[];
  title: string;
  body: string;

  checksState: ChecksState;
  /**
   * How many checks/statuses have actually SETTLED on the head SHA.
   *
   * `"passing"` on its own is not evidence: a repo with one trivial check and a
   * repo with a full matrix both report it, and a repo with none reports
   * `"none"`. The auto-merge decision needs to tell "CI approved this" from
   * "nothing looked at it" (09 → D10, `dependencies.minSettledChecks`).
   */
  settledCheckCount: number;
  /**
   * Check state of the BASE branch tip — the sole signal for `upstream-broken`.
   * A live precondition, never a stored verdict: see `resolveFixDisposition`.
   */
  baseChecksState: ChecksState;
  /**
   * The bot's own most recent review AT THE CURRENT HEAD SHA, or null. A push
   * invalidates it naturally (GitHub records the review's `commit_id`).
   */
  botReviewAtHead: { state: string } | null;
  /**
   * Structured CI evidence for the head SHA (Phase 1), or null when the checks
   * are not failing — the report costs one Actions job-log download per failed
   * check, so it is only fetched when there is something to explain.
   */
  ciReport: CiFailureReport | null;

  // ── derived from our own history, keyed on the PR ───────────────────────────

  /**
   * Which attempt at THIS PROBLEM the next fix run would be — 1-based.
   *
   * `attempt` is scoped to a problem, not to a PR (09 → S1):
   *
   * | live head vs prior | new head's author | attempt      |
   * |--------------------|-------------------|--------------|
   * | unchanged          | —                 | prior + 1    |
   * | changed            | us (`botLogin`)   | prior + 1    |
   * | changed            | anyone else       | **1**        |
   *
   * The third row is what lets a maintainer's push, a Dependabot rebase or a
   * Renovate recreate re-arm the loop. Resetting on author alone would be
   * wrong too: an attempt that pushes nothing leaves the head unchanged, which
   * would reset forever.
   */
  attempt: number;
  /** Consecutive `flaky` diagnoses so far, bounded by `fix.maxFlakyDeferrals`. */
  flakyDeferrals: number;
  /** Head SHA at which one of OUR runs escalated this PR, or null. */
  escalatedAtSha: string | null;
  /**
   * Who put `requires-human` on this PR:
   * - `"us"` — a run of ours escalated it (we know the SHA, so a later push
   *   clears the guard automatically).
   * - `"human"` — the label is present but no run of ours escalated: a
   *   maintainer applied it to mean "bot, stay out". A hard, permanent
   *   override.
   * - `null` — not escalated.
   */
  escalatedBy: "us" | "human" | null;
  /** One marker line per prior attempt, oldest first — rendered as `{{priorAttempts}}`. */
  priorAttempts: string[];
  /**
   * The PR's journal — short, bounded notes agents left for later runs
   * (10-pr-memory.md, `./pr-notes.ts`).
   *
   * A FIELD of the snapshot, never a store beside it. That is the whole point:
   * 09's thesis is that state scattered across stores and free to disagree is
   * the defect, and a free-form scratchpad alongside `PrState` would recreate
   * it. As a field it is resolved once, persisted with the rest of the snapshot,
   * and rendered wherever the snapshot is.
   *
   * Keyed on the PR like everything else here, so `pr-review` reads what
   * `dependabot-ci-fix` learned.
   *
   * **Hints, never instructions.** Nothing in this array may authorise anything.
   * No decision function reads it — `renderContext` projects it to a single
   * FENCED STRING for the prompts and that is its only consumer, so a note can
   * inform an agent and can never make a code path reachable. See
   * `./pr-notes.ts` → the fence, and the rejection of any note carrying a token
   * the marker parser reads.
   */
  notes: PrNote[];
  /**
   * The class the IMMEDIATELY PRECEDING run diagnosed, or null.
   *
   * The only prior-run verdict any dispatch decision is allowed to read, and it
   * is allowed only because the skip it produces WRITES A RUN ROW (09 → D1's
   * general rule; see `resolveFixDisposition`). Null when that run produced no
   * `DIAGNOSIS_COMPLETE`, when the token was unrecognised, or when the problem
   * is fresh.
   *
   * Deliberately NOT carried across a run that diagnosed nothing — unlike
   * {@link flakyDeferrals}, which persists. That asymmetry is what keeps the
   * manual exit working: a maintainer who removes `requires-human` by hand is
   * asking for another try, and a remembered `infra-dependent` would re-escalate
   * on the next event and put the label straight back.
   */
  priorDiagnosisClass: DiagnosisClass | null;
  /** Cumulative USD across every fix-family run for this PR (`fix.maxCostUsd`). */
  cumulativeCostUsd: number;
  /**
   * Head SHA the most recent SUCCEEDED run of each PR-scoped workflow saw —
   * the "already assessed at this SHA" dedup, per workflow.
   *
   * Per-workflow even though the attempt counter is per-family: `pr-fix` having
   * succeeded at a SHA says nothing about whether `dependabot-pr-merge` has
   * assessed it. SUCCEEDED-only is what makes a retry possible at all — a
   * crashed run leaves no entry, so the same head is attempted again. This only
   * works because correct-but-stopped outcomes (`flaky`, `infra-dependent`,
   * `upstream-broken`) now record `succeeded`: before that, the dedup did not
   * fire for exactly the cases that must not be re-attempted.
   */
  assessedHeadShaByWorkflow: Record<string, string>;
  /**
   * A PR-scoped run already in flight, or null. The lock is across EVERY
   * PR-scoped workflow, not per family (09 → S4).
   */
  runInFlight: { workflow: string; runId: string } | null;
  /**
   * The GitHub reads that failed while resolving, if any.
   *
   * FAIL-OPEN IS LOAD-BEARING. Every read below is best-effort and every
   * failure degrades to a value that cannot cause a skip — we would far rather
   * occasionally re-run than silently drop a genuine event because GitHub had a
   * bad minute. Decisions that would be unsafe on incomplete data check this
   * list explicitly rather than inferring it from a suspicious-looking field.
   */
  readErrors: string[];
}

/**
 * Every PR-scoped workflow — the span of the run lock (09 → S4).
 *
 * `db.executions.isRunning(handler, triggerId)` was supposed to be this guard
 * and is not: it keys on the WORKFLOW name while phase ledger rows are keyed
 * `"<workflow>:<phase>"`, and on the bare issue number while the ledger uses
 * `owner/repo#N`. So nothing has ever stopped an `@bot fix this` comment routed
 * to `pr-fix` running concurrently with a `fix-red-dependency-prs` dispatch of
 * `dependabot-ci-fix` — two agents, two clones of the same branch, both
 * pushing. It also closes the case where `dependabot-pr-merge` enables
 * auto-merge against a PR whose fix run is still in flight.
 */
export const PR_SCOPED_WORKFLOWS = new Set([
  ...PR_FIX_SHAPED_WORKFLOWS,
  "dependabot-pr-merge",
  "pr-review",
]);

/** The trigger id every PR-scoped run and ledger row is keyed by. */
export function prTriggerId(repo: string, prNumber: number): string {
  return `${repo}#${prNumber}`;
}

/** Collaborators {@link resolvePrState} reads through. */
export interface PrStateDeps {
  /** `null` in chat-only mode — the live half then degrades wholesale. */
  github: GitHubClient | null;
  db: StateDb;
  /** `<botName>[bot]` — the git author name our own commits carry. */
  botLogin: string;
  /**
   * The App SLUG (`botName`, no `[bot]` suffix) — the `app.slug` GitHub stamps
   * on the check runs WE post.
   *
   * Every check read below is a TRIGGER-side settle computation, so our own
   * `last-light/review` check must be excluded from it or a queued/in-progress
   * review deadlocks the aggregate at `pending` forever (see
   * {@link ChecksQueryOptions.excludeApp}). Optional, and derived from
   * {@link botLogin} when absent, so a caller that only knows the login (every
   * existing test) still gets the exclusion.
   */
  botName?: string;
}

/** The App slug behind a `<slug>[bot]` login. */
function appSlug(deps: PrStateDeps): string | undefined {
  const slug = deps.botName || deps.botLogin.replace(/\[bot\]$/, "");
  return slug || undefined;
}

/**
 * The persisted shape of a prior run's snapshot, as read back off
 * `workflow_runs.context.prState`. Everything is optional because a run row
 * written before this module existed has none of it.
 */
type PersistedPrState = Partial<PrState>;

/**
 * Resolve the whole snapshot. Called ONCE per dispatch, at the
 * `dispatchWorkflow` choke point every route crosses.
 *
 * Never throws. Every live read is independently best-effort; a failure records
 * a line in {@link PrState.readErrors} and leaves the field at a value that
 * cannot itself cause a skip.
 */
export async function resolvePrState(
  owner: string,
  repo: string,
  prNumber: number,
  deps: PrStateDeps,
): Promise<PrState> {
  const full = `${owner}/${repo}`;
  const readErrors: string[] = [];
  const note = (what: string, err: unknown) => {
    const msg = err instanceof Error ? err.message : String(err);
    readErrors.push(`${what}: ${msg}`);
    console.warn(`[pr-state] ${full}#${prNumber} ${what} failed: ${msg}`);
  };

  const state: PrState = {
    repo: full,
    prNumber,
    headSha: "",
    headAuthor: "",
    headIsOurs: false,
    headRef: "",
    baseRef: "",
    isDraft: false,
    isFork: false,
    headRepoFullName: null,
    labels: [],
    title: "",
    body: "",
    checksState: "none",
    settledCheckCount: 0,
    baseChecksState: "none",
    botReviewAtHead: null,
    ciReport: null,
    attempt: 1,
    flakyDeferrals: 0,
    escalatedAtSha: null,
    escalatedBy: null,
    priorAttempts: [],
    notes: [],
    priorDiagnosisClass: null,
    cumulativeCostUsd: 0,
    assessedHeadShaByWorkflow: {},
    runInFlight: null,
    readErrors,
  };

  const github = deps.github;
  if (github) {
    try {
      const pr = await github.getPullRequest(owner, repo, prNumber);
      state.headSha = pr.head?.sha ?? "";
      state.headRef = pr.head?.ref ?? "";
      state.baseRef = pr.base?.ref ?? "";
      state.isDraft = !!pr.draft;
      state.title = pr.title ?? "";
      state.body = pr.body ?? "";
      state.labels = (pr.labels ?? [])
        .map((l) => (typeof l === "string" ? l : l?.name ?? ""))
        .filter(Boolean);
      // `head.repo` is null when the source fork was deleted; the branch is
      // gone either way, so treat it as a fork.
      state.headRepoFullName = pr.head?.repo?.full_name ?? null;
      const baseRepoFullName = pr.base?.repo?.full_name ?? full;
      state.isFork =
        state.headRepoFullName === null || state.headRepoFullName !== baseRepoFullName;
    } catch (err) {
      note("getPullRequest", err);
    }

    // Everything below needs the head SHA / base ref the PR read produced. When
    // that read failed there is nothing to point them at, and issuing them
    // against an empty ref would 404 four more times for no information.
    if (state.headSha) {
      // Both check reads gate DISPATCH, so neither may see our own review
      // check: a `last-light/review` sitting queued/in-progress would pin the
      // aggregate at `pending`, and `pending` is a skip in `mayMerge`,
      // `resolveMergeDisposition` and `resolveReviewTrigger` alike — the review
      // would be waiting on itself (07 §7.2).
      const checkOpts = { excludeApp: appSlug(deps) };
      const [summary, baseState, review, author] = await Promise.all([
        github
          .getChecksSummary(owner, repo, state.headSha, checkOpts)
          .catch((err: unknown) => {
            note("getChecksSummary", err);
            return null;
          }),
        state.baseRef
          ? github.getBaseChecksState(owner, repo, state.baseRef, checkOpts).catch((err: unknown) => {
              note("getBaseChecksState", err);
              // "none" and not "failing": a base we could not read must never
              // be reported as upstream-broken, which would skip the fix.
              return "none" as ChecksState;
            })
          : Promise.resolve("none" as ChecksState),
        github
          .getLatestBotReview(owner, repo, prNumber, state.headSha, deps.botLogin)
          .catch((err: unknown) => {
            note("getLatestBotReview", err);
            // null = "not reviewed", which dispatches a review rather than
            // suppressing one. `post-review` is itself idempotent per head SHA.
            return null;
          }),
        github.getCommitAuthorName(owner, repo, state.headSha).catch((err: unknown) => {
          note("getCommitAuthorName", err);
          return "";
        }),
      ]);
      if (summary) {
        state.checksState = summary.state;
        state.settledCheckCount = summary.settledCount;
      }
      state.baseChecksState = baseState;
      state.botReviewAtHead = review ? { state: review.state } : null;
      state.headAuthor = author;
      state.headIsOurs = !!deps.botLogin && author === deps.botLogin;

      // The heavy read (one Actions job-log download per failed check) only
      // when there is a failure to explain. Phase 1's `logsAvailable` flag
      // rides along so the prompt can say the evidence degraded.
      if (state.checksState === "failing") {
        state.ciReport = await github
          .getCiFailureReport(owner, repo, state.headSha)
          .catch((err: unknown) => {
            note("getCiFailureReport", err);
            return null;
          });
      }
    }
  }

  applyDerivedState(state, deps);
  return state;
}

/**
 * Fill the derived half from our own run history.
 *
 * Split out (and exported) because it is a pure-ish function of the DB: a test
 * can hand it a literal live half plus a fake store and assert the attempt
 * table without touching GitHub.
 */
export function applyDerivedState(state: PrState, deps: PrStateDeps): void {
  const family = [...PR_FIX_SHAPED_WORKFLOWS];
  const triggerId = prTriggerId(state.repo, state.prNumber);

  const inFlight = deps.db.runs.activeForTrigger([...PR_SCOPED_WORKFLOWS], triggerId);
  state.runInFlight = inFlight ? { workflow: inFlight.workflowName, runId: inFlight.id } : null;

  state.cumulativeCostUsd = deps.db.executions.costForTriggerWorkflows(triggerId, family);

  const succeeded = deps.db.runs.latestSucceededForTriggers([...PR_SCOPED_WORKFLOWS], triggerId);
  state.assessedHeadShaByWorkflow = {};
  for (const [name, run] of Object.entries(succeeded)) {
    const sha = priorPrState(run.context)?.headSha;
    if (typeof sha === "string" && sha) state.assessedHeadShaByWorkflow[name] = sha;
  }

  const prior = deps.db.runs.latestForTrigger(family, triggerId);
  const priorState = priorPrState(prior?.context);
  // The prior run's HARVEST — what its agent actually concluded, read back off
  // the same row. `context.prState` is written at dispatch, before any phase
  // runs, so the post-hoc facts live on `scratch` (see `./fix-harvest.ts`).
  const priorMarkers = prior ? readHarvestedMarkers(prior) : null;

  // Carry the escalation record forward. `escalatedAtSha` lives on the run
  // context already, so the stateful `requires-human` guard costs no new
  // storage, no extra API call and no label mutation (09 → S1).
  state.escalatedAtSha = priorState?.escalatedAtSha ?? null;

  // `requires-human` is a NOTIFICATION, not a state. The state is "we escalated
  // at head SHA X" — which is what distinguishes a bot escalation (cleared by
  // the next human push) from a maintainer applying the label by hand to mean
  // "stay out" (a permanent override we must honour).
  const hasLabel = state.labels.includes(REQUIRES_HUMAN_LABEL);
  state.escalatedBy = !hasLabel ? null : state.escalatedAtSha ? "us" : "human";

  // The journal is derived from the latest PR-SCOPED run, not the latest FIX
  // run: it is keyed on the PR (10-pr-memory.md), so a `pr-review` that ran
  // between two fix attempts carries the accumulation forward and may have
  // added to it. Falls back to the fix-family row when there is no wider one.
  const priorAny = deps.db.runs.latestForTrigger([...PR_SCOPED_WORKFLOWS], triggerId) ?? prior;
  state.notes = deriveNotes(state, priorAny, priorPrState(priorAny?.context));

  const history = deriveAttemptHistory(
    state,
    priorState,
    priorMarkers,
    prior ? didSpendAttempt(prior, deps) : false,
  );
  state.attempt = history.attempt;
  state.priorAttempts = history.priorAttempts;
  state.flakyDeferrals = history.flakyDeferrals;
  state.priorDiagnosisClass = history.priorDiagnosisClass;
}

/**
 * Fold the PR's journal forward: what the prior run carried, plus what its own
 * agent wrote, capped — and marked stale when the world moved under it.
 *
 * Deliberately NOT part of {@link deriveAttemptHistory}, and the reason is the
 * one interesting thing about this function. Those three fields move together
 * because a fresh problem CLEARS all three; the journal does not clear. 09 → S1's
 * third row (a head SHA change authored by someone else) is still the boundary
 * that matters, but here it MARKS rather than deletes: a claim about the old
 * head is not evidence about the new one, yet "attempt 1 believed the lockfile
 * was stale" is still worth a later run seeing, and deleting it silently would
 * be indistinguishable from never having written it. Staleness is sticky —
 * `markNotesStale` never unsets — because a second push does not re-validate
 * what the first invalidated.
 *
 * Both sources are re-sanitized on the way through (`coerceNotes`), so a row
 * written by an older build cannot carry a note past today's rejection rules.
 */
function deriveNotes(
  state: PrState,
  priorRun: WorkflowRun | null | undefined,
  prior: PersistedPrState | null,
): PrNote[] {
  const carried = coerceNotes(prior?.notes);
  const harvested = coerceNotes(priorRun ? readHarvestedMarkers(priorRun)?.notes : null);
  const merged = boundNotes([...carried, ...harvested]);
  return sameProblem(state, prior) ? merged : markNotesStale(merged);
}

/** The four history fields {@link deriveAttemptHistory} produces together. */
interface AttemptHistory {
  attempt: number;
  priorAttempts: string[];
  flakyDeferrals: number;
  priorDiagnosisClass: DiagnosisClass | null;
}

/**
 * Fold one finished run into the PR's retry history.
 *
 * The three fields move TOGETHER and are derived in one place for that reason:
 * `attempt`, the journal replayed as `{{priorAttempts}}`, and the consecutive-
 * `flaky` counter all answer the same question — "what has happened to THIS
 * PROBLEM so far" — and a partial update is how they drift apart. The clearest
 * symptom of deriving them separately: a maintainer's push resets `attempt` to
 * 1 while `{{priorAttempts}}` still narrates attempts 1–3, so the prompt tells
 * the agent it is on attempt 1 and then recounts three of them.
 *
 * So a FRESH PROBLEM clears all three at once. Everything else appends the
 * prior run's rendered line and advances (or does not advance) the counter.
 */
function deriveAttemptHistory(
  state: PrState,
  prior: PersistedPrState | null,
  priorMarkers: HarvestedFixMarkers | null,
  priorSpent: boolean,
): AttemptHistory {
  const fresh: AttemptHistory = {
    attempt: 1,
    priorAttempts: [],
    flakyDeferrals: 0,
    priorDiagnosisClass: null,
  };
  const priorAttempt = typeof prior?.attempt === "number" ? prior.attempt : 0;
  // No prior run of the family at all.
  if (priorAttempt === 0) return fresh;

  // Someone else's push — a maintainer, a Dependabot rebase, a Renovate
  // recreate. The world moved, so the counter, the journal, the deferral count
  // and the last verdict are all about a problem that no longer exists.
  if (!sameProblem(state, prior)) return fresh;

  const carried = Array.isArray(prior?.priorAttempts)
    ? prior.priorAttempts.filter((l): l is string => typeof l === "string")
    : [];
  // A run that produced no marker leaves no line, exactly as it consumes no
  // attempt: there is nothing for the next attempt to learn from a crash.
  const line = renderAttemptLine(priorAttempt, priorMarkers);
  const priorAttempts = boundAttemptLines(line ? [...carried, line] : carried);

  const priorFlaky = typeof prior?.flakyDeferrals === "number" ? prior.flakyDeferrals : 0;
  // CONSECUTIVE, which is the whole point of the cap: three `flaky` verdicts in
  // a row means the job is not flaky, it is intermittently really failing, and
  // `fix.maxFlakyDeferrals` promotes it to `reproducible`. Any other class
  // breaks the run and resets to 0. A run with no diagnosis at all (a crash)
  // neither advances nor resets it — it says nothing about flakiness.
  const flakyDeferrals = priorMarkers?.diagnosis
    ? priorMarkers.diagnosis.class === "flaky"
      ? priorFlaky + 1
      : 0
    : priorFlaky;

  return {
    attempt: nextAttempt(state, prior, priorSpent),
    priorAttempts,
    flakyDeferrals,
    // Only ever the LAST run's verdict — see `PrState.priorDiagnosisClass` for
    // why this one does not persist across a run that diagnosed nothing.
    priorDiagnosisClass: priorMarkers?.diagnosis?.class ?? null,
  };
}

/**
 * Is the live head the same PROBLEM the prior run worked on?
 *
 * True when the head is unchanged (we made no progress — covers `no-change`
 * and `gave-up`) or when WE authored the new head (our fix landed and CI is
 * still red). False only when someone else pushed.
 */
function sameProblem(state: PrState, prior: PersistedPrState | null): boolean {
  const priorHead = typeof prior?.headSha === "string" ? prior.headSha : "";
  const headChanged = !!state.headSha && !!priorHead && state.headSha !== priorHead;
  return !(headChanged && !state.headIsOurs);
}

/**
 * §S1's attempt table, in code.
 *
 * `priorSpent` is the robustness rule the whole design rests on: **a crashed
 * run never consumes budget.** Without it, one bad hour — a sandbox
 * provisioning outage, a quota rejection, a model API wobble — silently
 * escalates every open dependency PR across every managed repo to
 * `requires-human`, and a human then has to un-stick each one by hand. Nothing
 * else in this design can cause damage that broad. `fix.maxCostUsd` and
 * `MAX_RESTART_RESUMES` bound the crash-loop case instead, and neither poisons
 * a label.
 */
function nextAttempt(
  state: PrState,
  prior: PersistedPrState | null,
  priorSpent: boolean,
): number {
  const priorAttempt = typeof prior?.attempt === "number" ? prior.attempt : 0;
  if (priorAttempt === 0) return 1;

  // Someone else's push. The world moved: fresh problem, fresh counter. This is
  // what stops an exhausted human PR being permanently un-fixable for the life
  // of the PR.
  if (!sameProblem(state, prior)) return 1;

  // Same head (we made no progress — covers `no-change` and `gave-up`), or a
  // head WE authored on top of it (our fix landed, CI is still red). Same
  // problem either way, so the counter advances — but only if the prior run got
  // far enough to spend it.
  return priorSpent ? priorAttempt + 1 : priorAttempt;
}

/**
 * Did this prior run actually SPEND an attempt?
 *
 * §S1 answers it in two clauses, and BOTH are necessary:
 *
 * 1. **The run produced a `DIAGNOSIS_COMPLETE` marker.** This is a read of the
 *    harvest (`./fix-harvest.ts`), written by `onPhaseEnd` as each phase
 *    completes. A run that crashed before `diagnose` finished — sandbox
 *    provisioning failure, quota rejection, model API error — harvested no
 *    diagnosis and costs nothing. That rule is the single most important
 *    robustness property in the design: without it, one bad hour silently
 *    escalates EVERY open dependency PR across EVERY managed repo to
 *    `requires-human`, and a human then un-sticks each one by hand.
 *    `fix.maxCostUsd` and `MAX_RESTART_RESUMES` bound the crash-loop case
 *    instead, and neither poisons a label.
 * 2. **Its class is one that costs an attempt** — §S1's class table, encoded as
 *    {@link ATTEMPT_FREE_CLASSES}. `flaky` and `upstream-broken` are correct
 *    stopping verdicts about something other than this PR's code; charging for
 *    them would leave the PR with no attempts left at the moment it becomes
 *    fixable, and would make `fix.maxFlakyDeferrals` unreachable.
 *
 * An UNRECOGNISED class counts. A hallucinated class token is not evidence that
 * the run cost nothing, and the free-attempt direction is the unbounded one.
 *
 * Two fallbacks, in order:
 *
 * - **No PARSED diagnosis** — the ledger decides. Two very different runs land
 *   here and it is deliberate that they are NOT told apart: one has no harvest
 *   namespace at all (it predates the harvest, or died before its first
 *   `onPhaseEnd`), the other harvested and parsed nothing. Reading the second as
 *   "spent nothing" was the defect — `harvestFixMarkers` writes the namespace
 *   unconditionally for the fix family, so a malformed marker produces a
 *   non-null harvest carrying `diagnosis: null`, and treating that as a free run
 *   pinned the PR at attempt 1 for its whole life with `fix.maxCostUsd` as the
 *   only remaining brake.
 *
 *   The probe is `diagnose`'s own ledger row: the phase carries
 *   `on_output.requires_marker: "DIAGNOSIS_COMPLETE:"`, so a SUCCEEDED
 *   `diagnose` cannot exist without a well-formed marker having been emitted.
 *   Same fact, read less directly, and without the class. Failing CLOSED here
 *   costs a crashed run nothing, because a run whose `diagnose` genuinely never
 *   finished has no succeeded row for the probe to find.
 * - **A read error** — fail CLOSED (count it). A read failure must not silently
 *   grant a free attempt forever; the cost cap is the backstop, and the
 *   alternative is an unbounded retry loop.
 */
function didSpendAttempt(prior: WorkflowRun, deps: PrStateDeps): boolean {
  try {
    const diagnosis = readHarvestedMarkers(prior)?.diagnosis ?? null;
    if (!diagnosis) return deps.db.executions.phaseSucceededInRun(prior.id, "diagnose");
    return !(diagnosis.class && ATTEMPT_FREE_CLASSES.has(diagnosis.class));
  } catch {
    return true;
  }
}

/** Read a persisted snapshot off a stored run context, tolerating old rows. */
function priorPrState(context: unknown): PersistedPrState | null {
  if (!context || typeof context !== "object") return null;
  const ctx = context as Record<string, unknown>;
  const snap = ctx.prState;
  if (snap && typeof snap === "object") return snap as PersistedPrState;
  // Pre-`prState` rows persisted a bare `headSha` (and nothing else). Honour it
  // so the "already assessed at this SHA" dedup keeps working across the
  // upgrade instead of re-assessing every open PR once.
  if (typeof ctx.headSha === "string") return { headSha: ctx.headSha };
  return null;
}
