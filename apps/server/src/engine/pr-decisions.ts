/**
 * The four decisions the PR state machine makes — all PURE functions over a
 * resolved {@link PrState} (`./pr-state.ts`).
 *
 * | Function                | Replaces                                                                        |
 * |-------------------------|---------------------------------------------------------------------------------|
 * | `mayMerge`              | the merge prompt's `mergeable_state` heuristic; the green cron's `clean` filter  |
 * | `resolveFixDisposition` | `dependencyDedupSkip`; the prior-class escalation table                          |
 * | `resolveReviewTrigger`  | the four scattered review-trigger enforcement points + the cron's draft filter   |
 * | `renderContext`         | `enrichPrFixContext`; everything the prompts render                             |
 *
 * Each returns **`{ decision, reason, inputs }`**, never a bare enum. The reason
 * string is produced by the decision and rendered in three places — the log
 * line, the escalation comment, and the run detail panel — so there is ONE
 * source and three renderings rather than three prose variants that drift. The
 * reason is written `"<case>: <explanation>"` so the case stays greppable
 * without a parallel enum to keep in sync.
 *
 * `inputs` is the subset of the snapshot the decision actually read. It exists
 * so the detail panel can show WHY without the view re-deriving anything, and
 * so a table test asserts the decision and its justification together.
 *
 * Purity is the point: 09-state-machine.md observes that most verification of
 * this plan becomes a table test over literal `PrState` fixtures — no GitHub
 * mock, no sandbox, no harness.
 */

import type { DependenciesConfig, FixConfig, ReviewConfig } from "../config/config.js";
import type { PrState } from "./pr-state.js";
import { renderCiFailureReport } from "./github/github.js";
import { PR_FIX_SHAPED_WORKFLOWS } from "../workflows/target-policy.js";
import { ATTEMPT_FREE_CLASSES } from "./fix-markers.js";
import { PR_NOTES_FILE_NAME, renderPrNotes } from "./pr-notes.js";

/**
 * A skip that must be ESCALATED on the pull request — labelled `requires-human`
 * and explained in one comment — rather than being dropped silently.
 *
 * Three of `resolveFixDisposition`'s skips are terminal *for this problem*: no
 * further event will change the answer until a human (or a new commit) does
 * something. 04-retry.md §4.3 requires those to be visible, because a PR that is
 * skipped with no label, no comment and nothing on the PR explaining why is
 * strictly WORSE than `requires-human` — it is dead and undiagnosable.
 *
 * The other skips must NOT escalate, and the distinction is structural rather
 * than editorial:
 *
 * - `upstream-broken` is not this PR's fault and self-heals the moment the base
 *   goes green (09 → D1 is explicit: skip without labelling).
 * - `fork-pr` gets its own explanation — nothing is wrong with the change.
 * - `human-hold` / `escalated` are ALREADY escalated; re-applying would comment
 *   on every subsequent event.
 * - `already-assessed` is a duplicate delivery, not a verdict.
 *
 * The case is produced by the branch that decided, and travels on the
 * {@link Decision} beside the reason — so the applier switches on a typed field
 * rather than string-matching the reason prose (the same rule the fork-PR notice
 * already follows by keying on `state.isFork`).
 */
export type EscalationCase = "attempts-exhausted" | "budget-exhausted" | "not-retryable";

/** The uniform decision envelope. */
export interface Decision<T> {
  decision: T;
  /** `"<case>: <explanation>"` — logged, commented, and shown in the admin panel. */
  reason: string;
  /** The snapshot fields this decision read. */
  inputs: Record<string, unknown>;
  /**
   * Set ONLY on a `skip` that must be escalated on the PR — see
   * {@link EscalationCase}. Absent on every other decision, including every
   * other skip.
   */
  escalation?: EscalationCase;
  /**
   * Set ONLY when the decision came from {@link resolveReviewTrigger}, carrying
   * its UNDEGRADED three-valued verdict.
   *
   * `resolveDispatchDisposition` has to answer one question — run or not — but
   * `defer` and `skip` are the same answer to it and different answers to "what
   * should the `last-light/review` check say". Carrying the finer verdict here
   * keeps the caller reading a TYPED field rather than re-deriving the case
   * from the reason prose, which is the same rule {@link EscalationCase}
   * follows.
   */
  review?: ReviewTriggerDecision;
}

