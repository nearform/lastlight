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
import { prScopedWorkflows } from "../workflows/pr-scope.js";
import { readHarvestedMarkers, type HarvestedFixMarkers } from "./fix-harvest.js";
import {
  ATTEMPT_FREE_CLASSES,
  boundAttemptLines,
  renderAttemptLine,
  renderInterventionLine,
  type DiagnosisClass,
} from "./fix-markers.js";
import {
  boundNotes,
  coerceNotes,
  markNotesStale,
  sanitizeNoteText,
  type PrNote,
} from "./pr-notes.js";
import { REQUIRES_HUMAN_LABEL } from "../cron/dependabot-discovery.js";
import { logger } from "../logging/logger.js";

const log = logger("pr-state");

/** Aggregate check state for a ref, as {@link GitHubClient.getChecksConclusion} reports it. */
export type ChecksState = "passing" | "failing" | "pending" | "none";

/**
 * How a retry arrived. Three surfaces, ONE record (03-retry-intervention.md).
 *
 * - `comment` — `@<bot> retry [reason]`, already maintainer-gated by the
 *   `author_association` check that governs the whole `@`-mention path.
 * - `label` — a human took `requires-human` off. Maintainer-gated for free:
 *   GitHub requires triage permission to change a label.
 * - `api` — the admin endpoint behind `lastlight pr retry`, gated by the
 *   authenticated admin session.
 */
export type InterventionVia = "comment" | "label" | "api";

/**
 * The last time a human told us to try again — the one thing that makes an
 * escalated problem dispatchable without a new commit.
 *
 * `by` and `note` are recorded for DISPLAY and for the journal. **No decision
 * function reads either** — the same rule {@link PrNote} lives under. Capability
 * is checked at the surface (`author_association`, GitHub's own label
 * permissions, or the admin session); identity is never a decision input
 * (locked decision 5). There is no precedence between two maintainers either:
 * last one wins (locked decision 6), which is what one nullable field with a
 * timestamp gives for free.
 */
export interface PrIntervention {
  at: string;
  /** The head SHA the retry was asked for — the retry's own idempotency key. */
  atSha: string;
  /** How it arrived: a comment, a label removal, or the admin API. */
  via: InterventionVia;
  by?: string;
  note?: string;
}

/**
 * What a SURFACE hands in. `at` and `atSha` are stamped by
 * {@link applyDerivedState}, so no caller can date a retry itself or key one to
 * a head SHA it did not read.
 */
export interface InterventionRequest {
  via: InterventionVia;
  by?: string;
  /** Free text from the comment / CLI. Sanitized on the way in; never trusted. */
  note?: string;
}

/**
 * The phase a STANDALONE retry record terminates on — `recordIntervention`'s row
 * (`./pr-escalation.ts`, which re-exports this as its public name).
 *
 * Defined HERE, at the reading end, because the value is load-bearing on this
 * side: {@link applyDerivedState} has to recognise the row to keep it out of
 * {@link PrState.assessedHeadShaByWorkflow}. Importing it from
 * `./pr-escalation.ts` would close a module cycle (that module already imports
 * this one), so the definition lives on the side with no outbound edge.
 */
