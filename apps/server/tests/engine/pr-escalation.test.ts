/**
 * Escalation — what a terminal skip does to the pull request, and (the part
 * that is easy to get wrong) what it does to OUR OWN STATE.
 *
 * These run against a real in-memory `StateDb`, because the property under test
 * is a SEQUENCE across dispatches through the actual transport: escalate →
 * `createRun`/`finishRun` → `latestForTrigger` → `applyDerivedState` →
 * `resolveFixDisposition`. Faking the store would fake exactly the link that
 * carries the defect — a row-less escalation persists no `escalatedAtSha`, and
 * the next dispatch then reads our own escalation as a HUMAN's permanent
 * override (09 → D1). The anti-latch test at the bottom is the one that fails
 * if that link is ever broken.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { StateDb } from "#src/state/db.js";
import type { GitHubClient } from "#src/engine/github/github.js";
import { applyDerivedState, prTriggerId, type PrState } from "#src/engine/pr-state.js";
import { resolveFixDisposition } from "#src/engine/pr-decisions.js";
import { escalatePr, noticeForkPr, renderEscalationComment } from "#src/engine/pr-escalation.js";
import { REQUIRES_HUMAN_LABEL } from "#src/cron/dependabot-discovery.js";
import { defaultFixConfig } from "lastlight-shared/config-types";

const BOT = "last-light[bot]";
const REPO = "cliftonc/lastlight";
const PR = 190;
const TRIGGER = prTriggerId(REPO, PR);
const WORKFLOW = "dependabot-ci-fix";
const fix = defaultFixConfig();

/** An ordinary same-repo dependency PR with a red build. Override per case. */
function liveState(over: Partial<PrState> = {}): PrState {
  return {
    repo: REPO,
    prNumber: PR,
    headSha: "aaaa111bbbb222",
    headAuthor: "dependabot[bot]",
    headIsOurs: false,
    headRef: "dependabot/npm/lodash-4.17.21",
    baseRef: "main",
    isDraft: false,
    isFork: false,
    headRepoFullName: REPO,
    labels: [],
    title: "Bump lodash from 4.17.20 to 4.17.21",
    body: "",
    checksState: "failing",
    settledCheckCount: 3,
    baseChecksState: "passing",
    botReviewAtHead: null,
    ciReport: null,
    attempt: 1,
    flakyDeferrals: 0,
    escalatedAtSha: null,
    escalatedBy: null,
    forkNoticedAtSha: null,
    priorAttempts: [],
    notes: [],
    priorDiagnosisClass: null,
    cumulativeCostUsd: 0,
    costBaselineUsd: 0,
    assessedHeadShaByWorkflow: {},
    runInFlight: null,
    readErrors: [],
    ...over,
  };
}

/**
 * A GitHub stand-in that REMEMBERS the labels it applied, so the next
 * dispatch's snapshot can carry them exactly as a live read would. The
 * escalation guard only binds when the label is actually on the PR, which is
 * the whole reason the label write and the run row are ordered the way they are.
 */
function fakeGithub(over: { addLabels?: () => Promise<void> } = {}) {
  const labels = new Set<string>();
  const addLabels = vi.fn(async (_o: string, _r: string, _n: number, names: string[]) => {
    if (over.addLabels) await over.addLabels();
    for (const l of names) labels.add(l);
  });
  const postComment = vi.fn(async () => 1);
  return { labels, addLabels, postComment } as unknown as GitHubClient & {
    labels: Set<string>;
    addLabels: ReturnType<typeof vi.fn>;
    postComment: ReturnType<typeof vi.fn>;
  };
}

let db: StateDb;
beforeEach(() => {
  db = new StateDb(":memory:");
});

/**
 * Record a finished fix run the way a real one leaves the table: the snapshot
 * it dispatched on in `context.prState`, its harvested markers in
 * `scratch.fixMarkers`. `startedAt` is pinned in the past so the escalation
 * row (stamped `now`) is unambiguously the most recent.
 */