// ---------------------------------------------------------------------------
// mayMerge — 09 → D10
// ---------------------------------------------------------------------------

/**
 * May this PR be merged AT ALL — by either mechanism?
 *
 * The plan originally gated only DIRECT merge on settled-passing checks and let
 * `github_enable_auto_merge` through ungated, on the reasoning that GitHub's
 * required-checks gate is the real backstop. That reasoning is circular. Auto-
 * merge merges as soon as all merge REQUIREMENTS are satisfied, and on a repo
 * with no required status checks there are no requirements beyond mergeability
 * — so `github_enable_auto_merge` on an already-mergeable PR merges it
 * essentially immediately. Auto-merge and direct merge are the same action
 * there, and that is not a hypothetical population: it is the exact one the
 * merge prompt already documents ("on a repo with no required checks, a PR
 * whose checks are FAILING still reports as mergeable, so a direct merge would
 * land a RED PR — this has happened").
 *
 * So one predicate gates the decision to merge, and auto-merge stays the
 * preferred *mechanism* (it genuinely handles the race between our decision and
 * a late-created check) without being credited with a guarantee it only
 * provides on protected repos.
 *
 * `minSettledChecks` ships at `1` and is operator-only: a `max(repo, operator)`
 * clamp would weld the escape hatch shut in the direction a CI-less repo needs
 * it. The CI-less case is handled on the fact instead — `checksState === "none"`
 * is simply insufficient evidence, which Phase 5 uses to withhold auto-merge
 * from MAJOR bumps while non-majors continue down the existing path.
 */
export function mayMerge(state: PrState, cfg: DependenciesConfig): Decision<boolean> {
  const inputs = {
    checksState: state.checksState,
    settledCheckCount: state.settledCheckCount,
    minSettledChecks: cfg.minSettledChecks,
    requireSettledChecks: cfg.requireSettledChecks,
  };

  if (!cfg.requireSettledChecks) {
    return {
      decision: true,
      reason: "checks-not-required: dependencies.requireSettledChecks is off",
      inputs,
    };
  }
  if (state.checksState === "pending") {
    return { decision: false, reason: "checks-pending: CI has not settled yet", inputs };
  }
  if (state.checksState === "failing") {
    return { decision: false, reason: "checks-failing: CI is red on the head commit", inputs };
  }
  if (state.checksState === "none") {
    return {
      decision: false,
      reason: "no-checks: the head commit has no checks or statuses at all",
      inputs,
    };
  }
  if (state.settledCheckCount < cfg.minSettledChecks) {
    return {
      decision: false,
      reason:
        `too-few-checks: ${state.settledCheckCount} settled check(s), ` +
        `dependencies.minSettledChecks is ${cfg.minSettledChecks}`,
      inputs,
    };
  }
  return {
    decision: true,
    reason: `checks-passing: ${state.settledCheckCount} settled check(s), all green`,
    inputs,
  };
}

// ---------------------------------------------------------------------------
// resolveFixDisposition — 09 → D1, S1
// ---------------------------------------------------------------------------

/** Should a fix run be dispatched for this PR? */
export type FixDisposition = "run" | "skip";

/** Everything `resolveFixDisposition` needs beyond the snapshot. */
export interface FixDispositionOptions {
  /**
   * An explicit human `@bot` request. Overrides the label guard and the
   * per-SHA dedup — a maintainer asking directly is an intentional override,
   * mirroring the carve-out the dependency guard already documents. It does
   * NOT override `upstream-broken` or the budget caps: those are facts, not
   * policy, and re-running against a red base cannot help however nicely you ask.
   */
  explicitRequest?: boolean;
  /**
   * True on the AUTOMATED webhook/cron routes, where "we already assessed this
   * exact SHA" is a genuine duplicate. Left false for a route that has no
   * per-SHA contract.
   */
  dedupOnHeadSha?: boolean;
}