export const INTERVENTION_PHASE = "retry-requested";

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
   * anyone else's = the world moved) and the {@link escalatedAtSha} guard (our
   * own commit on top of an escalation does not count as intervention).
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
  /**
   * Head SHA at which one of OUR runs escalated this PR, or null.
   *
   * The WHOLE of the escalation state. There is no companion "who applied the
   * label" field, and its absence is the point: `requires-human` is a
   * notification, read by nothing, so `escalatedAtSha !== null` is the only
   * question a decision asks — "did a run of ours stop here, and is this still
   * the head it stopped at?". A maintainer who wants the bot off a PR applies
   * the HOLD label instead, which is an instruction rather than something
   * inferred from a label we also write ourselves (02-hold-label.md).
   *
   * Written by `./pr-escalation.ts` and by nothing else, which is why that
   * module records a run row BEFORE it labels: a skip writes no row, so an
   * escalation that stayed a row-less skip would never persist this and would
   * re-comment on every subsequent event.
   *
   * **Consumed by an {@link intervention}.** A recorded retry clears this back
   * to null — that is how a re-arm becomes visible to the pure decision
   * functions, which see only the snapshot. The mechanism stays bounded because
   * the next escalation writes a fresh value at the same head while the
   * intervention is by then the one the prior run already saw.
   */
  escalatedAtSha: string | null;
  /**
   * The last time a human told us to try again, or null — the RETRY direction
   * of human intent, and the counterpart to {@link escalatedAtSha}
   * (03-retry-intervention.md).
   *
   * Before this field the state machine modelled *the PR's problem* precisely
   * and *human intent* not at all: the only way to say "a human intervened" was
   * that the head SHA changed and we did not author it, which is an INFERENCE
   * FROM A COMMIT rather than a record of a decision. Two of the three things a
   * maintainer would naturally try — commenting, removing the label — cleared
   * the escalation guard without moving the budget window, so both fell straight
   * back through `budget-exhausted` and posted a duplicate escalation comment.
   *
   * Recording it fixes both halves at once: `sameProblem` reads it, so a retry
   * re-arms the attempt counter AND the cost baseline exactly as a push does
   * (locked decision 7), and the record is what makes the re-arm ONCE-ONLY —
   * the next dispatch reads the same intervention back off the prior run's
   * snapshot and does not re-arm again.
   *
   * `by` and `note` are for display and for the journal. **No decision function
   * reads either** — see {@link PrIntervention}.
   *
   * Written wherever the retry is recorded: on the dispatched run's own
   * snapshot when the retry results in a run, and on a standalone row
   * (`recordIntervention`, `./pr-escalation.ts`) when it does not — the same
   * "a skip writes no row, so the record must" reasoning `escalatePr` is built
   * on.
   */
  intervention: PrIntervention | null;
  /**
   * Head SHA at which we told this PR's author we cannot fix a fork, or null.
   *
   * The dedup for the fork-PR notice, carried forward exactly as
   * {@link escalatedAtSha} is — the same "the persisted record IS the
   * de-duplication" property `pr-escalation.ts` documents, rather than an API
   * scan asking "did we already comment".
   *
   * Unlike the escalation guard it is never invalidated by a later push, and
   * that asymmetry is the point. An escalation says "this problem needs a
   * human", which a new commit can make untrue; a fork notice says "your branch
   * is not on this repo", which pushing to that same fork does not change. So
   * the notice is once per PR, not once per head — a fork PR that gets ten
   * pushes is one apology, not ten.
   */
  forkNoticedAtSha: string | null;
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
   * {@link flakyDeferrals}, which persists — and cleared outright by a fresh
   * problem, whether the freshness came from a push or from an
   * {@link intervention}. Both halves exist so that a remembered
   * `infra-dependent` cannot re-escalate on the next event and put the label
   * straight back.
   *
   * That was written as *"what keeps the manual exit working"*, and until
   * 03-retry-intervention.md it only described one of the three cases. Removing
   * `requires-human` by hand did clear a remembered `not-retryable` — but
   * `budget-exhausted` and `attempts-exhausted` do not read this field at all,
   * so the label removal cleared the guard, the budget gate fired anyway, and
   * the label went straight back with a duplicate comment. **The manual exit
   * now works for all three**, because it is no longer this field that carries
   * it: a retry is a RECORD ({@link intervention}), it re-arms the counter and
   * the cost baseline together, and this field being null is one consequence of
   * that rather than the whole mechanism.
   */
  priorDiagnosisClass: DiagnosisClass | null;
  /**
   * USD spent on THIS PROBLEM by the fix family (`fix.maxCostUsd`).
   *
   * Scoped to a problem, not to a PR — the same window {@link attempt} uses,
   * and for the same reason. It was the PR's whole lifetime spend, which put it
   * out of step with every other budget in the snapshot: a maintainer's push
   * re-armed `attempt` and cleared the `escalated:` guard, then the very next
   * check fell straight back through `budget-exhausted` and posted another
   * `requires-human` comment — a comment whose own closing paragraph tells the
   * maintainer that pushing is the remedy (#256).
   *
   * Computed as lifetime spend minus {@link costBaselineUsd}.
   */
  cumulativeCostUsd: number;
  /**
   * Lifetime fix-family spend at the moment the current problem began — the
   * offset {@link cumulativeCostUsd} is measured from.
   *
   * Carried forward while the problem is the same and re-stamped to the
   * lifetime total when someone else's push makes it a fresh one, so the two
   * fields together say "we have spent $X since the last human intervention"
   * without a second store or a per-run cost column. Zero on a PR we have never
   * worked, which makes `cumulative = lifetime` — the old behaviour, for the
   * only case where the old behaviour was right.
   */
  costBaselineUsd: number;
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
   *
   * A `retry-requested` row is the one `succeeded` row that never counts — it
   * records a dispatch that did NOT happen, which is the opposite of the claim
   * this field makes — and the fix family's entries are dropped entirely while a
   * retry asked at this head is still waiting for a run to serve it. See
   * `unassessForPendingRetry`.
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
 * Re-exported from `../workflows/pr-scope.ts`, which derives it from each
 * workflow's own `pr_scoped: true` metadata rather than from a hardcoded list
 * of four names the operator is free to route around. The argument for both the
 * span and the derivation lives there; every reader inside the PR state machine
 * reaches for it through this module.
 */
