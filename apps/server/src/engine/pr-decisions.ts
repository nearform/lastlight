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
import { HOLD_LABEL } from "../cron/dependabot-discovery.js";
import { ATTEMPT_FREE_CLASSES } from "./fix-markers.js";
import { renderPrNotes } from "./pr-notes.js";
import { PR_NOTES_FILE_NAME, VERIFY_SCRIPT_NAME } from "./fix-scratch.js";

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
 * - `on-hold` is a maintainer's instruction; labelling and commenting on a PR
 *   somebody has explicitly told us to leave alone is the opposite of obeying it.
 * - `escalated` is ALREADY escalated; re-applying would comment on every
 *   subsequent event.
 * - `already-assessed` is a duplicate delivery, not a verdict.
 *
 * The case is produced by the branch that decided, and travels on the
 * {@link Decision} beside the reason — so the applier switches on a typed field
 * rather than string-matching the reason prose. Every other consequence follows
 * the same rule: {@link Decision.runInFlight}, {@link Decision.readDegraded} and
 * {@link Decision.forkPr} are each set by exactly the branch that decided them.
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
   * Set ONLY on a skip produced by the PR-scoped run lock (09 → S4), carrying
   * the run that holds it.
   *
   * A lock drop is NOT terminal and must not be treated as one: nothing is
   * wrong with the PR, we simply cannot work on it while another run owns its
   * workspace. So it carries no {@link EscalationCase} — it labels nothing,
   * comments nothing and writes no run row — and the caller keys on this typed
   * field rather than string-matching the reason prose, exactly as the
   * escalation applier keys on `escalation` and the fork notice on
   * {@link Decision.forkPr}. The one response it does earn is a REPLY when a human asked
   * directly: a maintainer who is silently dropped will just ask again.
   *
   * Drop-and-reply (rather than queue) is only sound because every dropped case
   * has a cron re-pickup — `merge-green-dependency-prs`, `fix-red-dependency-prs`
   * and `check-prs-awaiting-review`. A future phase must convert
   * drop-on-lock into queue-on-lock before removing any of them.
   */
  runInFlight?: { workflow: string; runId: string };
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
  /**
   * Set ONLY on the generated-only review skip (issue #271), carrying the review
   * that still stands and the SHA it was posted against.
   *
   * The typed field, not the reason prose, is what tells the check-run
   * projection this skip is DIFFERENT from every other one. Every other review
   * skip leaves no check on the new head because it either already has one
   * (`already-reviewed`) or must not have one (draft, hold, lock). This skip
   * leaves a head SHA with none — and on a deployment whose branch protection
   * requires `last-light/review`, a missing check is an unmergeable PR. So it
   * carries the prior verdict forward instead ({@link ReviewCheckPlacement}
   * `carried-over`), which is also the honest statement: the review that stands
   * is the one we already posted.
   */
  reviewUnchanged?: { sha: string; state: string };
  /**
   * Set ONLY on a skip produced by {@link readDegradedDrop} — the PR read
   * itself failed, so nothing below it was decided on facts.
   *
   * Like {@link runInFlight} and for the same reason: it is transient, not
   * terminal, so it carries no {@link EscalationCase}, labels nothing, comments
   * nothing and writes no run row. The caller keys on this typed field rather
   * than on the reason prose.
   */
  readDegraded?: true;
  /**
   * Set ONLY on the HOLD skip — a maintainer put the hold label on this subject
   * and every workflow is off it until they take it back (02-hold-label.md).
   *
   * Carries the LABEL rather than a bare `true`, because the one thing the
   * caller does with it is name the label to the person it just refused: a
   * message that says "I'm not acting here" without saying which label to remove
   * is a dead end. The name is operator-configurable, so it cannot be a literal
   * at the call site.
   *
   * Like {@link runInFlight} and {@link readDegraded}: no {@link EscalationCase},
   * no label, no comment, no run row, no review placeholder. Silent, exactly
   * like `upstream-broken` — an instruction we are obeying is not a verdict
   * about the change, and there is nothing to tell anybody that the label on the
   * PR does not already say.
   */
  onHold?: { label: string };
  /**
   * Set ONLY on the `fork-pr` skip — the head branch lives on a repo we cannot
   * push to, so there is nothing to clone or push.
   *
   * A typed field rather than the caller re-deriving it from `state.isFork`,
   * which is what it used to do. Those are not the same predicate: `isFork` is
   * true on EVERY skip a fork PR takes, so a fork PR dropped by the run lock, by
   * a deferred review or by the head-SHA dedup each earned a fork-PR notice
   * saying "I can't apply fixes to this PR" — an explanation of a decision that
   * was not taken (#256). Only the branch that actually decided `fork-pr` sets
   * this.
   */
  forkPr?: true;
}