/**
 * Decide whether to spend a fix run on this PR.
 *
 * Replaces `dependencyDedupSkip` and the prior-run escalation table. Two
 * structural rules govern it:
 *
 * **No prior-run verdict may gate dispatch unless the skipping path writes a
 * run row.** A skip returns `{ kind: "skipped" }` and writes NO row, so a gate
 * on "what did the last run conclude" reads the same stale row forever: the PR
 * is dead, with no label, no comment and nothing on the PR explaining why —
 * strictly worse than `requires-human`, which is at least visible. That is
 * exactly how `upstream-broken` would have latched a PR permanently dead (09 →
 * D1), so `upstream-broken` is resolved here as a LIVE `baseChecksState`
 * precondition. The diagnosis class remains an explanation, never a dispatch
 * input.
 *
 * **`requires-human` is a notification, not a state.** The state is "we
 * escalated at head SHA X", so the guard is stateful rather than the label: a
 * maintainer's push re-arms the loop, while a human who applied the label by
 * hand (no escalating run of ours to match) keeps a hard permanent override.
 *
 * Three of the skips are terminal for this problem and carry an
 * {@link EscalationCase} so the caller labels and explains them on the PR
 * (`./pr-escalation.ts`); the rest are deliberately silent. Which is which is a
 * property of the branch, not of its prose — see {@link EscalationCase}.
 */