function recordFixRun(opts: {
  n: number;
  attempt: number;
  headSha: string;
  diagnosisClass?: string;
  cause?: string;
}): void {
  const id = `run-${opts.n}`;
  db.runs.createRun({
    id,
    workflowName: WORKFLOW,
    triggerId: TRIGGER,
    owner: "cliftonc",
    repo: "lastlight",
    issueNumber: PR,
    currentPhase: "fix",
    status: "succeeded",
    context: { prState: liveState({ attempt: opts.attempt, headSha: opts.headSha }) },
    startedAt: `2020-01-01T00:00:0${opts.n}.000Z`,
  });
  if (opts.diagnosisClass) {
    db.runs.mergeScratch(id, {
      fixMarkers: {
        diagnosis: {
          class: opts.diagnosisClass,
          cause: opts.cause ?? "the lockfile is stale",
          rawClass: opts.diagnosisClass,
          pr: PR,
          attempt: opts.attempt,
          ciVsLocal: "",
          unreproducible: [],
        },
        fix: null,
        phases: ["diagnose"],
        at: "2020-01-01T00:00:00.000Z",
      },
    });
  }
}

/** Resolve the snapshot a fresh dispatch would see, with the live labels. */
function snapshot(github: { labels: Set<string> }, over: Partial<PrState> = {}): PrState {
  const state = liveState({ labels: [...github.labels], ...over });
  applyDerivedState(state, { github: null, db, botLogin: BOT });
  return state;
}

/** One dispatch: decide, then apply whatever the decision entails. */
async function dispatchOnce(github: ReturnType<typeof fakeGithub>, state: PrState) {
  const decision = resolveFixDisposition(state, fix, { dedupOnHeadSha: true });
  const outcome =
    decision.decision === "skip"
      ? await escalatePr(WORKFLOW, state, decision, fix, { db, github })
      : null;
  return { decision, outcome };
}

describe("escalatePr — the three escalating skips", () => {
  const cases: Array<[string, Partial<PrState>, string, RegExp]> = [
    [
      "attempts exhausted",
      { attempt: 4, priorAttempts: ["attempt 3: class=reproducible cause=stale lockfile"] },
      "attempts-exhausted",
      /attempt 4 exceeds fix\.maxAttempts 3/,
    ],
    [
      "the cumulative cost cap",
      { cumulativeCostUsd: 5.4, attempt: 2 },
      "budget-exhausted",
      /\$5\.40 spent/,
    ],
    [
      // The ONE prior-run verdict allowed to gate dispatch — allowed only
      // because this path writes a row (09 → D1's general rule).
      "a diagnosis no further attempt can fix",
      { attempt: 2, priorDiagnosisClass: "infra-dependent" },
      "not-retryable",
      /diagnosed `infra-dependent`/,
    ],
  ];

  it.each(cases)("%s applies the label and ONE comment", async (_name, over, kase, reason) => {
    const github = fakeGithub();
    const state = liveState(over);

    const { decision, outcome } = await dispatchOnce(github, state);

    expect(decision.decision).toBe("skip");
    expect(decision.reason).toMatch(reason);
    expect(decision.escalation).toBe(kase);
    expect(outcome).toMatchObject({ case: kase, labelled: true, commented: true });
    expect(github.addLabels).toHaveBeenCalledTimes(1);
    expect(github.addLabels).toHaveBeenCalledWith("cliftonc", "lastlight", PR, [
      REQUIRES_HUMAN_LABEL,
    ]);
    expect(github.postComment).toHaveBeenCalledTimes(1);
  });

  it("records a SUCCEEDED run row carrying the escalation SHA", async () => {
    // `succeeded`, not `failed`: 09 → S1 reserves `failed` for malfunction, and
    // `failed` would post `messages.on_failure`, offer an impossible Retry and
    // pollute the cost/failure stats.
    const github = fakeGithub();
    const state = liveState({ attempt: 4 });
    const { outcome } = await dispatchOnce(github, state);

    const row = db.runs.getRun(outcome!.runId)!;
    expect(row.status).toBe("succeeded");
    expect(row.workflowName).toBe(WORKFLOW);
    expect(row.triggerId).toBe(TRIGGER);
    expect(row.finishedAt).toBeTruthy();
    expect(row.phaseHistory.map((p) => p.phase)).toEqual(["escalated"]);
    const recorded = (row.context as any).prState as PrState;
    expect(recorded.escalatedAtSha).toBe(state.headSha);
    expect(recorded.escalatedBy).toBe("us");
    expect((row.context as any).escalation).toMatchObject({ case: "attempts-exhausted" });
  });
});