// ---------------------------------------------------------------------------
// The PR-scoped run lock — 09 → S4
// ---------------------------------------------------------------------------

/**
 * "Another run already owns this PR" — stated ONCE, for every disposition.
 *
 * The lock is PR-scoped across every PR-scoped workflow (`pr-fix`,
 * `dependabot-ci-fix`, `dependabot-pr-merge`, `pr-review`), and
 * `prScopedWorkflows()` is exactly the union of the three dispositions below —
 * so a guard that lives in one of them is a guard only one route obeys. It used
 * to: `resolveReviewTrigger` checked `runInFlight` and the two others did not,
 * while the dispatcher checked it inline for the webhook/comment route and
 * `dispatchWorkflow` (the cron fan-out and `/api/run`) never did at all. The
 * daily `fix-red-dependency-prs` could therefore dispatch `dependabot-ci-fix`
 * onto a PR that already had a live `pr-fix` run, and
 * `merge-green-dependency-prs` could enable auto-merge against a PR whose fix
 * run was still writing its marker — the two sequences 09 → S4 names verbatim
 * as the reason the lock exists.
 *
 * That is worse than harmless duplication now that the fix family shares ONE
 * workspace per PR (`${repo}-${prNumber}-fix`): two runs `git fetch` +
 * `reset --hard` + `git clean -fdx` the same directory while an agent works in
 * it, and each rewrites the other's `.git/lastlight-verify.sh` gate.
 *
 * It is checked FIRST in each disposition, before every other skip, because it
 * is the one skip that is purely transient. Ordering it after the escalating
 * skips would label a PR `requires-human` for a budget that a run currently in
 * flight is still spending; ordering it after `explicitRequest` would let an
 * `@bot fix this` walk straight into the running agent's workspace.
 */
/**
 * "We could not read the pull request" — the one place {@link PrState.readErrors}
 * is allowed to change an outcome.
 *
 * Every live read in `resolvePrState` is best-effort and degrades to a value
 * that cannot cause a skip. That fail-open is load-bearing and stays: we would
 * far rather re-run than silently drop a genuine event because GitHub had a bad
 * minute. But `getPullRequest` is not like the others. It is the read that
 * supplies `labels`, `isFork`, `isDraft`, `headSha` and `headRef` — the inputs
 * to almost every guard below — and its degraded values are all the PERMISSIVE
 * ones: `labels: []` so the `requires-human` hold does not apply, `isFork:
 * false` so the fork guard does not apply, `headSha: ""` so the dedup does not
 * apply. A 403 or 404 therefore produces a snapshot that looks perfectly
 * healthy, and the cron route then dispatches a repo-write sandbox run against
 * a pull request we know nothing about (#256).
 *
 * So this one read failing is a "come back later", not a verdict — the same
 * shape as {@link runLockDrop}: no label, no comment, no run row, and the cron
 * re-pickup is what makes dropping sound. Every OTHER read failing still
 * fails open exactly as documented.
 */
function readDegradedDrop<T>(decision: T, state: PrState, inputs: Record<string, unknown>): Decision<T> | null {
  const failed = state.readErrors.filter((e) => e.startsWith("getPullRequest"));
  if (!failed.length) return null;
  return {
    decision,
    reason:
      `read-degraded: could not read the pull request (${failed.join("; ")}), so every guard below ` +
      `would be evaluating defaults rather than facts`,
    inputs: { ...inputs, readErrors: failed },
    readDegraded: true,
  };
}