export function resolveFixDisposition(
  state: PrState,
  cfg: FixConfig,
  opts: FixDispositionOptions = {},
): Decision<FixDisposition> {
  const inputs = {
    baseChecksState: state.baseChecksState,
    checksState: state.checksState,
    headSha: state.headSha,
    escalatedBy: state.escalatedBy,
    escalatedAtSha: state.escalatedAtSha,
    attempt: state.attempt,
    maxAttempts: cfg.maxAttempts,
    cumulativeCostUsd: state.cumulativeCostUsd,
    maxCostUsd: cfg.maxCostUsd,
    priorDiagnosisClass: state.priorDiagnosisClass,
    retryableClasses: cfg.retryableClasses,
    explicitRequest: !!opts.explicitRequest,
  };

  // A fork PR has no branch we can push to. Cheapest possible skip: before the
  // budget arithmetic, before any sandbox.
  if (state.isFork) {
    return {
      decision: "skip",
      reason:
        `fork-pr: head ${state.headRepoFullName ?? "(deleted fork)"} is not on ${state.repo}, ` +
        `so there is nothing to clone or push to`,
      inputs,
    };
  }

  // LIVE precondition, not a prior verdict. Re-evaluated every event, so the
  // moment the base goes green the PR is eligible again — with no label to
  // clear and no run row required to un-stick it.
  if (state.baseChecksState === "failing") {
    return {
      decision: "skip",
      reason: `upstream-broken: base branch ${state.baseRef || "(unknown)"} is failing — a fix here cannot make CI green`,
      inputs,
    };
  }

  if (state.escalatedBy === "human" && !opts.explicitRequest) {
    return {
      decision: "skip",
      reason:
        "human-hold: requires-human was applied by a human, not by one of our runs — a permanent override",
      inputs,
    };
  }

  if (state.escalatedBy === "us" && !opts.explicitRequest) {
    // We escalated. Still binding only while the head is the one we escalated
    // at, or a commit WE authored on top of it — anyone else's push IS the
    // human intervention we asked for, and re-arms both the counter and the
    // merge path without anyone having to remove a label.
    const sameProblem = state.headSha === state.escalatedAtSha || state.headIsOurs;
    if (sameProblem) {
      return {
        decision: "skip",
        reason: `escalated: we escalated this PR at ${(state.escalatedAtSha ?? "").slice(0, 7)} and nothing has changed since`,
        inputs,
      };
    }
  }

  // The three ESCALATING skips. Ordering between them is cosmetic — all three
  // apply the same label and the same comment, so it only picks which case the
  // comment names — but they must all come AFTER the guards above, or a fork PR
  // whose budget happens to be spent would be labelled `requires-human` for a
  // problem that is not its author's to fix.
  if (cfg.maxCostUsd !== null && state.cumulativeCostUsd >= cfg.maxCostUsd) {
    return {
      decision: "skip",
      reason:
        `budget-exhausted: $${state.cumulativeCostUsd.toFixed(2)} spent on this PR, ` +
        `fix.maxCostUsd is $${cfg.maxCostUsd.toFixed(2)}`,
      inputs,
      escalation: "budget-exhausted",
    };
  }

  if (state.attempt > cfg.maxAttempts) {
    return {
      decision: "skip",
      reason: `attempts-exhausted: attempt ${state.attempt} exceeds fix.maxAttempts ${cfg.maxAttempts}`,
      inputs,
      escalation: "attempts-exhausted",
    };
  }

  // The ONE prior-run verdict that gates dispatch — and it is only allowed to
  // because this skip WRITES A RUN ROW (09 → D1's general rule: "no prior-run
  // verdict may gate dispatch unless the skipping path writes a run row").
  // `upstream-broken` was the counter-example: gated on a remembered class
  // through a path that recorded nothing, so `latestForTrigger` returned the
  // same stale row forever and the PR was dead. It became a live precondition
  // above; this one escalates instead, which is both visible and clearable.
  //
  // Expressed against `fix.retryableClasses` rather than hardcoding
  // `infra-dependent`, because that leaf's whole contract is "classes another
  // attempt may help with; every other class escalates immediately". The two
  // exclusions are exactly {@link ATTEMPT_FREE_CLASSES}, which is not a
  // coincidence: `flaky` is bounded by `fix.maxFlakyDeferrals` (a deferral, not
  // a verdict) and `upstream-broken` is not this PR's fault — the same reason
  // they cost no attempt is the reason they must not escalate.
  const priorClass = state.priorDiagnosisClass;
  if (
    priorClass &&
    !ATTEMPT_FREE_CLASSES.has(priorClass) &&
    !cfg.retryableClasses.includes(priorClass) &&
    !opts.explicitRequest
  ) {
    return {
      decision: "skip",
      reason:
        `not-retryable: attempt ${state.attempt - 1} diagnosed \`${priorClass}\`, which is not in ` +
        `fix.retryableClasses (${cfg.retryableClasses.join(", ") || "none"}) — another attempt cannot help`,
      inputs,
      escalation: "not-retryable",
    };
  }

  // "Already assessed at this exact SHA" — the automated routes' idempotency
  // contract. A multi-app repo re-fires a suite and the daily cron overlaps, so
  // without this the same PR is re-assessed repeatedly. SUCCEEDED runs only,
  // which is what leaves room for a genuine retry: a run that CRASHED at this
  // SHA records nothing here and is attempted again (bounded by `maxAttempts`),
  // while a run that correctly concluded "not fixable from here" recorded
  // `succeeded` and is not.
  if (opts.dedupOnHeadSha && !opts.explicitRequest && state.headSha) {
    const assessedBy = [...PR_FIX_SHAPED_WORKFLOWS].find(
      (w) => state.assessedHeadShaByWorkflow[w] === state.headSha,
    );
    if (assessedBy) {
      return {
        decision: "skip",
        reason: `already-assessed: ${assessedBy} already handled ${state.headSha.slice(0, 7)}`,
        inputs,
      };
    }
  }

  return {
    decision: "run",
    reason: `attempt ${state.attempt}/${cfg.maxAttempts}`,
    inputs,
  };
}

// ---------------------------------------------------------------------------
// resolveReviewTrigger — 09 → S2
// ---------------------------------------------------------------------------

/**
 * Should a `pr-review` run be dispatched?
 *
 * `defer` and `skip` both mean "no run right now" — the dispatch gate treats
 * them identically. They differ only in what they say about the FUTURE, which
 * is what the `last-light/review` check run has to render:
 *
 * - **`defer`** — the answer is "not yet". CI has not settled, or the mode is
 *   `on-request` and nobody has asked. Something later (a settled check suite,
 *   the sweep, a label, the check's Re-run button) can still turn it into a
 *   review, so `postsCheck` posts a placeholder saying so.
 * - **`skip`** — there is nothing to do. It is a draft, we already reviewed
 *   this head, or another run owns the PR. No check: 09 → S2 is explicit that a
 *   run which never dispatches must not create one "rather than creating and
 *   immediately concluding one".
 */
export type ReviewTriggerDecision = "dispatch" | "defer" | "skip";