export { prScopedWorkflows } from "../workflows/pr-scope.js";

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
  /**
   * A retry that arrived WITH this event — `@<bot> retry` on the comment route,
   * or `lastlight pr retry` on the admin route.
   *
   * Handed to the resolver rather than written by the caller afterwards, because
   * the whole point of the record is that `sameProblem` reads it: an
   * intervention applied after the snapshot was derived would re-arm nothing.
   * The `label` surface needs no equivalent — its evidence is the live label
   * read, which is already here.
   */
  intervention?: InterventionRequest;
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
    log.warn("Read failed", { repo: full, prNumber, what, err });
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
    intervention: null,
    forkNoticedAtSha: null,
    priorAttempts: [],
    notes: [],
    priorDiagnosisClass: null,
    cumulativeCostUsd: 0,
    costBaselineUsd: 0,
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
      //
      // `checkOpts` for the same reason the reads above take it, one step
      // further on: `concludeReviewCheck` writes `conclusion: "failure"` for a
      // CHANGES_REQUESTED review, so without it our own reviewer's verdict is
      // picked up as a failed check and handed to the fix agent as CI evidence
      // to fix.
      if (state.checksState === "failing") {
        state.ciReport = await github
          .getCiFailureReport(owner, repo, state.headSha, checkOpts)
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
  const prScoped = [...prScopedWorkflows()];
  const triggerId = prTriggerId(state.repo, state.prNumber);

  const inFlight = deps.db.runs.activeForTrigger(prScoped, triggerId);
  state.runInFlight = inFlight ? { workflow: inFlight.workflowName, runId: inFlight.id } : null;

  const lifetimeCostUsd = deps.db.executions.costForTriggerWorkflows(triggerId, family);

  const succeeded = deps.db.runs.latestSucceededForTriggers(prScoped, triggerId);
  state.assessedHeadShaByWorkflow = {};
  for (const [name, run] of Object.entries(succeeded)) {
    // A `retry-requested` row is not evidence of assessment — it is the record
    // of a dispatch that DID NOT HAPPEN (`recordIntervention`, written when a
    // retry is re-armed and then skipped for an unrelated reason such as
    // `upstream-broken`). It is stamped `succeeded` at the current head like
    // every other ledger row, so counting it here made the one row that exists
    // to preserve a maintainer's ask the thing that swallowed it: the next cold
    // resolve read "we already handled this SHA" and refused the retry with the
    // budgets sitting freshly armed.
    //
    // Skipping it drops the workflow's entry rather than falling back to an
    // older row, which is the conservative direction for this field: worst case
    // we re-assess a head, and the un-assess below has to be able to override a
    // real run at this head anyway.
    if (run.currentPhase === INTERVENTION_PHASE) continue;
    const sha = priorPrState(run.context)?.headSha;
    if (typeof sha === "string" && sha) state.assessedHeadShaByWorkflow[name] = sha;
  }

  const prior = deps.db.runs.latestForTrigger(family, triggerId);
  const priorState = priorPrState(prior?.context);
  // The prior run's HARVEST — what its agent actually concluded, read back off
  // the same row. `context.prState` is written at dispatch, before any phase
  // runs, so the post-hoc facts live on `scratch` (see `./fix-harvest.ts`).
  const priorMarkers = prior ? readHarvestedMarkers(prior) : null;

  // The widest prior run of ours on this PR — every PR-SCOPED workflow, not
  // just the fix family, because it is keyed on the PR (10-pr-memory.md). Two
  // things read it: the journal (a `pr-review` between two fix attempts carries
  // the accumulation forward and may have added to it) and the escalation
  // record, because `escalatePr` records under whichever workflow was
  // dispatching — which may be `dependabot-pr-merge` or `pr-review`, neither of
  // which the fix family would find. Falls back to the fix-family row when there
  // is no wider one.
  const priorAny = deps.db.runs.latestForTrigger(prScoped, triggerId) ?? prior;
  const priorAnyState = priorPrState(priorAny?.context);

  applyEscalationRecord(state, priorState, priorAnyState);

  // The RETRY direction of human intent (03-retry-intervention.md). Resolved
  // BEFORE everything below, because `retried` is one of the two things that
  // make a problem fresh — and it may clear {@link PrState.escalatedAtSha},
  // which `applyEscalationRecord` has just carried forward.
  const retried = applyIntervention(state, priorState, priorAnyState, deps);

  state.notes = deriveNotes(state, priorAny, priorAnyState, retried);

  // …and an ask still waiting for a run takes the head back off the
  // `already-assessed` dedup, for as many ticks as that takes.
  unassessForPendingRetry(state, succeeded);

  // The fork-PR notice's dedup, carried forward off the WIDEST prior row for
  // the same reason the escalation record is: `noticeForkPr` records under
  // whichever workflow was dispatching. Never invalidated by a push — see the
  // field's own doc.
  state.forkNoticedAtSha =
    (typeof priorState?.forkNoticedAtSha === "string" ? priorState.forkNoticedAtSha : null) ??
    (typeof priorAnyState?.forkNoticedAtSha === "string" ? priorAnyState.forkNoticedAtSha : null);

  // The cost WINDOW, on the same boundary the attempt counter uses. `sameProblem`
  // is the whole definition: while it holds we carry the prior run's baseline,
  // and when it breaks we re-stamp it to the lifetime total so the fresh problem
  // starts at zero — which is exactly what makes a maintainer's push, or a
  // recorded RETRY, re-arm the budget the way it re-arms the attempt counter.
  // One predicate, both budgets: re-arming only the counter is #256.
  const freshProblem = !sameProblem(state, priorState, retried);
  const priorBaseline =
    typeof priorState?.costBaselineUsd === "number" ? priorState.costBaselineUsd : 0;
  state.costBaselineUsd = freshProblem ? lifetimeCostUsd : priorBaseline;
  // `max(0, …)` for the one case that can go negative: a run row written before
  // this field existed carries no baseline, so a PR mid-flight at upgrade reads
  // 0 and gets its full lifetime spend — correct — while a later re-stamp can
  // only ever move the baseline forward.
  state.cumulativeCostUsd = Math.max(0, lifetimeCostUsd - state.costBaselineUsd);

  const history = deriveAttemptHistory(
    state,
    priorState,
    priorMarkers,
    prior ? didSpendAttempt(prior, deps) : false,
    retried,
  );
  state.attempt = history.attempt;
  state.priorAttempts = history.priorAttempts;
  state.flakyDeferrals = history.flakyDeferrals;
  state.priorDiagnosisClass = history.priorDiagnosisClass;
}