/**
 * "A maintainer told us to stay off this pull request" — the HOLD
 * (02-hold-label.md, locked decisions 2–4).
 *
 * The ONE label the harness reads as a decision input, and the reason
 * `requires-human` no longer is one. It is a LIVE PRECONDITION in the same
 * sense `baseChecksState` is: present or absent right now, re-evaluated on every
 * event, nothing persisted, nothing to migrate, and removing it resumes the bot
 * with no record to clean up. That is also why it needs no `author_association`
 * check — GitHub already requires triage permission to add or remove a label.
 *
 * It sits above EVERY other guard except {@link readDegradedDrop}, and the
 * ordering is the whole design:
 *
 * - **above the run lock**, because the lock reports "come back later" and the
 *   hold reports "do not come back" — reporting the transient one would be true
 *   and useless;
 * - **above the fork check**, because a fork notice explains a decision we did
 *   not take;
 * - **above the budgets**, because they escalate — labelling `requires-human`
 *   and commenting on a PR a maintainer has explicitly told us to leave alone is
 *   the exact opposite of what the label asked for;
 * - **below the degraded read**, because `labels: []` is what a failed
 *   `getPullRequest` degrades to, so on that path we do not know whether the
 *   hold is there. "We could not read the PR" outranks every reading of it.
 *
 * It also beats an EXPLICIT request (locked decision 4) — otherwise it is not a
 * block. The reply that owes the human an explanation belongs to the route that
 * has one, not here: see {@link Decision.onHold}.
 */
function holdDrop<T>(
  decision: T,
  state: PrState,
  label: string,
  inputs: Record<string, unknown>,
): Decision<T> | null {
  if (!label || !state.labels.includes(label)) return null;
  return {
    decision,
    reason:
      `on-hold: \`${label}\` is applied to this pull request — a maintainer asked me to stay ` +
      `off it, so nothing runs until the label is removed`,
    inputs: { ...inputs, holdLabel: label },
    onHold: { label },
  };
}

/**
 * The one reply a hold ever produces — for a human who asked and lost.
 *
 * Locked decision 4: the hold beats an explicit request, and the bot says so
 * once. A silently-ignored direct instruction is worse than a refused one, and
 * the person is right there waiting; every OTHER hold skip says nothing at all.
 *
 * Pure, so the wording is table-testable, and SHARED by the two routes that have
 * a human on the other end — the router's subject-level ignore (issue and PR
 * comments) and the dispatcher's PR gate. One string, so a maintainer gets the
 * same sentence wherever they asked.
 *
 * It names the label, because the label is the remedy: "I'm not acting" without
 * "remove X" is a dead end, and the name is operator-configurable so it cannot
 * be a literal in the prose.
 */
export function holdReply(label: string): string {
  return (
    `I'm staying off this one — it's labelled \`${label}\`, which tells me not to act on it. ` +
    `Remove the label and ask me again and I'll pick it up.`
  );
}