/**
 * What `last-light/review` check (if any) a review decision should leave on the
 * PR — the projection of {@link ReviewTriggerDecision} onto the check run.
 *
 * - `in-progress` — a run is starting; the check is created here and completed
 *   from that run's TERMINAL TRANSITION (`./review-check.ts`), never from a
 *   `.then()` on an in-memory promise.
 * - `queued` — `after-checks` is waiting for CI. Branch protection can already
 *   see the check, so a repo may require it without racing the settle event.
 * - `neutral` — `on-request` is waiting for a human. `neutral` counts as
 *   passing for branch protection, so it never blocks a merge, and the check's
 *   own Re-run button becomes the request affordance.
 * - `none` — leave the PR alone.
 */
export type ReviewCheckPlacement = "in-progress" | "queued" | "neutral" | "none";

/**
 * Which check the decision implies. Keyed on the TYPED decision plus the mode,
 * never on the reason prose — the same rule the escalation applier follows.
 */
export function reviewCheckPlacement(
  decision: ReviewTriggerDecision,
  cfg: ReviewConfig,
): ReviewCheckPlacement {
  if (decision === "dispatch") return "in-progress";
  if (decision === "skip") return "none";
  return cfg.trigger === "on-request" ? "neutral" : "queued";
}

/** Everything `resolveReviewTrigger` needs beyond the snapshot. */
export interface ReviewTriggerOptions {
  /**
   * An explicit `@bot review` (or an operator/CLI trigger). ALWAYS dispatches,
   * overriding mode, draft and dedup. Today that carve-out is accidental — the
   * comment path simply never crosses these code paths; as one branch of the
   * resolver it is a decision.
   */
  explicitRequest?: boolean;
  /**
   * How this dispatch arrived. `"checks-settled"` is the `after-checks`
   * trigger; `"attention"` is `pr.opened`/`synchronize`/`reopened`; `"sweep"`
   * is the `check-prs-awaiting-review` cron, which is the RELEASE MECHANISM for
   * every PR whose fix chain ended without pushing (attempts exhausted,
   * `infra-dependent`, a `flaky` deferral, `upstream-broken`, or a crash) — no
   * new commit exists, so no further `check_suite` will ever fire for them.
   */
  route?: "attention" | "checks-settled" | "sweep";
}

/**
 * One resolver, every route.
 *
 * The split is DISCOVERY vs POLICY, not webhook vs cron: `review-discovery.ts`
 * finds candidates and learns nothing about modes, drafts or settled checks,
 * while this function — called from the single dispatch choke point — decides.
 * The alternative was three independent implementations of `review.trigger`,
 * in a plan whose thesis is "make the policy configurable rather than
 * hardcoded".
 *
 * FIX OUTRANKS REVIEW. A settled-failing suite routes to the fix family, and
 * the review is simply not dispatched — not deferred, not queued, no record.
 * That is a consequence of the PR-scoped run lock rather than a separate field:
 * if a fix run is in flight, reviewing a tree it is concurrently rewriting
 * produces a review that is stale before it lands.
 */