/**
 * Drop the fix family's "already assessed at this head" entries while a retry
 * asked AT THIS HEAD is still waiting to be served.
 *
 * Without this the `already-assessed` skip eats every retry that did not arrive
 * as an explicit `@bot` request (the label and API surfaces): our own escalation
 * row — and the attempt that exhausted the budget before it — both record
 * `succeeded` at this head, so the dedup reads "we already handled this SHA" and
 * the retry becomes a no-op with the budgets sitting freshly armed. A push
 * clears the same guard by changing the SHA; a retry has to say it.
 *
 * **The ask survives the tick it arrived on**, which is the part that is easy to
 * get wrong and was wrong: this used to fire only when the intervention was NEW
 * to this dispatch, so a retry recorded on one tick and dispatched on a later
 * one — exactly what `recordIntervention`'s standalone row exists for, and what
 * the comment and label surfaces produce whenever the gate then skips for an
 * unrelated reason — was un-assessed on the tick that could not use it and
 * re-assessed on the tick that could. Hence the predicate is "has a run SERVED
 * this ask", not "did this ask arrive just now".
 *
 * A run has served it when the row claiming the head carries the same
 * {@link interventionKey} on its own snapshot: `dispatchWorkflow` persists the
 * resolved snapshot on `context.prState`, so a run dispatched by the retry
 * carries it and a run that finished before the ask does not. That is what
 * bounds the whole clause — one extra window per ask, not a dedup switched off
 * for the life of the pull request — and it is why the `retry-requested` row
 * itself must be kept out of `assessedHeadShaByWorkflow` above: it carries the
 * record forward, so it would read as having served an ask it was written to
 * defer.
 */
