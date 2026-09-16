/**
 * The BUILD trigger decision — the issue-side equivalent of the PR dispatch
 * gate in `./pr-decisions.ts`.
 *
 * An issue labelled `ready-for-agent` dispatches a gated `build` workflow, and
 * the label can be applied from three places that share nothing else: a webhook
 * (a human, OR our own triage bot), the backstop cron sweep, and `/api/run`.
 * Three surfaces, one policy — so the policy is a PURE function every one of
 * them crosses, rather than three enforcement points free to disagree. That is
 * the same split `resolveReviewTrigger` makes (DISCOVERY vs POLICY): the sweep
 * finds candidates and knows nothing about autonomy, holds or idempotency,
 * while this function decides.
 *
 * It returns **`{ decision, reason, inputs }`**, never a bare enum, for the
 * reason the module header of `pr-decisions.ts` gives: the reason string is
 * rendered in three places — the log line, the issue comment and the dashboard
 * run panel — so there is ONE source and three renderings rather than three
 * prose variants that drift. The reason is written `"<case>: <explanation>"` so
 * the case stays greppable without a parallel enum to keep in sync, and
 * `inputs` records every field the decision read so the panel can show WHY
 * without re-deriving anything.
 *
 * Purity is the point: the whole of this module's verification is a table test
 * over literal input records — no GitHub mock, no sandbox, no harness. Nothing
 * here logs; the CALLER logs the decision, exactly as the dispatch sites do for
 * `resolveReviewTrigger`.
 */

import type { AutonomyBudgetConfig } from "../config/config.js";
import type { Decision } from "./pr-decisions.js";

/**
 * Run the gated build, or don't.
 *
 * Two-valued, deliberately — unlike `ReviewTriggerDecision`, there is no
 * `defer` here. `defer` exists on the review path because a deferral posts a
 * placeholder `last-light/review` check that says "not yet, ask me"; a build has
 * no such projection, so a "come back later" and a "no" are the same answer to
 * the only question the caller asks. The DISTINCTION is preserved in the reason
 * prose instead (`run-in-flight:` is transient, `not-autonomous:` is not), which
 * is what the comment and the panel render.
 */
export type BuildTriggerDecision = "dispatch" | "skip";

/** Everything the build gate reads. Resolved once by the caller, per dispatch. */
export interface BuildTriggerInputs {
  /** `"owner/repo"`. */
  repo: string;
  issueNumber: number;
  /** The issue's CURRENT labels — the hold check reads this, not `addedLabel`. */
  labels: readonly string[];
  /** The label whose application triggered this, when one did (the `labeled` route). */
  addedLabel?: string;
  /** Which surface this dispatch arrived on. */
  route: "labeled" | "sweep" | "api";
  /** Did OUR bot apply the label (vs a human)? Drives the already-built asymmetry. */
  senderIsBot: boolean;
  /** Is this repo on the operator's autonomy allow-list? */
  autonomyEnabled: boolean;
  /** `db.runs.hasRunForTrigger(triggerId, "build")` — the idempotency key. */
  alreadyBuilt: boolean;
  /** A live (queued/running/paused) run exists for this trigger. */
  runInFlight: boolean;
  holdLabel: string;

  // ── The budget inputs (Phase 2) ────────────────────────────────────────
  //
  // Counts and sums, never limits: the CEILINGS arrive separately as
  // `budget`, so this record stays "what is true right now" and the operator's
  // configuration stays one argument you can vary in a table test without
  // rewriting the world around it.
  //
  // All three day-scoped fields are measured over the **UTC day**, and the
  // reasons below say so. Any other boundary would be a per-deployment
  // surprise; UTC is what `dailyStats`/`dayBucket` already bucket on, so this
  // is the existing convention rather than a new one.

  /** Autonomous build runs in flight right now, HARNESS-WIDE (every repo). */
  concurrentAutonomousBuilds: number;
  /** Build runs started for THIS repo so far today (UTC). */
  buildsForRepoToday: number;
  /** Harness-wide model spend so far today (UTC), in USD. */
  spendTodayUsd: number;
  /** This repo's share of that spend, in USD. */
  repoSpendTodayUsd: number;
}

/**
 * The universal subject key: `owner/repo#N`. Matches what
 * `workflow_runs.triggerId` stores.
 *
 * Verified byte-for-byte against the two places that already mint it —
 * `src/workflows/simple.ts` (`${owner}/${repo}#${number}`, the id every
 * issue/PR-scoped run is recorded under) and the router's re-triage branch
 * (`${envelope.repo}#${envelope.issueNumber}`, where `envelope.repo` is already
 * `owner/repo`). It has to match exactly: `alreadyBuilt` is a lookup on this
 * string, so a single character of drift means the idempotency key silently
 * never matches and the loop this gate exists to stop runs forever.
 */