export function resolveReviewTrigger(
  state: PrState,
  cfg: ReviewConfig,
  opts: ReviewTriggerOptions = {},
): Decision<ReviewTriggerDecision> {
  const route = opts.route ?? "attention";
  const inputs = {
    trigger: cfg.trigger,
    skipDraft: cfg.skipDraft,
    requestLabel: cfg.requestLabel,
    isDraft: state.isDraft,
    checksState: state.checksState,
    botReviewAtHead: state.botReviewAtHead?.state ?? null,
    runInFlight: state.runInFlight,
    route,
    explicitRequest: !!opts.explicitRequest,
  };

  const labelRequested = !!cfg.requestLabel && state.labels.includes(cfg.requestLabel);
  if (opts.explicitRequest || labelRequested) {
    return {
      decision: "dispatch",
      reason: labelRequested
        ? `requested: the \`${cfg.requestLabel}\` label asks for a review`
        : "requested: an explicit review request overrides mode, draft and dedup",
      inputs,
    };
  }

  if (cfg.trigger === "on-request") {
    // `defer`, not `skip`: a label, a comment, or the check's own Re-run button
    // can still ask for this review, and `postsCheck` advertises exactly that.
    return {
      decision: "defer",
      reason: "on-request: review.trigger is `on-request` and nobody asked",
      inputs,
    };
  }

  if (cfg.skipDraft && state.isDraft) {
    return { decision: "skip", reason: "draft: review.skipDraft is on", inputs };
  }

  if (state.runInFlight) {
    return {
      decision: "skip",
      reason: `run-in-flight: ${state.runInFlight.workflow} ${state.runInFlight.runId} is already working this PR`,
      inputs,
    };
  }

  if (state.botReviewAtHead) {
    return {
      decision: "skip",
      reason: `already-reviewed: we reviewed ${state.headSha.slice(0, 7)} (${state.botReviewAtHead.state})`,
      inputs,
    };
  }

  if (cfg.trigger === "after-checks") {
    // "On settle, EITHER COLOUR." The `passing` variant was deleted: a PR we
    // gave up on never goes green, so under `passing` the escalated PRs — the
    // ones most needing human eyes — would be the only ones with no review at
    // all. Either colour is also what lets the review cite the CI failure.
    if (state.checksState === "pending") {
      return { decision: "defer", reason: "checks-pending: waiting for CI to settle", inputs };
    }
    if (route === "attention") {
      return {
        decision: "defer",
        reason: "after-checks: review.trigger waits for a settled check suite, not PR attention",
        inputs,
      };
    }
  }

  return {
    decision: "dispatch",
    reason: `${cfg.trigger}: ${route} route, checks ${state.checksState}`,
    inputs,
  };
}

// ---------------------------------------------------------------------------
// resolveMergeDisposition — the dependency-merge route's dispatch gate
// ---------------------------------------------------------------------------

/**
 * Should a `dependabot-pr-merge` run be dispatched for this PR?
 *
 * `resolveFixDisposition` cannot serve this route: its fork guard, attempt
 * counter and cost cap are facts about the FIX FAMILY, and a PR whose fix
 * attempts are exhausted must still be mergeable the moment CI goes green.
 * What the two share is the pair of guards that are facts about the PULL
 * REQUEST — "a human told us to stay out" and "we already assessed this exact
 * head" — so those are restated here rather than inherited.
 *
 * Note what is deliberately NOT here: {@link mayMerge}. That predicate gates
 * the ACTION (Phase 5's merge decision, inside the run, where the impact tier
 * is known); this gates the DISPATCH. The only overlap worth paying for before
 * a sandbox is `pending` — CI is still running, so there is nothing to decide
 * yet and the settled webhook or the daily cron will bring the PR back. Using
 * the full `mayMerge` here would additionally refuse every CI-less repo
 * (`checksState === "none"`), which 09 → D10 explicitly reserves for MAJOR
 * bumps rather than applying to the whole route.
 */
export function resolveMergeDisposition(
  state: PrState,
  cfg: DependenciesConfig,
  opts: FixDispositionOptions = {},
): Decision<FixDisposition> {
  const inputs = {
    checksState: state.checksState,
    settledCheckCount: state.settledCheckCount,
    requireSettledChecks: cfg.requireSettledChecks,
    headSha: state.headSha,
    escalatedBy: state.escalatedBy,
    escalatedAtSha: state.escalatedAtSha,
    explicitRequest: !!opts.explicitRequest,
  };

  if (state.escalatedBy === "human" && !opts.explicitRequest) {
    return {
      decision: "skip",
      reason:
        "human-hold: requires-human was applied by a human, not by one of our runs — a permanent override",
      inputs,
    };
  }

  if (state.escalatedBy === "us" && !opts.explicitRequest) {
    const sameProblem = state.headSha === state.escalatedAtSha || state.headIsOurs;
    if (sameProblem) {
      return {
        decision: "skip",
        reason: `escalated: we escalated this PR at ${(state.escalatedAtSha ?? "").slice(0, 7)} and nothing has changed since`,
        inputs,
      };
    }
  }

  if (opts.dedupOnHeadSha && !opts.explicitRequest && state.headSha) {
    if (state.assessedHeadShaByWorkflow["dependabot-pr-merge"] === state.headSha) {
      return {
        decision: "skip",
        reason: `already-assessed: dependabot-pr-merge already handled ${state.headSha.slice(0, 7)}`,
        inputs,
      };
    }
  }

  // The cheapest possible "wait while CI is still running" guard — before any
  // sandbox is provisioned. A multi-app repo settles one suite at a time and
  // the daily cron overlaps the webhook, so without this a merge assessment
  // runs against a PR whose verdict is not in yet.
  if (cfg.requireSettledChecks && state.checksState === "pending") {
    return {
      decision: "skip",
      reason: "checks-pending: CI has not settled yet — the settled webhook or the daily cron will bring it back",
      inputs,
    };
  }

  return { decision: "run", reason: `checks ${state.checksState}`, inputs };
}