function unassessForPendingRetry(state: PrState, succeeded: Record<string, WorkflowRun>): void {
  const ask = state.intervention;
  if (!ask || !state.headSha || ask.atSha !== state.headSha) return;
  const asked = interventionKey(ask);
  for (const name of PR_FIX_SHAPED_WORKFLOWS) {
    if (state.assessedHeadShaByWorkflow[name] !== state.headSha) continue;
    const seen = interventionKey(
      coerceIntervention(priorPrState(succeeded[name]?.context)?.intervention),
    );
    if (seen !== asked) delete state.assessedHeadShaByWorkflow[name];
  }
}

/**
 * Resolve {@link PrState.intervention}, and answer the one question the rest of
 * the derivation needs: **has a human asked for another try since the prior run
 * saw one?**
 *
 * Three inputs, in order of authority:
 *
 * 1. An intervention handed in with this event ({@link PrStateDeps.intervention})
 *    — the comment and API surfaces.
 * 2. The LABEL surface, detected rather than delivered. No webhook is needed:
 *    "we escalated at this head, the head has not moved, and our
 *    `requires-human` is gone" can only be a human having taken it off. It is
 *    trivially detectable only because 02-hold-label.md demoted the label to a
 *    pure notification — its absence is now pure evidence with no competing
 *    meaning.
 * 3. Whatever the prior run already carried, folded forward exactly as
 *    {@link PrState.escalatedAtSha} and {@link PrState.forkNoticedAtSha} are.
 *
 * The answer is computed against the FIX-FAMILY prior specifically, not against
 * whatever the record was folded off: an intervention first recorded on a
 * `pr-review` run's snapshot has not yet re-armed the fix family's counter, and
 * comparing against the wider row would silently swallow it.
 *
 * **A retry consumes the escalation.** Clearing `escalatedAtSha` is how the
 * re-arm becomes visible to the pure decision functions, which see only the
 * snapshot — and it is what bounds the whole mechanism: the next escalation
 * writes a fresh `escalatedAtSha` at the same head, the intervention is by then
 * the one the prior run already saw, and the `escalated:` skip binds again. No
 * ping-pong, and no second budget to keep in step (locked decision 9's
 * unbounded-retries property is bounded by the escalation, not by a counter).
 */