describe("escalatePr — the skips that must stay silent", () => {
  it("`upstream-broken` applies nothing — it is not this PR's fault", async () => {
    // 09 → D1 is explicit: skip WITHOUT labelling. It self-heals the moment the
    // base goes green, and it is a live precondition, so no row is needed to
    // un-stick it either.
    const github = fakeGithub();
    const { decision, outcome } = await dispatchOnce(
      github,
      liveState({ baseChecksState: "failing", attempt: 4 }),
    );

    expect(decision.reason).toMatch(/^upstream-broken:/);
    expect(decision.escalation).toBeUndefined();
    expect(outcome).toBeNull();
    expect(github.addLabels).not.toHaveBeenCalled();
    expect(github.postComment).not.toHaveBeenCalled();
    expect(db.runs.latestForTrigger([WORKFLOW], TRIGGER)).toBeNull();
  });

  it("a fork PR applies nothing — there is nothing wrong with the change", async () => {
    const github = fakeGithub();
    const { decision, outcome } = await dispatchOnce(
      github,
      liveState({ isFork: true, headRepoFullName: "octocat/lastlight", attempt: 4 }),
    );

    expect(decision.reason).toMatch(/^fork-pr:/);
    expect(decision.escalation).toBeUndefined();
    expect(outcome).toBeNull();
    expect(github.addLabels).not.toHaveBeenCalled();
    expect(db.runs.latestForTrigger([WORKFLOW], TRIGGER)).toBeNull();
  });

  it("a `flaky` verdict is a deferral, not an escalation", async () => {
    // `flaky` and `upstream-broken` are exactly the classes that cost no
    // attempt, and for the same reason they must not escalate: one is bounded
    // by `fix.maxFlakyDeferrals`, the other is about someone else's branch.
    const github = fakeGithub();
    const { decision } = await dispatchOnce(
      github,
      liveState({ attempt: 2, priorDiagnosisClass: "flaky" }),
    );
    expect(decision.decision).toBe("run");
    expect(github.addLabels).not.toHaveBeenCalled();
  });

  it("an unknown head SHA never escalates — recording `\"\"` would latch the PR", async () => {
    // A falsy `escalatedAtSha` reads back as "no escalating run of ours", which
    // `applyDerivedState` resolves to `escalatedBy: \"human\"` — a PERMANENT
    // override applied by mistake. Refuse instead; the next event re-resolves.
    const github = fakeGithub();
    const { outcome } = await dispatchOnce(github, liveState({ headSha: "", attempt: 4 }));
    expect(outcome).toBeNull();
    expect(github.addLabels).not.toHaveBeenCalled();
    expect(db.runs.latestForTrigger([WORKFLOW], TRIGGER)).toBeNull();
  });
});