function runLockDrop<T>(decision: T, state: PrState, inputs: Record<string, unknown>): Decision<T> | null {
  if (!state.runInFlight) return null;
  const { workflow, runId } = state.runInFlight;
  return {
    decision,
    reason: `run-in-flight: ${workflow} ${runId} is already working this PR`,
    inputs,
    runInFlight: state.runInFlight,
  };
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
 * **`requires-human` is a notification, not a state** — and now literally so.
 * The state is "we escalated at head SHA X" (`escalatedAtSha`), so the guard is
 * stateful rather than the label, and a maintainer's push re-arms the loop with
 * nothing to remove by hand. The label itself is read NOWHERE: a human who wants
 * the bot off a PR applies the HOLD label instead (see {@link holdDrop}), which
 * is an instruction rather than a hold inferred from a label we also apply
 * ourselves — an inference that only ever worked on a PR we had never touched
 * (02-hold-label.md).
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
    escalatedAtSha: state.escalatedAtSha,
    // The retry direction of human intent. Read by NO branch below — a recorded
    // retry has already done its work in `applyDerivedState` (the counter, the
    // cost baseline and `escalatedAtSha` are all re-armed by the time this
    // function runs) — but carried on `inputs` so the run detail panel can say
    // WHO asked and why the budgets look freshly armed on a PR that has clearly
    // been round this loop before.
    intervention: state.intervention,
    attempt: state.attempt,
    maxAttempts: cfg.maxAttempts,
    cumulativeCostUsd: state.cumulativeCostUsd,
    maxCostUsd: cfg.maxCostUsd,
    priorDiagnosisClass: state.priorDiagnosisClass,
    retryableClasses: cfg.retryableClasses,
    runInFlight: state.runInFlight,
    explicitRequest: !!opts.explicitRequest,
  };

  // We could not read the PR at all — see `readDegradedDrop`. Above even the
  // run lock, because `runInFlight` is the one input below that does NOT come
  // from the failed read: reporting "another run owns this PR" would be true
  // but beside the point, and the honest answer is that we know nothing.
  const blind = readDegradedDrop<FixDisposition>("skip", state, inputs);
  if (blind) return blind;

  // The PR-scoped run lock, before anything else — see `runLockDrop`.
  const locked = runLockDrop<FixDisposition>("skip", state, inputs);
  if (locked) return locked;

  // A fork PR has no branch we can push to. Cheapest possible skip: before the
  // budget arithmetic, before any sandbox.
  if (state.isFork) {
    return {
      decision: "skip",
      reason:
        `fork-pr: head ${state.headRepoFullName ?? "(deleted fork)"} is not on ${state.repo}, ` +
        `so there is nothing to clone or push to`,
      inputs,
      forkPr: true,
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

  // OUR OWN escalation record — `escalatedAtSha !== null`, never the label.
  // `requires-human` is a NOTIFICATION and is read by nothing (02-hold-label.md):
  // a maintainer who wants us off a PR applies the HOLD label above, which is an
  // instruction rather than something we infer from a label we also write
  // ourselves. This branch is only ever about a run of OURS that stopped.
  //
  // A recorded RETRY consumes the record, so this branch simply does not fire
  // after one — there is no `intervention` clause here on purpose
  // (03-retry-intervention.md). `explicitRequest` still bypasses it, and that is
  // now a much smaller carve-out than it was: it used to clear the guard and
  // fall straight through into `budget-exhausted` below, which re-escalated and
  // posted a duplicate comment. A retry moves the WINDOW rather than lifting the
  // guard, and `escalatePr`'s own same-head dedup catches whatever gets here
  // anyway.
  if (state.escalatedAtSha !== null && !opts.explicitRequest) {
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
 * - `carried-over` — the generated-only skip (issue #271). A COMPLETED check on
 *   the new head repeating the verdict of the review we already posted, so a
 *   push that changed nothing a reviewer could read does not strand a required
 *   check. Its conclusion mirrors that prior review rather than being fixed:
 *   carrying a CHANGES_REQUESTED forward as `success` would clear a gate the
 *   review deliberately closed.
 * - `none` — leave the PR alone.
 */
export type ReviewCheckPlacement = "in-progress" | "queued" | "neutral" | "carried-over" | "none";

/**
 * Which check the decision implies. Keyed on the TYPED decision plus the mode,
 * never on the reason prose — the same rule the escalation applier follows.
 *
 * `unchanged` is {@link Decision.reviewUnchanged} — the one skip that leaves a
 * check behind. It is a separate argument rather than a fourth
 * {@link ReviewTriggerDecision} because it changes nothing about whether a run
 * dispatches, which is the only question that type answers.
 */
export function reviewCheckPlacement(
  decision: ReviewTriggerDecision,
  cfg: ReviewConfig,
  opts: { unchanged?: boolean } = {},
): ReviewCheckPlacement {
  if (decision === "dispatch") return "in-progress";
  if (decision === "skip") return opts.unchanged ? "carried-over" : "none";
  return cfg.trigger === "on-request" ? "neutral" : "queued";
}

// ---------------------------------------------------------------------------
// Generated-path matching — the input to the generated-only re-review gate
// ---------------------------------------------------------------------------

/**
 * Compiled `review.generatedPaths` patterns, keyed by the pattern text.
 *
 * The list is config, so it is the same handful of strings for the life of the
 * process; compiling them per dispatch would be pure waste. Unbounded only in
 * the sense that config is — a repo layer can add entries, and the repo-layer
 * bounds cap the file that supplies them.
 */
const globCache = new Map<string, RegExp>();

/**
 * One glob pattern as a RegExp, with the segment-aware semantics `*` implies
 * everywhere else it appears in this codebase:
 *
 * - `*` matches within one path segment (it stops at a `/`)
 * - `**` crosses segments; `**​/` specifically matches ZERO or more leading
 *   segments, so `**​/__generated__/**` catches `__generated__/api.ts` as well
 *   as `src/__generated__/api.ts`
 * - `?` matches one non-`/` character
 *
 * Everything else is escaped, so a pattern is never accidentally a regex.
 */
function globToRegExp(pattern: string): RegExp {
  const cached = globCache.get(pattern);
  if (cached) return cached;
  let re = "";
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i]!;
    if (c === "*") {
      if (pattern[i + 1] === "*") {
        if (pattern[i + 2] === "/") {
          re += "(?:[^/]*/)*";
          i += 2;
        } else {
          re += ".*";
          i += 1;
        }
      } else {
        re += "[^/]*";
      }
    } else if (c === "?") {
      re += "[^/]";
    } else {
      re += c.replace(/[.+^${}()|[\]\\]/, "\\$&");
    }
  }
  const compiled = new RegExp(`^${re}$`);
  globCache.set(pattern, compiled);
  return compiled;
}

/**
 * Is this path DERIVED rather than authored, per `review.generatedPaths`?
 *
 * A pattern containing no `/` is matched against the BASENAME anywhere in the
 * tree — `pnpm-lock.yaml` means the lock file wherever it lives, which is what
 * an operator writing that line means, and a workspace monorepo has one per
 * package. A pattern with a `/` is matched against the whole path.
 */
export function isGeneratedPath(path: string, patterns: readonly string[]): boolean {
  const basename = path.slice(path.lastIndexOf("/") + 1);
  return patterns.some((p) => globToRegExp(p).test(p.includes("/") ? path : basename));
}

/**
 * Is this delta made ENTIRELY of generated files?
 *
 * `false` for an empty or absent list — the caller is asking "may I suppress a
 * review?", and "nothing changed as far as I can tell" is a degraded read, not
 * evidence. See `PrState.pathsSinceLastBotReview`.
 */
export function allPathsGenerated(
  paths: readonly string[] | null,
  patterns: readonly string[],
): boolean {
  if (!paths || paths.length === 0 || patterns.length === 0) return false;
  return paths.every((p) => isGeneratedPath(p, patterns));
}

/**
 * Does this delta contain at least one path a human WROTE?
 *
 * The mirror of {@link allPathsGenerated} rather than its negation: both answer
 * `false` for a `null` or empty delta, because both are asked by a caller
 * looking for permission to suppress something and neither may be granted it on
 * a degraded read.
 */
export function hasMaterialChange(
  paths: readonly string[] | null,
  patterns: readonly string[],
): boolean {
  if (!paths || paths.length === 0) return false;
  return paths.some((p) => !isGeneratedPath(p, patterns));
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
    lastBotReviewSha: state.lastBotReview?.sha ?? null,
    assessedHeadSha: state.assessedHeadShaByWorkflow["pr-review"] ?? null,
    pathsSinceLastBotReview: state.pathsSinceLastBotReview,
    generatedPaths: cfg.generatedPaths,
    runInFlight: state.runInFlight,
    route,
    explicitRequest: !!opts.explicitRequest,
  };

  // We could not read the PR at all — see `readDegradedDrop`. `skip`, not
  // `defer`: a deferral posts a placeholder check saying "not yet" against a
  // head SHA, and we do not reliably know the head SHA.
  const blind = readDegradedDrop<ReviewTriggerDecision>("skip", state, inputs);
  if (blind) return blind;

  // The PR-scoped run lock, before anything else — see `runLockDrop`. Above the
  // explicit-request branch on purpose: the lock is not policy but a physical
  // constraint (one workspace, one branch, one agent), so it is the one thing an
  // `@bot review` does NOT override. The dispatcher replies to the human whose
  // request it dropped; the 30-minute sweep is the re-pickup.
  const locked = runLockDrop<ReviewTriggerDecision>("skip", state, inputs);
  if (locked) return locked;

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

  if (state.botReviewAtHead) {
    return {
      decision: "skip",
      reason: `already-reviewed: we reviewed ${state.headSha.slice(0, 7)} (${state.botReviewAtHead.state})`,
      inputs,
    };
  }

  // A REVIEW RUN ALREADY HAPPENED AT THIS HEAD AND POSTED NOTHING.
  //
  // `botReviewAtHead` above is the only per-head dedup the review path had, and
  // it keys on a POSTED review — so any run that completes without posting one
  // leaves no trace the gate can see, and the 30-minute sweep re-dispatches it
  // at the same SHA forever. The sweep is the release mechanism for PRs no
  // webhook will ever fire for again, which is exactly what makes it an
  // unbounded loop rather than one wasted run.
  //
  // Found in production: `nearform` swept seven bot-authored PRs every 30
  // minutes for days. Each dispatched, ran the review agent, and had the agent
  // refuse to self-review at `post-review` — a refusal, a full sandbox, and no
  // review to remember it by. 1260 review executions, 0 posted, ~$1.30/hour.
  // Self-authorship is now filtered in discovery (`cron/review-discovery.ts`),
  // but that fixes one CAUSE; this fixes the loop, which any
  // ran-but-posted-nothing outcome reaches — an agent that errors out mid-review,
  // a phase that concludes there is nothing to say, a `post-review` that cannot
  // reach GitHub.
  //
  // `assessedHeadShaByWorkflow` is populated for every PR-scoped workflow from
  // SUCCEEDED runs only (`applyDerivedState`), which is what keeps this from
  // swallowing genuine retries: a run that CRASHED records nothing here and is
  // attempted again. It is deliberately distinct from `lastBotReview` — that
  // field is the generated-only gate's baseline and must be a review we really
  // posted (see its docstring); this one asks the different question "did a run
  // already look at this SHA".
  //
  // Placed BELOW the explicit-request branch, so `@bot review`, the request
  // label and the check's own Re-run button still force a fresh review — the
  // same rule the generated-only gate follows. `skip`, not `defer`: nothing
  // about this head will change, and the dispatching run already resolved its
  // own `last-light/review` check, so no placeholder is owed.
  const assessedSha = state.assessedHeadShaByWorkflow["pr-review"];
  if (assessedSha && state.headSha && assessedSha === state.headSha) {
    return {
      decision: "skip",
      reason: `already-assessed: a pr-review run already handled ${state.headSha.slice(0, 7)} without posting a review`,
      inputs,
    };
  }

  // NOTHING NEW TO SAY (issue #271). Per-head dedup above was the only
  // suppression gate, so every new head SHA earned a full formal review by
  // design — and a lock file re-derivation is a new head SHA.
  // nearform/skillspro#1641 got two byte-identical APPROVEs six minutes apart
  // for exactly that, at $0.44 a pair.
  //
  // Three properties make this safe to skip rather than defer:
  //
  // - It is BELOW the explicit-request branch, so `@bot review`, the request
  //   label and the check's Re-run button all still force a review. The gate
  //   answers "was this push worth an unprompted review?", never "may a human
  //   ask?".
  // - The baseline is the review we POSTED (`lastBotReview`), not the last head
  //   we ran at. A run that reviewed a SHA and then declined to post said
  //   nothing about it, so its changes stay in the next delta rather than being
  //   suppressed by a review that does not exist.
  // - The delta is authoritative-or-absent. `pathsSinceLastBotReview` is `null`
  //   whenever the read was degraded or truncated, and `allPathsGenerated`
  //   answers `false` for `null` and for an empty pattern list — so every
  //   uncertain case dispatches.
  //
  // `skip`, not `defer`: there is no future event that turns this same delta
  // into a review, which is exactly the distinction the two decisions carry.
  //
  // `lastBotReview` is checked here rather than assumed from a non-null delta:
  // the resolver only ever fills the two together, but this function is pure
  // over a snapshot anyone can construct — including a persisted one written
  // before this field existed — and the review it would name is the whole
  // justification for the skip.
  const prior = state.lastBotReview;
  if (prior && allPathsGenerated(state.pathsSinceLastBotReview, cfg.generatedPaths)) {
    const n = state.pathsSinceLastBotReview?.length ?? 0;
    return {
      decision: "skip",
      reason:
        `generated-only: the ${n} file${n === 1 ? "" : "s"} changed since we reviewed ` +
        `${prior.sha.slice(0, 7)} are all generated`,
      reviewUnchanged: { sha: prior.sha, state: prior.state },
      inputs,
    };
  }

  if (cfg.trigger === "after-checks") {
    // "On settle, EITHER COLOUR." The `passing` variant was deleted: a PR we
    // gave up on never goes green, so under `passing` the escalated PRs — the
    // ones most needing human eyes — would be the only ones with no review at
    // all. Either colour is also what lets the review cite the CI failure.
    //
    // THE SWEEP IS EXEMPT FROM THE PENDING DEFERRAL — the `route !== "sweep"`
    // below is the whole of that decision.
    //
    // `pending` used to defer on every route, the sweep included — and a check
    // run that never CONCLUDES is then deferred by every route, forever. That is not a hypothetical: a fork PR's `workflow_run`
    // awaiting maintainer approval, a dead self-hosted runner, or a third-party
    // app that opens a check and crashes all leave the aggregate `pending` with
    // no further `check_suite` ever coming. `check-prs-awaiting-review` calls
    // itself the RELEASE MECHANISM, and it was not one for this case; with
    // `review.postsCheck` on, the `queued` placeholder then sits there
    // permanently and a repo that made `last-light/review` required has an
    // unmergeable PR. This ships as the DEFAULT (`review.trigger:
    // after-checks`), so it is the packaged behaviour.
    //
    // The sweep cannot tell "CI is still running" from "this check will never
    // conclude" — nothing in the snapshot dates the pending state — so it must
    // choose which error to make. It dispatches: a review posted 30 minutes into
    // a still-running CI run costs TIMING (the review cannot cite a failure that
    // has not happened yet, and the next push re-arms `botReviewAtHead`
    // anyway), while a PR that is never reviewed and possibly never mergeable
    // costs CORRECTNESS. `after-checks` is "on settle, either colour" — the
    // COLOUR was never the gate, and on the one route that exists precisely to
    // pick up what no webhook will ever fire for, neither is settling.
    if (state.checksState === "pending" && route !== "sweep") {
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
 * REQUEST — "we already escalated at this head" and "we already assessed this
 * exact head" — so those are restated here rather than inherited. "A human told
 * us to stay out" is no longer one of them: that is the HOLD, resolved once for
 * every workflow in {@link resolveDispatchDisposition} above all three of these.
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
    escalatedAtSha: state.escalatedAtSha,
    runInFlight: state.runInFlight,
    explicitRequest: !!opts.explicitRequest,
  };

  // We could not read the PR at all — see `readDegradedDrop`. It matters most
  // on this route: `mergeable_state`, the labels and the fork flag all come
  // from that read, and enabling auto-merge on a pull request we cannot see is
  // the one irreversible thing this codebase does.
  const blind = readDegradedDrop<FixDisposition>("skip", state, inputs);
  if (blind) return blind;

  // The PR-scoped run lock, before anything else — see `runLockDrop`. This is
  // the branch that stops `merge-green-dependency-prs` enabling auto-merge
  // against a PR whose fix run is still in flight: the fix pushes, CI goes
  // green while the run is still writing its comment and marker, and the merge
  // route then acts on a tree that is still being rewritten.
  const locked = runLockDrop<FixDisposition>("skip", state, inputs);
  if (locked) return locked;

  // Still binding only while the head is the one we escalated at. NOTE the
  // missing `|| state.headIsOurs` that `resolveFixDisposition` carries: on the
  // fix route our own commit on top of an escalation is another attempt at the
  // same problem, but on THIS route it is the RESOLUTION. The whole
  // `dependabot-ci-fix` → `pr.checks_passed` → `dependabot-pr-merge` handoff
  // ends with our fix commit at the head, so including it made the handoff
  // structurally unreachable for every PR we had ever escalated: we fixed it,
  // CI went green, and the merge route skipped *because* we were the one who
  // fixed it. 27 of 37 green dependency PRs were stuck behind this.
  //
  // Dropping it does not unbound the route. A merge run that assesses this head
  // and declines still records a run row, which re-stamps `escalatedAtSha` at
  // the current head — so the comparison below catches the very next dispatch —
  // and a run that succeeds populates `assessedHeadShaByWorkflow`, so the
  // `already-assessed` guard underneath bounds it to ONE assessment per head
  // SHA either way. That is the same bound every never-escalated PR already
  // lives under.
  if (state.escalatedAtSha !== null && !opts.explicitRequest) {
    if (state.headSha === state.escalatedAtSha) {
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
  /**
   * The HOLD label (`hold.label`), operator-configurable — see
   * {@link holdDrop}. NOT repo-clamped like the three blocks above and
   * deliberately not in `repoConfig.allowKeys`: it is a label name, not a
   * budget, and there is no "more conservative" direction to clamp it toward.
   *
   * Optional so every existing construction of this type still compiles and so
   * a caller reaching the resolver directly (the evals harness, a table test)
   * gets the packaged default rather than a silently disabled hold. Pass an
   * empty string to turn the branch off entirely.
   */
  holdLabel?: string;
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
 *
 * The PR-scoped run lock is enforced inside each of the three, not here: the
 * lock's span (`prScopedWorkflows()`) is exactly the union of the three
 * branches, so the `ungated` fallback below is unreachable for a workflow the
 * lock covers — and a caller that reaches one of the dispositions directly
 * (`pr-escalation.ts`'s tests, the evals harness) gets the same answer as one
 * that comes through here. See {@link runLockDrop}.
 *
 * The HOLD is the one guard that lives HERE rather than inside the three, and
 * for the mirror-image reason: it is not a verdict about a fix, a merge or a
 * review, it is an instruction about the SUBJECT, so it must read identically
 * whichever branch would have answered — including the `ungated` fallback, which
 * is how a workflow nobody has classified yet still honours it. See
 * {@link holdDrop} for why it sits above everything except the degraded read.
 */
export function resolveDispatchDisposition(
  workflowName: string,
  state: PrState,
  cfg: PrPolicyConfig,
  opts: DispatchDispositionOptions = {},
): Decision<FixDisposition> {
  // The HOLD, above every other guard except the degraded read.
  //
  // The `readDegradedDrop` probe below is a QUESTION, not the answer: when the
  // PR read failed we fall through untouched, so the per-workflow disposition
  // produces the degraded drop itself — with its own `inputs` and, for
  // `pr-review`, the `review` verdict the check-run placement needs. Deciding it
  // twice here would flatten that.
  const holdInputs = {
    workflowName,
    labels: state.labels,
    explicitRequest: !!opts.explicitRequest,
  };
  if (!readDegradedDrop<FixDisposition>("skip", state, holdInputs)) {
    const held = holdDrop<FixDisposition>(
      "skip",
      state,
      cfg.holdLabel ?? HOLD_LABEL,
      holdInputs,
    );
    if (held) return held;
  }

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
      // Carried through the collapse: a review dropped by the run lock is the
      // same kind of "come back later" as a fix dropped by it, and the caller
      // owes the same reply to whoever asked. `readDegraded` rides along for
      // the same reason and one more — it is what stops the caller posting a
      // placeholder check against a head SHA we could not read.
      ...(review.runInFlight ? { runInFlight: review.runInFlight } : {}),
      ...(review.readDegraded ? { readDegraded: true as const } : {}),
      // Same rule again: the check projection needs the finer verdict, and the
      // collapse to run/skip is exactly what would lose it.
      ...(review.reviewUnchanged ? { reviewUnchanged: review.reviewUnchanged } : {}),
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
    // The BRANCHABLE half of the same fact, and not simply the negation of the
    // line above: `ciLogsAvailable` is false both when the log download failed
    // AND when there is no CI report at all (nothing failing, nothing to
    // fetch). A prompt branching on the negation would warn "the harness could
    // not download the job logs" on a perfectly green PR. This is true only
    // when we HAVE a report and its logs are missing — which is the case
    // `skills/fixing/SKILL.md` tells the agent to name in its verdict, using a
    // fact it was never handed until now (#256). The cause is already spoken by
    // `renderCiFailureReport`'s banner inside `{{ciSection}}`, so it is not
    // duplicated here.
    ciLogsUnavailable: !!state.ciReport && !state.ciReport.logsAvailable,

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
    // Where the agent appends a new note, and where it writes the push gate.
    // Template variables rather than literals in each prompt so both placements
    // stay resolvable in ONE place; both are bare relative paths because the
    // agent's cwd is the checkout on every backend, and both sit under `.git/`
    // so no `git add -A` can commit them (see `engine/executors/shared.ts`).
    // `until_bash` still carries the gate path as a literal — the engine's
    // `validateShellCommand` rejects any command containing `{{` — and
    // `tests/workflows/pr-fix.test.ts` pins that literal to this constant.
    notesFile: PR_NOTES_FILE_NAME,
    verifyScript: VERIFY_SCRIPT_NAME,

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