// ---------------------------------------------------------------------------
// resolveDispatchDisposition — the one gate every route crosses
// ---------------------------------------------------------------------------

/** The three policy blocks a PR-scoped dispatch reads, already repo-clamped. */
export interface PrPolicyConfig {
  fix: FixConfig;
  dependencies: DependenciesConfig;
  review: ReviewConfig;
}

/** Everything {@link resolveDispatchDisposition} needs beyond the snapshot. */
export type DispatchDispositionOptions = FixDispositionOptions & ReviewTriggerOptions;

/**
 * Which decision governs a dispatch of `workflowName`, resolved to one verdict.
 *
 * The dispatcher (webhook / comment routes) and `dispatchWorkflow` (cron,
 * `/api/run`) both need the same answer, and the whole point of 09 is that they
 * must not each carry their own version of it. So the workflow→decision mapping
 * lives here, once, as a pure function — the call sites differ only in what they
 * DO with a `skip` (reply to the human who asked, versus log and record nothing).
 *
 * `pr-review` crosses {@link resolveReviewTrigger}. Its three-valued verdict
 * collapses to two here — `defer` and `skip` are both "do not spend a run now"
 * — but the caller keeps the undegraded decision on {@link Decision.review},
 * because the CHECK RUN each should leave behind differs: see
 * {@link reviewCheckPlacement}.
 */
export function resolveDispatchDisposition(
  workflowName: string,
  state: PrState,
  cfg: PrPolicyConfig,
  opts: DispatchDispositionOptions = {},
): Decision<FixDisposition> {
  if (PR_FIX_SHAPED_WORKFLOWS.has(workflowName)) {
    return resolveFixDisposition(state, cfg.fix, opts);
  }
  if (workflowName === "dependabot-pr-merge") {
    return resolveMergeDisposition(state, cfg.dependencies, opts);
  }
  if (workflowName === "pr-review") {
    const review = resolveReviewTrigger(state, cfg.review, opts);
    return {
      decision: review.decision === "dispatch" ? "run" : "skip",
      reason: review.reason,
      inputs: review.inputs,
      review: review.decision,
    };
  }
  return {
    decision: "run",
    reason: `ungated: no dispatch policy governs ${workflowName}`,
    inputs: { workflowName },
  };
}

// ---------------------------------------------------------------------------
// renderContext
// ---------------------------------------------------------------------------

/**
 * Project the snapshot into the template variables the prompts render.
 *
 * Replaces `enrichPrFixContext` and closes the divergence 00 records as a
 * latent bug: the cron fan-out called `dispatchWorkflow` DIRECTLY, bypassing
 * `handlePrFix`, so every nightly `fix-red-dependency-prs` run carried
 * `branch` + `reason` but an EMPTY `{{ciSection}}` and no fork guard — while
 * the webhook route carried `ciSection` but no `{{reason}}`. One projection at
 * one choke point makes both routes identical by construction.
 *
 * Pure: the CI report was already fetched into the snapshot, so this renders it
 * rather than fetching it.
 *
 * `fix` and `dependencies` are optional because the variables they contribute
 * are policy, not state — they come from the run's already-repo-clamped config
 * blocks, not from the PR. Omitting one leaves its variables undefined, which
 * the prompts' own `{{#if maxAttempts}}`-style guards already handle.
 */