export function issueTriggerId(repo: string, issueNumber: number): string {
  return `${repo}#${issueNumber}`;
}

/**
 * One resolver, every route.
 *
 * The branch ORDER below is the design, not an accident of how it was written.
 * Each branch sits where it does because of what outranks it, and the reasons
 * are recorded inline.
 */
export function resolveBuildTrigger(
  inputs: BuildTriggerInputs,
  budget: AutonomyBudgetConfig,
): Decision<BuildTriggerDecision> {
  // The full input record travels on EVERY returned decision — the same rule
  // `resolveReviewTrigger` follows. A decision whose justification you cannot
  // reconstruct is a decision you cannot debug six weeks later, and the panel
  // must never re-derive a field the gate already read.
  const record: Record<string, unknown> = {
    repo: inputs.repo,
    issueNumber: inputs.issueNumber,
    labels: [...inputs.labels],
    addedLabel: inputs.addedLabel ?? null,
    route: inputs.route,
    senderIsBot: inputs.senderIsBot,
    autonomyEnabled: inputs.autonomyEnabled,
    alreadyBuilt: inputs.alreadyBuilt,
    runInFlight: inputs.runInFlight,
    holdLabel: inputs.holdLabel,
    concurrentAutonomousBuilds: inputs.concurrentAutonomousBuilds,
    buildsForRepoToday: inputs.buildsForRepoToday,
    spendTodayUsd: inputs.spendTodayUsd,
    repoSpendTodayUsd: inputs.repoSpendTodayUsd,
    // The CEILINGS travel too, not just the readings. A panel showing "3 builds
    // today" cannot tell you whether that was refused without knowing the limit
    // it was measured against, and re-reading the config later answers a
    // different question: what the limit is NOW, not what it was when we
    // decided.
    budget: { ...budget },
  };

  const triggerId = issueTriggerId(inputs.repo, inputs.issueNumber);

  // ── 1. THE HOLD LABEL ────────────────────────────────────────────────────
  //
  // Top of the order, above even the autonomy check, because a hold is the one
  // instruction that means "you, the bot, are off this subject entirely" — it
  // cannot be outranked by a verdict about anything else without ceasing to
  // mean that.
  //
  // Belt-and-braces: the router already refuses a held subject, so on the
  // `labeled` route this branch is unreachable. It is NOT unreachable on the
  // sweep route, which never crosses the router at all — the cron reads issues
  // straight out of GitHub and calls the dispatch choke point. A guard that
  // lives only in the router is a guard only one of our three routes obeys,
  // which is exactly the failure `resolveReviewTrigger`'s run-lock header
  // records.
  //
  // SILENT. No comment, no label, no escalation: a hold is an instruction we are
  // obeying, not a verdict about the issue, and there is nothing to tell anybody
  // that the label already on the issue does not say. It carries `onHold` for
  // the same reason the PR side does — the one thing a caller may do with this
  // is NAME the label to a human who asked, and the name is
  // operator-configurable, so it cannot be a literal at the call site.
  if (inputs.labels.includes(inputs.holdLabel)) {
    return {
      decision: "skip",
      reason: `on-hold: \`${inputs.holdLabel}\` is applied to ${triggerId}`,
      inputs: record,
      onHold: { label: inputs.holdLabel },
    };
  }

  // ── 2. AUTONOMY ──────────────────────────────────────────────────────────
  //
  // Below the hold and above everything else. This is the operator's master
  // switch for "may this repo have work done on it unattended", so it must
  // outrank every question about THIS issue — there is no state an individual
  // issue can be in that earns it an autonomous build on a repo the operator
  // never opted in.
  //
  // It sits below the hold only because the hold is the more specific
  // instruction and produces the more useful message: telling somebody who just
  // applied a hold that the repo is not autonomous answers a question they did
  // not ask.
  if (!inputs.autonomyEnabled) {
    return {
      decision: "skip",
      reason: `not-autonomous: ${inputs.repo} is not on the autonomy allow-list, so a labelled issue does not dispatch a build`,
      inputs: record,
    };
  }

  // ── 3. ALREADY BUILT — the idempotency key, and the one deliberate asymmetry ─
  //
  // `alreadyBuilt` is `hasRunForTrigger(triggerId, "build")`: we have run a
  // build for this issue before. What that FACT means depends entirely on who
  // re-applied the label, and the two answers are opposite.
  //
  // BOT → HARD SKIP. This is the guard that stops a label loop. Our own triage
  // workflow applies `ready-for-agent`; a build can re-triage, or a failure can
  // route back through triage, and the label goes on again. Each cycle would
  // dispatch a full build. Nothing in that loop involves a human deciding
  // anything, so an automated re-label can NEVER re-spend — there is no amount
  // of machine confidence that turns a repeat into a new instruction.
  //
  // HUMAN → FALL THROUGH AND DISPATCH. A maintainer re-applying
  // `ready-for-agent` to an issue whose build failed or got blocked is an
  // explicit retry instruction, and the only reading of it that makes sense.
  // Refusing would leave every failed build with no restart path except the CLI,
  // which is the same dead end `pr-escalation.ts` exists to avoid on the PR
  // side: a subject that is stuck, with nothing on it explaining how to unstick
  // it, is strictly worse than one that is merely wrong.
  //
  // This mirrors `resolveReviewTrigger`'s explicit-request branch verbatim in
  // its reasoning — there, `@bot review` sits ABOVE the per-head dedup because a
  // human's ask outranks a dedup that exists to stop MACHINES looping. Same
  // shape here: the dedup is aimed at the bot, so it binds the bot.
  //
  // THE RISK WE ARE ACCEPTING, named: a maintainer can re-label the same issue
  // repeatedly and buy a full build each time, and nothing in this function
  // bounds that spend. That is deliberate — an explicit human instruction is not
  // a loop — but it does mean the cost ceiling for this path is a person, not a
  // counter. The Phase 2 budget branches below are where that gets a number.
  const humanRetry = inputs.alreadyBuilt && !inputs.senderIsBot;
  if (inputs.alreadyBuilt && inputs.senderIsBot) {
    return {
      decision: "skip",
      reason: `already-built: a build run already exists for ${triggerId} and the label was re-applied by us, not by a human`,
      inputs: record,
    };
  }

  // ── 4. A RUN IS ALREADY IN FLIGHT ────────────────────────────────────────
  //
  // Below the human retry on purpose: a retry instruction is still refused while
  // a run is live, because this is not a policy question. Two builds on one
  // issue means two agents cloning and pushing the same branch, which is a
  // physical constraint no instruction can override — the same reason the
  // PR-scoped run lock sits above `resolveReviewTrigger`'s explicit-request
  // branch.
  //
  // A "come back later", NOT a verdict. Nothing is wrong with the issue and
  // nothing about this answer is terminal; the work simply cannot start while
  // another run owns it. Dropping rather than queueing is only sound because the
  // backstop sweep is the re-pickup — it is the release mechanism for every
  // issue dropped here, since the label is already applied and no further
  // `labeled` webhook will ever fire for it. A future phase that converts
  // drop-on-lock into queue-on-lock must land before that sweep is removed.
  if (inputs.runInFlight) {
    return {
      decision: "skip",
      reason: `run-in-flight: a build run for ${triggerId} is already queued, running or paused`,
      inputs: record,
    };
  }

  // ── 5. THE BUDGET CEILINGS ───────────────────────────────────────────────
  //
  // Three branches, all below every correctness gate above (a build we must not
  // run AT ALL is never a budget question) and all above the dispatch below (a
  // build we may run is still subject to a ceiling).
  //
  // ## Why they need no new decision value
  //
  // Every one of them is a "come back later", exactly like `run-in-flight`:
  // nothing is wrong with the issue, and nothing about the answer is a verdict
  // on it. Concurrency frees itself when another run finishes; both day-scoped
  // ceilings free themselves at UTC midnight. The release mechanism is the same
  // one `run-in-flight` already depends on — the Phase 4 backstop sweep — so
  // adding a third decision value would buy a distinction no caller could act
  // on. The distinction that DOES matter is in the consequence, and that is the
  // caller's business, not this function's: `build-gate.ts` logs the first,
  // records an activity row for the second, and comments once for the third.
  //
  // ## Why this order
  //
  // Cheapest and most transient first. When several ceilings are true at once
  // the one worth reporting is the one that will clear soonest, because that is
  // the one a human reading the reason can wait out — telling somebody their
  // repo is out of budget for the day when the true answer is "two builds are
  // running, try in ten minutes" is a worse answer, and it is the one that
  // would trigger a comment and a label that then have to be undone.
  //
  // ## `>=`, and why a configured `0` has to work
  //
  // The limit is the number of builds (or dollars) ALLOWED, so a repo that has
  // had its three has had its three — `>` would silently grant one more than
  // the operator asked for at every ceiling. It is also what makes a configured
  // `0` mean "refuse everything", which is the only reading of it that makes
  // sense and the one an operator reaches for to stop the pipeline dead without
  // un-configuring it. `normalizeAutonomyBudget` deliberately keeps a `0` as a
  // real setting (only a negative or non-numeric value falls back to the
  // packaged default), so a `0` that arrived here is one somebody meant.

  // 5a. CONCURRENCY — harness-wide, and the one that clears by itself soonest.
  //
  // Counted across every repo, not per-repo: the constraint is this
  // deployment's capacity to have agents running at once, which a second repo
  // consumes exactly as much as the first. Autonomous runs only — a build a
  // human asked for by comment is not spending the unattended budget and must
  // not be refused by it.
  if (inputs.concurrentAutonomousBuilds >= budget.maxConcurrentBuilds) {
    return {
      decision: "skip",
      reason: `concurrency-exhausted: ${inputs.concurrentAutonomousBuilds} autonomous build run(s) are already in flight, at the harness ceiling of ${budget.maxConcurrentBuilds}`,
      inputs: record,
    };
  }

  // 5b. THE PER-REPO DAY QUOTA — the blast-radius bound.
  //
  // This is guard 4 of the four-guard loop-safety argument, and the one that
  // bounds the damage if guards 1-3 all fail: however badly the label logic
  // misbehaves, one repo buys at most N builds a day. It counts runs STARTED,
  // in every status, because a build that failed still spent the money — a
  // repo whose builds keep crashing is precisely the case where an unbounded
  // retry loop is most expensive.
  if (inputs.buildsForRepoToday >= budget.maxBuildsPerRepoPerDay) {
    return {
      decision: "skip",
      reason: `repo-quota-exhausted: ${inputs.repo} has started ${inputs.buildsForRepoToday} build run(s) today, at its daily ceiling of ${budget.maxBuildsPerRepoPerDay} — it resets at midnight UTC`,
      inputs: record,
    };
  }

  // 5c. SPEND — the last ceiling, and the only one owed a human an explanation.
  //
  // Two ceilings in one branch because they answer the same question ("is there
  // money for this today?") and produce the same consequence. The HARNESS
  // ceiling is checked first when both are blown: it is the broader fact, and
  // the more useful one to put in front of somebody — a repo told it is over
  // its own limit would go and raise that limit to no effect.
  //
  // It carries `budgetExhausted` so the caller can key on a TYPED field rather
  // than on this sentence. That matters more here than anywhere else in this
  // function, because this is the one skip with a terminal-for-today
  // consequence — a label and a comment — and a consequence gated on prose
  // stops firing the day somebody rewords the prose.
  const harnessOverspent = inputs.spendTodayUsd >= budget.dailyUsd;
  const repoOverspent = inputs.repoSpendTodayUsd >= budget.repoDailyUsd;
  if (harnessOverspent || repoOverspent) {
    const scope = harnessOverspent ? "harness" : "repo";
    const limitUsd = harnessOverspent ? budget.dailyUsd : budget.repoDailyUsd;
    const spentUsd = harnessOverspent ? inputs.spendTodayUsd : inputs.repoSpendTodayUsd;
    const subject = harnessOverspent ? "this deployment" : inputs.repo;
    return {
      decision: "skip",
      reason: `budget-exhausted: ${subject} has spent $${spentUsd.toFixed(2)} of its $${limitUsd.toFixed(2)} daily model budget — it resets at midnight UTC`,
      inputs: record,
      budgetExhausted: { scope, limitUsd, spentUsd },
    };
  }

  // ── 6. DISPATCH ──────────────────────────────────────────────────────────
  //
  // Two reasons, not one: the clean first build and the human retry reach the
  // same decision by different arguments, and the reason string is the record of
  // WHICH — so a re-spend that should never have happened is greppable after the
  // fact instead of indistinguishable from a first run.
  return {
    decision: "dispatch",
    reason: humanRetry
      ? `retry: a maintainer re-applied \`${inputs.addedLabel ?? "the build label"}\` to ${triggerId}, which already has a build run — treating it as an explicit retry`
      : `ready: ${triggerId} is labelled for the agent and nothing blocks the build`,
    inputs: record,
  };
}