function applyIntervention(
  state: PrState,
  prior: PersistedPrState | null,
  priorAny: PersistedPrState | null,
  deps: PrStateDeps,
): boolean {
  const carried = coerceIntervention(prior?.intervention) ?? coerceIntervention(priorAny?.intervention);
  state.intervention = newIntervention(state, carried, deps) ?? carried;

  const seen = interventionKey(coerceIntervention(prior?.intervention));
  const retried = !!state.intervention && interventionKey(state.intervention) !== seen;
  if (retried) state.escalatedAtSha = null;
  return retried;
}

/**
 * The identity of one ask — "is this the same retry the prior run already
 * consumed, or a new one?".
 *
 * The timestamp alone is not enough, and the reason is a real one rather than a
 * theoretical one: `at` has millisecond resolution, so two asks that land in the
 * same millisecond read as one and the second silently re-arms nothing. The
 * whole tuple is what a human actually varied — when, how, who, and why — and
 * two asks identical on all four are the same ask for every purpose this has.
 *
 * Shared with `recordIntervention` (`./pr-escalation.ts`), so the row-writing
 * side and the folding side cannot disagree about what "already recorded" means.
 */
export function interventionKey(intervention: PrIntervention | null | undefined): string | null {
  if (!intervention) return null;
  const { at, via, by, note } = intervention;
  return JSON.stringify([at, via, by ?? "", note ?? ""]);
}

/**
 * A retry recorded by THIS dispatch, or null when there is nothing new.
 *
 * Refuses without a head SHA, for the same reason `escalatePr` does: the SHA is
 * the record's idempotency key, and one keyed to `""` would match nothing and
 * re-arm forever.
 */
function newIntervention(
  state: PrState,
  carried: PrIntervention | null,
  deps: PrStateDeps,
): PrIntervention | null {
  if (!state.headSha) return null;

  const req = deps.intervention;
  if (req && (req.via === "comment" || req.via === "label" || req.via === "api")) {
    // The note is FREE TEXT a maintainer typed, so it goes through the journal's
    // own sanitizer before it is stored — flattened to one line, control
    // characters stripped, and rejected outright if it carries `class=` or a
    // marker tag. That is what lets it be replayed into a later prompt (as the
    // journal's seam line, and as a `PrNote`) without being able to forge a
    // token the parser reads.
    const note = sanitizeNoteText(typeof req.note === "string" ? req.note : "");
    return {
      at: new Date().toISOString(),
      atSha: state.headSha,
      via: req.via,
      ...(typeof req.by === "string" && req.by ? { by: req.by.slice(0, 100) } : {}),
      ...(note ? { note } : {}),
    };
  }

  // Surface 2 — `requires-human` came off by hand.
  //
  // Two guards beyond the obvious one. The labels have to be REAL: a failed
  // `getPullRequest` degrades them to `[]`, which would read as "the label is
  // gone" on every event we could not read. And a retry already recorded at
  // this head is not re-detected — that is what makes the record once-only
  // here, since a skip writes no run row for a second detection to read back.
  //
  // The known imprecision: a `requires-human` write that 403'd is
  // indistinguishable from one a human removed, so an escalation whose label
  // never landed earns ONE extra window at that head. Bounded (the guard below
  // stops it repeating at the same head) and deliberately erring toward the
  // human, since the alternative is a PR we stopped on with nothing on it
  // saying so.
  if (
    state.escalatedAtSha &&
    state.escalatedAtSha === state.headSha &&
    !state.labels.includes(REQUIRES_HUMAN_LABEL) &&
    !state.readErrors.some((e) => e.startsWith("getPullRequest")) &&
    !(carried && carried.atSha === state.headSha)
  ) {
    return { at: new Date().toISOString(), atSha: state.headSha, via: "label" };
  }

  return null;
}

/** Read a persisted intervention back, tolerating every shape a JSON column can hold. */
function coerceIntervention(raw: unknown): PrIntervention | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const via = typeof r.via === "string" ? r.via : "";
  if (via !== "comment" && via !== "label" && via !== "api") return null;
  if (typeof r.at !== "string" || !r.at) return null;
  // Re-sanitized on the way IN as well as out, exactly as `coerceNotes` is: a
  // row written by an older build must not carry a note past today's rules.
  const note = sanitizeNoteText(typeof r.note === "string" ? r.note : "");
  return {
    at: r.at,
    atSha: typeof r.atSha === "string" ? r.atSha : "",
    via,
    ...(typeof r.by === "string" && r.by ? { by: r.by } : {}),
    ...(note ? { note } : {}),
  };
}