export function renderContext(
  state: PrState,
  fix?: FixConfig,
  dependencies?: DependenciesConfig,
): Record<string, unknown> {
  // The merge gate, decided ONCE here rather than re-derived in prose by the
  // merge prompt. 09's thesis is one source and three renderings; a predicate
  // restated as an instruction is a fourth reading free to disagree — and it
  // did. `{{#if !checksSettledPassing}}` (what the prompt gated its
  // "gate is CLOSED" banner on) diverges from `mayMerge` in both directions:
  // it misses `settledCheckCount < minSettledChecks`, so an operator who raises
  // `minSettledChecks` gets a banner claiming the gate is open while the gate
  // is shut; and it ignores the `requireSettledChecks: false` exemption, so a
  // deployment that turned the gate off still gets told not to merge.
  const merge = dependencies ? mayMerge(state, dependencies) : undefined;
  const failedChecks = state.ciReport ? renderCiFailureReport(state.ciReport) : "";
  return {
    // Identity / targeting.
    headSha: state.headSha,
    branch: state.headRef,
    // The PR's REAL base — not the repo default. A PR targeting a release
    // branch used to have the fix prompt merge the wrong base in step 1.
    baseBranch: state.baseRef,
    prTitle: state.title,
    prLabels: state.labels,
    isDraft: state.isDraft,

    // Check evidence.
    checksState: state.checksState,
    checksSettledPassing: state.checksState === "passing",
    settledCheckCount: state.settledCheckCount,
    // The gate itself, and the reason IT produced — so the prompt states the
    // same case the log line and the admin panel state.
    mayMerge: merge?.decision,
    mayMergeReason: merge?.reason,
    baseChecksState: state.baseChecksState,
    failedChecks,
    // The "No failed checks found." sentinel must not reach the prompt as if it
    // were evidence — `{{#if ciSection}}` is how the templates gate the block.
    ciSection:
      failedChecks && !failedChecks.includes("No failed checks")
        ? `CI FAILURES (from GitHub Actions — fix these first):\n${failedChecks}`
        : "",
    ciLogsAvailable: state.ciReport?.logsAvailable ?? false,

    // Retry state. `maxAttempts` is rendered by all three fix prompts as
    // `{{#if maxAttempts}} of {{maxAttempts}}{{/if}}` and was simply never
    // provided — "this is attempt 2" instead of "this is attempt 2 of 3", which
    // is the half that tells the agent whether to spend or to stop.
    attempt: state.attempt,
    maxAttempts: fix?.maxAttempts,
    priorAttempts: state.priorAttempts,

    // The PR journal (10-pr-memory.md), projected to ONE fenced string.
    //
    // A string, not the array, and that is the enforcement rather than a
    // convenience: this is the only consumer `PrState.notes` has, so a note can
    // reach an agent's eyes and can reach nothing else. There is no
    // `notesSayFlaky` boolean, no `hasNotes` flag, no per-kind list — nothing a
    // YAML `skip_if` / `until` expression or a decision function could branch
    // on. Notes inform; they never authorise. The fence and the trust statement
    // are emitted by `renderPrNotes` itself rather than written into the
    // (forkable) prompt templates, so no fork can drop them.
    priorNotes: renderPrNotes(state.notes),
    // Where the agent appends a new note. A template variable rather than a
    // literal in each prompt so the placement stays resolvable in ONE place —
    // it is a bare relative path because the agent's cwd is the checkout on
    // every backend, which is the same reason `.lastlight-verify.sh` is one.
    notesFile: PR_NOTES_FILE_NAME,

    // Flaky-deferral state. The PROMOTION itself (a third consecutive `flaky`
    // is treated as `reproducible`, 09 → S1) is ACTED ON elsewhere —
    // `promoteFlakyDiagnosis` in `workflows/simple.ts` drops the `class=flaky`
    // row from the `fix` phase's `skip_if` for that run, because the engine's
    // expression grammar has no negation to express the conjunction with. What
    // is exposed here is the same fact for the PROMPT, so the agent can say why
    // `flaky` is no longer being accepted for this PR.
    flakyDeferrals: state.flakyDeferrals,
    maxFlakyDeferrals: fix?.maxFlakyDeferrals,
    flakyPromoted:
      fix !== undefined && state.flakyDeferrals >= fix.maxFlakyDeferrals,
  };
}