describe("escalatePr — once, and only once", () => {
  it("a second dispatch at the same head applies nothing and skips as our own escalation", async () => {
    const github = fakeGithub();
    recordFixRun({ n: 1, attempt: 3, headSha: "aaaa111bbbb222", diagnosisClass: "reproducible" });

    const first = await dispatchOnce(github, snapshot(github));
    expect(first.decision.escalation).toBe("attempts-exhausted");
    expect(github.labels.has(REQUIRES_HUMAN_LABEL)).toBe(true);

    // Same head, next event — a re-fired check suite, or the daily cron.
    const second = snapshot(github);
    expect(second.escalatedBy).toBe("us");
    expect(second.escalatedAtSha).toBe("aaaa111bbbb222");
    const out = await dispatchOnce(github, second);
    expect(out.decision.reason).toMatch(/^escalated: we escalated this PR at aaaa111/);
    expect(out.decision.escalation).toBeUndefined();
    expect(out.outcome).toBeNull();

    // Exactly one of each, across both dispatches. The de-dup is the persisted
    // record — neither `addLabels` nor `postComment` de-duplicates.
    expect(github.addLabels).toHaveBeenCalledTimes(1);
    expect(github.postComment).toHaveBeenCalledTimes(1);
  });

  it("a commit WE authored on top of the escalation is not intervention", async () => {
    const github = fakeGithub();
    recordFixRun({ n: 1, attempt: 3, headSha: "aaaa111bbbb222", diagnosisClass: "reproducible" });
    await dispatchOnce(github, snapshot(github));

    const ours = snapshot(github, { headSha: "cccc333", headAuthor: BOT, headIsOurs: true });
    const out = await dispatchOnce(github, ours);
    expect(out.decision.reason).toMatch(/^escalated:/);
    expect(github.postComment).toHaveBeenCalledTimes(1);
  });

  it("a label write that fails posts no comment, and the next event retries", async () => {
    // The row is written FIRST on purpose. Row-then-crash leaves an escalation
    // with no label: the guard reads `escalatedBy: null`, so the next event
    // simply escalates again. The reverse order would leave a label with no
    // record — which is the "a human applied it" misclassification, and it is
    // permanent.
    let fail = true;
    const github = fakeGithub({
      addLabels: async () => {
        if (fail) throw new Error("403 from GitHub");
      },
    });
    recordFixRun({ n: 1, attempt: 3, headSha: "aaaa111bbbb222", diagnosisClass: "reproducible" });

    const first = await dispatchOnce(github, snapshot(github));
    expect(first.outcome).toMatchObject({ labelled: false, commented: false });
    expect(github.postComment).not.toHaveBeenCalled();

    fail = false;
    const retry = snapshot(github);
    expect(retry.escalatedBy).toBeNull(); // no label ⇒ the guard cannot bind
    const second = await dispatchOnce(github, retry);
    expect(second.decision.escalation).toBe("attempts-exhausted");
    expect(second.outcome).toMatchObject({ labelled: true, commented: true });
    expect(github.postComment).toHaveBeenCalledTimes(1);
  });
});

describe("escalatePr — the anti-latch property", () => {
  it("a maintainer's push re-arms the PR: attempt resets to 1 and it dispatches again", async () => {
    // THE test. `requires-human` is a notification, not a state: the state is
    // "we escalated at head SHA X", so a new head from anyone but us is the
    // intervention we asked for. The label is still on the PR and nobody had to
    // remove it. Before the escalation wrote a run row, this could not work at
    // all — `escalatedAtSha` was never persisted, so the label alone read as a
    // human's permanent override and the PR stayed dead for its whole life.
    const github = fakeGithub();
    recordFixRun({ n: 1, attempt: 3, headSha: "aaaa111bbbb222", diagnosisClass: "reproducible" });
    await dispatchOnce(github, snapshot(github));
    expect(github.labels.has(REQUIRES_HUMAN_LABEL)).toBe(true);

    const pushed = snapshot(github, {
      headSha: "dddd444eeee555",
      headAuthor: "octocat",
      headIsOurs: false,
    });

    expect(pushed.attempt).toBe(1);
    expect(pushed.priorAttempts).toEqual([]);
    expect(pushed.priorDiagnosisClass).toBeNull();
    expect(pushed.labels).toContain(REQUIRES_HUMAN_LABEL);
    expect(pushed.escalatedBy).toBe("us");

    const out = await dispatchOnce(github, pushed);
    expect(out.decision.decision).toBe("run");
    expect(out.decision.reason).toBe("attempt 1/3");
    // Nothing new applied — this is a dispatch, not a second escalation.
    expect(github.postComment).toHaveBeenCalledTimes(1);
  });

  it("a human-applied `requires-human` with no escalating run of ours stays a permanent override", async () => {
    // The distinction the stateful guard exists to preserve. There is no
    // escalation record to match, so the label means "bot, stay out" — and it
    // keeps meaning that across a push, unlike our own escalation.
    const github = fakeGithub();
    github.labels.add(REQUIRES_HUMAN_LABEL);

    const first = snapshot(github);
    expect(first.escalatedAtSha).toBeNull();
    expect(first.escalatedBy).toBe("human");
    const out = await dispatchOnce(github, first);
    expect(out.decision.reason).toMatch(/^human-hold:/);
    expect(out.outcome).toBeNull();

    const afterPush = snapshot(github, { headSha: "ffff666", headAuthor: "octocat" });
    expect(afterPush.escalatedBy).toBe("human");
    expect(resolveFixDisposition(afterPush, fix).reason).toMatch(/^human-hold:/);
    expect(github.addLabels).not.toHaveBeenCalled();
    expect(db.runs.latestForTrigger([WORKFLOW], TRIGGER)).toBeNull();
  });
});