/**
 * At which head did one of OUR runs escalate this PR?
 *
 * One field, one read, no inference. It used to be two fields — this one and an
 * `escalatedBy: "us" | "human" | null` derived from whether `requires-human` was
 * present AND whether any run of ours had ever touched the PR — which made the
 * LABEL a state in practice, exactly what 09 → S1 said it must not be. The
 * inference was also only ever right on a PR the bot had never worked: on any
 * other, a maintainer's hand-applied `requires-human` read as the bot's own
 * escalation and was cleared by the next person's push.
 *
 * Deleting it is the fix (02-hold-label.md). The hold a maintainer actually
 * wants is now its own label, checked at the dispatch gate as a live
 * precondition; `requires-human` keeps being APPLIED — by `escalatePr` and by
 * the agent per the dependabot prompts — and is read by nothing.
 *
 * What is left is carried forward off the prior run's context, so the stateful
 * guard costs no new storage, no extra API call and no label mutation (09 → S1).
 * Read from the fix family first and the wider PR-scoped row second:
 * `escalatePr` records under whichever workflow was dispatching, which may be
 * `dependabot-pr-merge` or `pr-review`.
 */
function applyEscalationRecord(
  state: PrState,
  prior: PersistedPrState | null,
  priorAnyState: PersistedPrState | null,
): void {
  state.escalatedAtSha = prior?.escalatedAtSha ?? priorAnyState?.escalatedAtSha ?? null;
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
 *
 * THE STALENESS BOUNDARY IS {@link headMoved}, NOT {@link sameProblem}. Those
 * used to be the same predicate and are not any more: a RETRY makes the problem
 * fresh for the two budgets without anything about the pull request having
 * changed, so marking the journal stale on one would be a claim about the head
 * that is simply untrue — the head is the same commit it was a minute ago. The
 * doc comment above is the test: *"a claim about the old head is not evidence
 * about the new one"* only bites when there IS a new head.
 *
 * A maintainer's own reason for the retry is appended here as a note, so it
 * reaches the next attempt's prompt through the one channel that is already
 * bounded and fenced. Like every other note it informs and cannot authorise.
 */
function deriveNotes(
  state: PrState,
  priorRun: WorkflowRun | null | undefined,
  prior: PersistedPrState | null,
  retried: boolean,
): PrNote[] {
  const carried = coerceNotes(prior?.notes);
  const harvested = coerceNotes(priorRun ? readHarvestedMarkers(priorRun)?.notes : null);
  const merged = boundNotes([...carried, ...harvested]);
  const folded = headMoved(state, prior) ? markNotesStale(merged) : merged;
  const note = retried ? state.intervention?.note : undefined;
  if (!note) return folded;
  return boundNotes([
    ...folded,
    {
      at: state.intervention!.at,
      // No run wrote it, so there is no run id to attribute it to; the
      // provenance that matters is that a HUMAN asked, which the two fields
      // below say. `renderNoteLine` drops empty parts.
      runId: "",
      workflow: "retry",
      phase: state.intervention!.via,
      kind: "finding",
      text: note,
    },
  ]);
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
 *
 * ## The one asymmetry: the journal survives a retry
 *
 * Locked decision 8 (03-retry-intervention.md). Two ways to reach a fresh
 * problem, and they are NOT the same fresh problem:
 *
 * |                       | `attempt` | cost baseline | `priorAttempts`        | `flakyDeferrals` | `priorDiagnosisClass` |
 * |-----------------------|-----------|---------------|------------------------|------------------|-----------------------|
 * | push (non-bot head)   | 1         | re-stamped    | **wiped**              | 0                | null                  |
 * | retry                 | 1         | re-stamped    | **carried + seam line**| 0                | null                  |
 *
 * A push changed the code, so prior findings may be stale. A retry changed
 * nothing but patience — and discarding `priorAttempts` there sends attempt 1
 * of the new window straight down attempt 1 of the old window's road. On the
 * PR that produced this plan the journal held the one useful fact: that the
 * diagnosis had already concluded CI was green at the current head.
 *
 * `flakyDeferrals` resets on BOTH. A human intervening is a statement that the
 * flaky-versus-real inference should start over, and they have better evidence
 * than the counter does.
 *
 * The seam line is not decoration. Without it the journal renders `attempt 1`,
 * `attempt 2`, and then a run that also calls itself attempt 1, with nothing
 * saying where the boundary is.
 */
function deriveAttemptHistory(
  state: PrState,
  prior: PersistedPrState | null,
  priorMarkers: HarvestedFixMarkers | null,
  priorSpent: boolean,
  retried: boolean,
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

  const carried = Array.isArray(prior?.priorAttempts)
    ? prior.priorAttempts.filter((l): l is string => typeof l === "string")
    : [];
  // A run that produced no marker leaves no line, exactly as it consumes no
  // attempt: there is nothing for the next attempt to learn from a crash.
  const line = renderAttemptLine(priorAttempt, priorMarkers);

  // Someone else's push — a maintainer, a Dependabot rebase, a Renovate
  // recreate. The world moved, so the counter, the journal, the deferral count
  // and the last verdict are all about a problem that no longer exists.
  //
  // Checked BEFORE the retry branch, so a maintainer who pushes AND asks in the
  // same breath gets the push's semantics: the code changed, which is the
  // stronger statement about whether the journal still describes anything.
  if (headMoved(state, prior)) return fresh;

  // A retry. Same head, same code — so the journal is carried and a seam line
  // marks where the old window ended.
  if (retried) {
    return {
      ...fresh,
      priorAttempts: boundAttemptLines([
        ...carried,
        ...(line ? [line] : []),
        renderInterventionLine(state.intervention?.note),
      ]),
    };
  }

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
 * Did SOMEONE ELSE push? The world-moved half of {@link sameProblem}.
 *
 * False when the head is unchanged (we made no progress — covers `no-change`
 * and `gave-up`) and when WE authored the new head (our fix landed and CI is
 * still red). Split out because the journal's staleness marking needs exactly
 * this and not the whole predicate: a retry makes the problem fresh without the
 * head having moved, and a note about a commit that is still the head is not
 * stale. See {@link deriveNotes}.
 */
function headMoved(state: PrState, prior: PersistedPrState | null): boolean {
  const priorHead = typeof prior?.headSha === "string" ? prior.headSha : "";
  const headChanged = !!state.headSha && !!priorHead && state.headSha !== priorHead;
  return headChanged && !state.headIsOurs;
}

/**
 * Is the live head the same PROBLEM the prior run worked on?
 *
 * False in exactly two cases, and they are the two ways a human intervenes:
 * somebody else pushed ({@link headMoved}), or somebody asked us to try again
 * ({@link PrState.intervention}). **A retry does exactly what a push does** —
 * locked decision 7 — so it is one predicate rather than a second budget shape,
 * which is how the old six-sites-disagreeing situation started.
 *
 * THE boundary of a problem, and read in two places on purpose: the attempt
 * counter and {@link PrState.costBaselineUsd}. Those two are the pair of
 * budgets `fix.maxAttempts` and `fix.maxCostUsd` bound, so an intervention has
 * to re-arm both or neither — re-arming only the counter is what let
 * `budget-exhausted` re-comment on every push (#256), and it is exactly what
 * clearing the escalation guard from an `@bot` comment used to do.
 */
function sameProblem(
  state: PrState,
  prior: PersistedPrState | null,
  retried: boolean,
): boolean {
  if (retried) return false;
  return !headMoved(state, prior);
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
  // of the PR. (The RETRY half of "fresh problem" never reaches here —
  // `deriveAttemptHistory` returns its own table row above — so this reads the
  // head alone.)
  if (headMoved(state, prior)) return 1;

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