describe("renderEscalationComment", () => {
  const state = liveState({
    attempt: 4,
    cumulativeCostUsd: 1.25,
    priorAttempts: [
      "attempt 1: class=reproducible cause=lockfile stale vs package.json | outcome=pushed gate=green",
      "attempt 2: class=env-mismatch cause=CI runs node 22, sandbox node 20 | outcome=gave-up gate=red",
    ],
  });

  it("names the case, the attempt count and every attempt's class + cause", () => {
    // 04-retry.md §4.3's contract for the one comment.
    const body = renderEscalationComment(
      "attempts-exhausted",
      "attempts-exhausted: attempt 4 exceeds fix.maxAttempts 3",
      state,
      fix,
    );
    expect(body).toContain("every attempt I'm allowed");
    expect(body).toContain("attempts-exhausted: attempt 4 exceeds fix.maxAttempts 3");
    expect(body).toContain("3 of 3 spent");
    expect(body).toContain("class=reproducible cause=lockfile stale vs package.json");
    expect(body).toContain("class=env-mismatch cause=CI runs node 22, sandbox node 20");
    expect(body).toContain("$1.25 of $5.00");
    // The anti-latch property, told to the person who has to act on it.
    expect(body).toMatch(/Push a commit to this branch/);
    expect(body).toMatch(/don't need to remove it by hand/i);
  });

  it("says so plainly when no attempt ever produced a diagnosis", () => {
    const body = renderEscalationComment("budget-exhausted", "budget-exhausted: …", liveState(), fix);
    expect(body).toContain("no per-attempt notes");
    expect(body).not.toContain("- `attempt");
  });
});

// ---------------------------------------------------------------------------
// The fork-PR notice — once per PR, keyed on the decision
// ---------------------------------------------------------------------------

/**
 * The notice is the one skip a human is owed an explanation for on the PR
 * itself: nothing is wrong with their change, we simply have no branch to push
 * to. Two things were wrong with it (#256), and each is a test below: it fired
 * on `state.isFork` rather than on the `fork-pr` DECISION, so any skip on a
 * fork PR earned it; and it had no de-duplication at all, so it fired once per
 * skip for the life of the PR.
 *
 * Run through the real store for the same reason the escalation tests are:
 * the de-duplication IS the persisted record, so faking the store would fake
 * the link that carries the property.
 */
describe("noticeForkPr", () => {
  const FORK = liveState({
    isFork: true,
    headRepoFullName: "octocat/lastlight",
    headRef: "patch-1",
  });

  /** One dispatch of the fork PR, applying whatever the decision entails. */
  async function forkDispatch(github: ReturnType<typeof fakeGithub>, over: Partial<PrState> = {}) {
    const state = liveState({ ...FORK, ...over });
    applyDerivedState(state, { github: null, db, botLogin: BOT });
    const decision = resolveFixDisposition(state, fix, { dedupOnHeadSha: true });
    const outcome = decision.forkPr ? await noticeForkPr(WORKFLOW, state, { db, github }) : null;
    return { state, decision, outcome };
  }

  it("explains itself once, and records that it did", async () => {
    const github = fakeGithub();
    const { decision, outcome } = await forkDispatch(github);

    expect(decision.reason).toMatch(/^fork-pr:/);
    expect(decision.forkPr).toBe(true);
    expect(outcome?.commented).toBe(true);
    expect(github.postComment).toHaveBeenCalledTimes(1);
    expect(github.postComment.mock.calls[0][3]).toContain("octocat/lastlight");
    // Never a label: a fork PR is not `requires-human`, it is not this author's
    // problem to solve on this repo.
    expect(github.addLabels).not.toHaveBeenCalled();
  });

  it("says nothing on the next event, because the record carries forward", async () => {
    const github = fakeGithub();
    await forkDispatch(github);
    const second = await forkDispatch(github);

    expect(second.state.forkNoticedAtSha).toBe(FORK.headSha);
    expect(second.decision.forkPr).toBe(true); // still the right decision…
    expect(second.outcome).toBeNull(); // …and still says nothing
    expect(github.postComment).toHaveBeenCalledTimes(1);
  });

  it("stays silent across a push, unlike an escalation", async () => {
    // The asymmetry is deliberate. An escalation says "this problem needs a
    // human", which a new commit can make untrue; a fork notice says "your
    // branch is not on this repo", which pushing to that same fork does not
    // change. Ten pushes is one apology.
    const github = fakeGithub();
    await forkDispatch(github);
    const afterPush = await forkDispatch(github, { headSha: "ffff666", headAuthor: "octocat" });

    expect(afterPush.outcome).toBeNull();
    expect(github.postComment).toHaveBeenCalledTimes(1);
  });

  it("is not fired by a skip that is not `fork-pr`", async () => {
    // `state.isFork` is true on EVERY skip a fork PR takes. The run lock is one
    // of them: "another run owns this PR" has nothing to say about forks, and
    // answering it with "I can't apply fixes to this PR" explains a decision
    // that was not taken.
    const github = fakeGithub();
    db.runs.createRun({
      id: "run-live",
      workflowName: "pr-fix",
      triggerId: TRIGGER,
      owner: "cliftonc",
      repo: "lastlight",
      issueNumber: PR,
      currentPhase: "fix",
      status: "running",
      startedAt: new Date().toISOString(),
    });

    const { decision, outcome } = await forkDispatch(github);

    expect(decision.reason).toMatch(/^run-in-flight:/);
    expect(decision.forkPr).toBeUndefined();
    expect(outcome).toBeNull();
    expect(github.postComment).not.toHaveBeenCalled();
  });

  it("says nothing rather than repeating itself when the record cannot be written", async () => {
    // Row-then-comment, for the same reason escalation is: comment-then-crash
    // would repeat the comment forever, which is the failure being fixed.
    const github = fakeGithub();
    const brokenDb = {
      runs: {
        ...db.runs,
        createRun: () => { throw new Error("disk full"); },
        activeForTrigger: () => null,
        latestForTrigger: () => null,
        latestSucceededForTriggers: () => ({}),
      },
      executions: { costForTriggerWorkflows: () => 0, phaseSucceededInRun: () => false },
    } as unknown as StateDb;

    const outcome = await noticeForkPr(WORKFLOW, liveState(FORK), { db: brokenDb, github });

    expect(outcome).toBeNull();
    expect(github.postComment).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// The cost window
// ---------------------------------------------------------------------------

/**
 * `fix.maxCostUsd` bounds a PROBLEM, not a pull request — the same window
 * `fix.maxAttempts` bounds, on the same `sameProblem` boundary.
 *
 * It used to be the PR's whole lifetime spend, which put the two budgets out of
 * step: a maintainer's push re-armed the attempt counter and cleared the
 * `escalated:` guard, then the very next event fell straight back through
 * `budget-exhausted` and posted another `requires-human` comment — a comment
 * whose closing paragraph tells the maintainer that pushing is the remedy
 * (#256).
 */
describe("the cost window resets with the problem", () => {
  /** A finished fix run costing `usd`, dispatched at `headSha`. */
  function spend(n: number, headSha: string, usd: number, state: PrState): void {
    const id = `cost-run-${n}`;
    db.runs.createRun({
      id,
      workflowName: WORKFLOW,
      triggerId: TRIGGER,
      owner: "cliftonc",
      repo: "lastlight",
      issueNumber: PR,
      currentPhase: "fix",
      status: "succeeded",
      context: { prState: state },
      startedAt: `2020-01-0${n}T00:00:00.000Z`,
    });
    // The cost is summed off `executions` JOINed to the run row, so the
    // execution has to carry `workflowRunId` — that join is what scopes spend
    // to the fix family on this PR.
    db.executions.recordStart({
      id: `exec-${n}`,
      skill: WORKFLOW,
      triggerType: "webhook",
      triggerId: TRIGGER,
      repo: REPO,
      issueNumber: PR,
      startedAt: `2020-01-0${n}T00:00:00.000Z`,
      workflowRunId: id,
    });
    db.executions.recordFinish(`exec-${n}`, { success: true, costUsd: usd });
    void headSha;
  }

  it("counts spend on the current problem, not the PR's lifetime", async () => {
    const github = fakeGithub();
    const budget = { ...fix, maxCostUsd: 1.0 };

    // Two attempts blow the budget on the original head.
    const first = snapshot(github);
    spend(1, first.headSha, 0.8, first);
    const second = snapshot(github);
    spend(2, second.headSha, 0.5, second);

    const exhausted = snapshot(github);
    expect(exhausted.cumulativeCostUsd).toBeCloseTo(1.3);
    const stop = resolveFixDisposition(exhausted, budget);
    expect(stop.escalation).toBe("budget-exhausted");
    await escalatePr(WORKFLOW, exhausted, stop, budget, { db, github });
    expect(github.postComment).toHaveBeenCalledTimes(1);

    // A maintainer pushes. That is a fresh problem — so the budget re-arms
    // exactly as the attempt counter does, and nothing is posted again.
    const afterPush = snapshot(github, { headSha: "ffff666", headAuthor: "octocat" });
    expect(afterPush.attempt).toBe(1);
    expect(afterPush.cumulativeCostUsd).toBe(0);
    expect(afterPush.costBaselineUsd).toBeCloseTo(1.3);

    const retry = resolveFixDisposition(afterPush, budget);
    expect(retry.decision).toBe("run");
    expect(retry.escalation).toBeUndefined();
    expect(github.postComment).toHaveBeenCalledTimes(1);
  });

  it("keeps counting while the problem is the same, including across our own pushes", async () => {
    const github = fakeGithub();
    const first = snapshot(github);
    spend(1, first.headSha, 0.4, first);

    // OUR push: the fix landed and CI is still red — same problem, so the spend
    // carries. (`headIsOurs` is what `sameProblem` reads.)
    const ours = snapshot(github, { headSha: "bbbb222", headAuthor: BOT, headIsOurs: true });
    expect(ours.cumulativeCostUsd).toBeCloseTo(0.4);
    spend(2, ours.headSha, 0.4, ours);

    const third = snapshot(github, { headSha: "bbbb222", headAuthor: BOT, headIsOurs: true });
    expect(third.cumulativeCostUsd).toBeCloseTo(0.8);
    expect(third.costBaselineUsd).toBe(0);
  });

  it("gives a PR mid-flight at upgrade its full lifetime spend", async () => {
    // A run row written before `costBaselineUsd` existed carries no baseline,
    // so it reads 0 — which is the old behaviour, for the only case where the
    // old behaviour was right.
    const github = fakeGithub();
    const legacy = liveState();
    delete (legacy as Partial<PrState>).costBaselineUsd;
    spend(1, legacy.headSha, 0.9, legacy);

    expect(snapshot(github).cumulativeCostUsd).toBeCloseTo(0.9);
  });
});
