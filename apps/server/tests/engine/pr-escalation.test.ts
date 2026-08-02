/**
 * Escalation — what a terminal skip does to the pull request, and (the part
 * that is easy to get wrong) what it does to OUR OWN STATE.
 *
 * These run against a real in-memory `StateDb`, because the property under test
 * is a SEQUENCE across dispatches through the actual transport: escalate →
 * `createRun`/`finishRun` → `latestForTrigger` → `applyDerivedState` →
 * `resolveFixDisposition`. Faking the store would fake exactly the link that
 * carries the defect — a row-less escalation persists no `escalatedAtSha`, so
 * the guard never binds and every subsequent event escalates and comments again
 * (09 → D1). The anti-latch test at the bottom is the one that fails if that
 * link is ever broken.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { StateDb } from "#src/state/db.js";
import type { GitHubClient } from "#src/engine/github/github.js";
import {
  applyDerivedState,
  prTriggerId,
  type InterventionRequest,
  type PrState,
} from "#src/engine/pr-state.js";
import { resolveFixDisposition, type EscalationCase } from "#src/engine/pr-decisions.js";
import {
  escalatePr,
  noticeForkPr,
  recordIntervention,
  renderEscalationComment,
} from "#src/engine/pr-escalation.js";
import { HOLD_LABEL, REQUIRES_HUMAN_LABEL } from "#src/cron/dependabot-discovery.js";
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
    intervention: null,
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

/**
 * Resolve the snapshot a fresh dispatch would see, with the live labels — and,
 * optionally, a retry arriving WITH the event (`@<bot> retry`, or the admin
 * API). Handed to the resolver rather than patched on afterwards, exactly as
 * the dispatcher does it: `sameProblem` reads the record, so an intervention
 * applied after the snapshot was derived would re-arm nothing.
 */
function snapshot(
  github: { labels: Set<string> },
  over: Partial<PrState> = {},
  intervention?: InterventionRequest,
): PrState {
  const state = liveState({ labels: [...github.labels], ...over });
  applyDerivedState(state, { github: null, db, botLogin: BOT, ...(intervention ? { intervention } : {}) });
  return state;
}

/** The escalating decision a given state produces, for the direct-call tests. */
function escalatingDecision(state: PrState) {
  return resolveFixDisposition(state, fix, { dedupOnHeadSha: true });
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

  it("an unknown head SHA never escalates — recording `\"\"` would re-comment forever", async () => {
    // A falsy `escalatedAtSha` reads back as an escalation at a head that
    // matches nothing, so the guard never binds and every later event escalates
    // — and comments — again. Refuse instead; the next event re-resolves.
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

  it("a label write that fails posts no comment, and never re-comments", async () => {
    // The row is written FIRST on purpose, and it is the row that binds. A
    // label write that 403s therefore costs the PR its NOTIFICATION, not its
    // record. The reverse order would leave a label with no record — a
    // `requires-human` nothing in the code can see, so every subsequent event
    // would escalate and comment again.
    //
    // What it DOES cost, since 03-retry-intervention.md, is one extra window.
    // The label-removal exit reads "we escalated at this head and our label is
    // gone" as a human asking for another try, and a label that never landed is
    // indistinguishable from one somebody removed. So the next dispatch re-arms
    // once — erring toward the human, on a PR we have stopped on with nothing
    // on it saying so — and the record of that retry is what stops it repeating.
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
    expect(github.labels.has(REQUIRES_HUMAN_LABEL)).toBe(false);

    fail = false;
    const rearmed = snapshot(github);
    expect(rearmed.intervention).toMatchObject({ via: "label", atSha: "aaaa111bbbb222" });
    expect(rearmed.escalatedAtSha).toBeNull();
    expect(rearmed.attempt).toBe(1);
    const second = await dispatchOnce(github, rearmed);
    expect(second.decision.decision).toBe("run");
    expect(second.outcome).toBeNull();

    // …and once recorded, it is not re-detected at the same head. The extra
    // window is ONE window, not one per event.
    //
    // The clock is pinned for the same reason `spend()` takes an explicit `at`:
    // both the escalation row and the retry record are stamped `now` by the code
    // under test, they land inside the same millisecond here, and
    // `latestForTrigger` orders on `started_at` — so which row the next resolve
    // reads its history off came down to how the tie broke.
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2030-01-01T00:00:00.000Z"));
      await recordIntervention(WORKFLOW, rearmed, { db, github });
    } finally {
      vi.useRealTimers();
    }
    const third = snapshot(github);
    expect(third.intervention?.at).toBe(rearmed.intervention?.at);
    expect(third.attempt).toBe(1);

    // The whole point: not a single comment across any of it.
    expect(github.postComment).not.toHaveBeenCalled();
  });

  it("refuses outright when it has already escalated at this exact head", async () => {
    // Phase 4's safety net. The `escalated:` guard is what normally makes this
    // once-only, and it is bypassable — by an explicit request, by a
    // hand-removed label, by a retry — so every bypass lands back here. This is
    // the belt: re-recording would be harmless, re-commenting is #256.
    const github = fakeGithub();
    const state = liveState({ attempt: 4 });

    const first = await escalatePr(WORKFLOW, state, escalatingDecision(state), fix, { db, github });
    expect(first).toMatchObject({ labelled: true, commented: true });

    // The same snapshot, one event later, with the escalation now on it — as
    // any path that bypassed the guard would present it.
    const again = { ...state, escalatedAtSha: state.headSha };
    const second = await escalatePr(WORKFLOW, again, escalatingDecision(again), fix, { db, github });

    expect(second).toBeNull();
    expect(github.addLabels).toHaveBeenCalledTimes(1);
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

    const out = await dispatchOnce(github, pushed);
    expect(out.decision.decision).toBe("run");
    expect(out.decision.reason).toBe("attempt 1/3");
    // Nothing new applied — this is a dispatch, not a second escalation.
    expect(github.postComment).toHaveBeenCalledTimes(1);
  });

  it("a hand-applied `requires-human` with no escalation record holds nothing", async () => {
    // The behaviour change of 02-hold-label.md. `requires-human` used to be
    // inferred into a permanent override on a PR no run of ours had touched —
    // which meant it worked ONLY there, and read as the bot's own label
    // everywhere else. It is now a pure notification: nothing reads it, so this
    // PR dispatches. A maintainer who wants us off it applies the HOLD label,
    // which works on every PR.
    const github = fakeGithub();
    github.labels.add(REQUIRES_HUMAN_LABEL);

    const first = snapshot(github);
    expect(first.escalatedAtSha).toBeNull();
    const out = await dispatchOnce(github, first);
    expect(out.decision.decision).toBe("run");
    expect(out.outcome).toBeNull();

    const afterPush = snapshot(github, { headSha: "ffff666", headAuthor: "octocat" });
    expect(resolveFixDisposition(afterPush, fix).decision).toBe("run");
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

  const VOCAB = { holdLabel: HOLD_LABEL, botMention: "@last-light" };

  it("names the case, the attempt count and every attempt's class + cause", () => {
    // 04-retry.md §4.3's contract for the one comment.
    const body = renderEscalationComment(
      "attempts-exhausted",
      "attempts-exhausted: attempt 4 exceeds fix.maxAttempts 3",
      state,
      fix,
      VOCAB,
    );
    expect(body).toContain("every attempt I'm allowed");
    expect(body).toContain("attempts-exhausted: attempt 4 exceeds fix.maxAttempts 3");
    expect(body).toContain("3 of 3 spent");
    expect(body).toContain("class=reproducible cause=lockfile stale vs package.json");
    expect(body).toContain("class=env-mismatch cause=CI runs node 22, sandbox node 20");
    expect(body).toContain("$1.25 of $5.00");
  });

  it("says so plainly when no attempt ever produced a diagnosis", () => {
    const body = renderEscalationComment(
      "budget-exhausted",
      "budget-exhausted: …",
      liveState(),
      fix,
      VOCAB,
    );
    expect(body).toContain("no per-attempt notes");
    expect(body).not.toContain("- `attempt");
  });

  /**
   * The closing section is a CONTRACT: it is the only place most people will
   * ever learn how to un-stick the bot, so it has to name every exit that works
   * and no exit that does not.
   *
   * It failed both halves before Phase 3. It promised *"you can also ask me
   * directly in a comment to override"*, which `resolveFixDisposition` refused
   * — an explicit request cleared the escalation guard and fell straight into
   * the same budget gate, so asking bought you nothing but a duplicate copy of
   * this comment — and it never mentioned the hold label, which did not exist
   * when it was written.
   */
  describe("the closing section names the exits that exist", () => {
    const cases: Array<[EscalationCase, string]> = [
      ["attempts-exhausted", "attempts-exhausted: …"],
      ["budget-exhausted", "budget-exhausted: …"],
      ["not-retryable", "not-retryable: …"],
    ];

    it.each(cases)("%s lists all four, and promises no override", (kase, reason) => {
      const body = renderEscalationComment(kase, reason, state, fix, VOCAB);

      // 1. The push, still the zero-thinking option.
      expect(body).toContain("**Push a commit to this branch.**");
      expect(body).toMatch(/don't need to remove `requires-human` by hand/);
      // 2. The comment — which now works, and takes a reason.
      expect(body).toContain("`@last-light retry`");
      expect(body).toContain("@last-light retry the arm64 runner was flaky");
      // 3. The label removal — which now works.
      expect(body).toContain("**Remove the `requires-human` label.**");
      expect(body).toMatch(/have another go/);
      // 4. And the opposite of a retry: the hold.
      expect(body).toContain(`apply \`${HOLD_LABEL}\``);
      expect(body).toMatch(/nothing of mine runs on it until that label comes off/);

      // The three retries re-arm the same window, which is why they are one
      // list rather than three different-sounding promises.
      expect(body).toMatch(/re-arms the attempt counter and the cost budget/);

      // And the promise the code refused is gone for good.
      expect(body).not.toMatch(/comment to override/i);
    });

    it("speaks the deployment's OWN names, not the packaged ones", () => {
      // Both are operator-configurable (`hold.label`, `botName`). A comment
      // naming a label nobody applies, or a handle nobody answers to, is worse
      // than no instructions at all.
      const body = renderEscalationComment("budget-exhausted", "budget-exhausted: …", state, fix, {
        holdLabel: "hands-off",
        botMention: "@nearform-lastlight",
      });
      expect(body).toContain("`@nearform-lastlight retry`");
      expect(body).toContain("apply `hands-off`");
      expect(body).not.toContain(HOLD_LABEL);
    });
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

// ---------------------------------------------------------------------------
// The retry — `PrState.intervention` (03-retry-intervention.md)
// ---------------------------------------------------------------------------

/**
 * A retry does **exactly what a push does** (locked decision 7), with one
 * asymmetry: it keeps the journal (locked decision 8).
 *
 * These sit beside the cost-window tests above because they are the same
 * property from the other side. `fix.maxCostUsd` and `fix.maxAttempts` bound one
 * window on one boundary, `sameProblem`; before this the ONLY way to move that
 * boundary was a non-bot commit, so of the three things a maintainer would
 * naturally try, exactly one worked — and two of the three posted a duplicate
 * escalation comment, which is #256 reintroduced through two doors its original
 * fix did not cover.
 *
 * Driven as SEQUENCES through the real store for the same reason everything
 * else in this file is: the record IS the mechanism, so faking the transport
 * would fake the link that carries it.
 */
describe("a retry re-arms the problem, exactly as a push does", () => {
  /**
   * A finished fix run costing `usd`, dispatched on `state`.
   *
   * `at` is explicit because `escalatePr` stamps its row `now`, and
   * `latestForTrigger` orders on `started_at`: a run that has to read as
   * happening AFTER an escalation must say so.
   */
  function spend(n: number, usd: number, state: PrState, at = `2020-01-0${n}T00:00:00.000Z`): void {
    const id = `retry-run-${n}`;
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
      startedAt: at,
    });
    db.executions.recordStart({
      id: `retry-exec-${n}`,
      skill: WORKFLOW,
      triggerType: "webhook",
      triggerId: TRIGGER,
      repo: REPO,
      issueNumber: PR,
      startedAt: at,
      workflowRunId: id,
    });
    db.executions.recordFinish(`retry-exec-${n}`, { success: true, costUsd: usd });
    db.runs.mergeScratch(id, {
      fixMarkers: {
        diagnosis: {
          class: "reproducible",
          cause: "the lockfile is stale",
          rawClass: "reproducible",
          pr: PR,
          attempt: n,
          ciVsLocal: "",
          unreproducible: [],
        },
        fix: null,
        phases: ["diagnose"],
        at: "2020-01-01T00:00:00.000Z",
      },
    });
  }

  const COMMENT: InterventionRequest = { via: "comment", by: "alice", note: "arm64 runner was flaky" };

  it("re-arms `attempt` to 1 and the cost window to 0", async () => {
    const github = fakeGithub();
    const budget = { ...fix, maxCostUsd: 1.0 };

    const first = snapshot(github);
    spend(1, 0.8, first);
    const second = snapshot(github);
    spend(2, 0.5, second);

    const exhausted = snapshot(github);
    expect(exhausted.cumulativeCostUsd).toBeCloseTo(1.3);
    expect(exhausted.attempt).toBe(3);
    await escalatePr(WORKFLOW, exhausted, resolveFixDisposition(exhausted, budget), budget, {
      db,
      github,
    });
    expect(github.postComment).toHaveBeenCalledTimes(1);

    // `@last-light retry the arm64 runner was flaky`. Nothing about the pull
    // request has changed — same head, same code, same everything.
    const retried = snapshot(github, {}, COMMENT);
    expect(retried.attempt).toBe(1);
    expect(retried.cumulativeCostUsd).toBe(0);
    expect(retried.costBaselineUsd).toBeCloseTo(1.3);
    expect(retried.intervention).toMatchObject({
      via: "comment",
      by: "alice",
      note: "arm64 runner was flaky",
      atSha: exhausted.headSha,
    });

    const out = resolveFixDisposition(retried, budget);
    expect(out.decision).toBe("run");
    expect(out.reason).toBe("attempt 1/3");
    expect(github.postComment).toHaveBeenCalledTimes(1);
  });

  it("KEEPS the journal and marks the seam — where a push wipes it", () => {
    // Locked decision 8, the one asymmetry. A push changed the code, so prior
    // findings may be stale; a retry changed nothing but patience, and
    // discarding the journal sends attempt 1 of the new window straight down
    // attempt 1 of the old window's road.
    const github = fakeGithub();
    const first = snapshot(github);
    spend(1, 0.1, first);
    const second = snapshot(github);
    expect(second.priorAttempts).toHaveLength(1);
    spend(2, 0.1, second);

    const retried = snapshot(github, {}, COMMENT);
    expect(retried.priorAttempts).toEqual([
      "attempt 1: class=reproducible cause=the lockfile is stale",
      "attempt 2: class=reproducible cause=the lockfile is stale",
      '— retried by request: "arm64 runner was flaky" —',
    ]);

    // The same history, re-armed by a PUSH instead: journal gone.
    const pushed = snapshot(github, { headSha: "ffff666", headAuthor: "octocat" });
    expect(pushed.priorAttempts).toEqual([]);
  });

  it("renders the seam without a quote when nobody gave a reason", () => {
    const github = fakeGithub();
    const first = snapshot(github);
    spend(1, 0.1, first);
    const retried = snapshot(github, {}, { via: "label" });
    expect(retried.priorAttempts.at(-1)).toBe("— retried by request —");
  });

  it("lands the maintainer's reason in the PR journal, as a hint", () => {
    // The one channel free text is allowed to reach a prompt through: bounded,
    // fenced, and read by no decision function.
    const github = fakeGithub();
    const first = snapshot(github);
    spend(1, 0.1, first);

    const retried = snapshot(github, {}, COMMENT);
    expect(retried.notes.at(-1)).toMatchObject({
      kind: "finding",
      workflow: "retry",
      phase: "comment",
      text: "arm64 runner was flaky",
    });
    // Not marked stale: the head has not moved, so nothing here is a claim
    // about a commit that is no longer current.
    expect(retried.notes.every((n) => !n.stale)).toBe(true);
  });

  it("refuses a reason that could forge a marker the parser reads", () => {
    // `pr-notes.ts`'s reject list, applied at the one place the record is built
    // — so no surface can route around it. The retry still happens; only the
    // free text is dropped.
    const github = fakeGithub();
    const first = snapshot(github);
    spend(1, 0.1, first);

    const retried = snapshot(github, {}, { via: "comment", by: "mallory", note: "class=flaky" });
    expect(retried.intervention).toMatchObject({ via: "comment", by: "mallory" });
    expect(retried.intervention?.note).toBeUndefined();
    expect(retried.priorAttempts.at(-1)).toBe("— retried by request —");
    expect(retried.notes.some((n) => n.text.includes("class="))).toBe(false);
  });

  it("resets `flakyDeferrals` on a retry, exactly as a push does", () => {
    // A human intervening is a statement that the flaky-versus-real inference
    // should start over, and they have better evidence than the counter does.
    const github = fakeGithub();
    const first = snapshot(github, { flakyDeferrals: 0 });
    db.runs.createRun({
      id: "flaky-run",
      workflowName: WORKFLOW,
      triggerId: TRIGGER,
      owner: "cliftonc",
      repo: "lastlight",
      issueNumber: PR,
      currentPhase: "diagnose",
      status: "succeeded",
      context: { prState: { ...first, flakyDeferrals: 2 } },
      startedAt: "2020-01-01T00:00:00.000Z",
    });
    db.runs.mergeScratch("flaky-run", {
      fixMarkers: {
        diagnosis: { class: "flaky", cause: "x", rawClass: "flaky", pr: PR, attempt: 1, ciVsLocal: "", unreproducible: [] },
        fix: null,
        phases: ["diagnose"],
        at: "2020-01-01T00:00:00.000Z",
      },
    });

    expect(snapshot(github).flakyDeferrals).toBe(3);
    expect(snapshot(github, {}, COMMENT).flakyDeferrals).toBe(0);
    expect(snapshot(github, { headSha: "ffff666", headAuthor: "octocat" }).flakyDeferrals).toBe(0);
  });

  it("is UNBOUNDED — a second retry after a second escalation re-arms again", async () => {
    // Locked decision 9: unbounded retries, full window each time. The backstop
    // is a server-level spend cap (not built yet), not a hidden second budget —
    // a second budget shape is how the old six-sites-disagreeing situation
    // started.
    const github = fakeGithub();
    const budget = { ...fix, maxCostUsd: 1.0 };

    const first = snapshot(github);
    spend(1, 1.5, first);

    const exhausted = snapshot(github);
    await escalatePr(WORKFLOW, exhausted, resolveFixDisposition(exhausted, budget), budget, { db, github });
    expect(github.postComment).toHaveBeenCalledTimes(1);

    // Retry #1 — and record it the way a dispatched run would.
    const retry1 = snapshot(github, {}, COMMENT);
    expect(resolveFixDisposition(retry1, budget).decision).toBe("run");
    spend(2, 1.5, retry1, "2030-01-01T00:00:00.000Z");

    // Which blows the fresh window, so we escalate again at the same head.
    const exhausted2 = snapshot(github);
    expect(exhausted2.cumulativeCostUsd).toBeCloseTo(1.5);
    const stop2 = resolveFixDisposition(exhausted2, budget);
    expect(stop2.escalation).toBe("budget-exhausted");
    await escalatePr(WORKFLOW, exhausted2, stop2, budget, { db, github });
    expect(github.postComment).toHaveBeenCalledTimes(2);

    // Retry #2, at the same head. Full window again.
    const retry2 = snapshot(github, {}, { via: "comment", by: "bob" });
    expect(retry2.attempt).toBe(1);
    expect(retry2.cumulativeCostUsd).toBe(0);
    expect(resolveFixDisposition(retry2, budget).decision).toBe("run");
    // Two escalations, two comments — one per stop, never one per ask.
    expect(github.postComment).toHaveBeenCalledTimes(2);
  });

  it("un-assesses the head, so a retry is not swallowed by the per-SHA dedup", async () => {
    // The escalation row records `succeeded` at this head, so without this the
    // `already-assessed` skip eats every retry that did not arrive as an
    // explicit `@bot` request — which is both the label and the API surfaces.
    const github = fakeGithub();
    const exhausted = liveState({ attempt: 4 });
    await escalatePr(WORKFLOW, exhausted, resolveFixDisposition(exhausted, fix), fix, { db, github });

    const before = snapshot(github);
    expect(before.assessedHeadShaByWorkflow[WORKFLOW]).toBe(before.headSha);

    const retried = snapshot(github, {}, { via: "api", by: "ops" });
    expect(retried.assessedHeadShaByWorkflow[WORKFLOW]).toBeUndefined();
    expect(resolveFixDisposition(retried, fix, { dedupOnHeadSha: true }).decision).toBe("run");
  });
});

/**
 * The two regressions. Both are #256 — "budget-exhausted re-comments on every
 * push" — reintroduced through doors the original fix did not cover, and both
 * failed the same way: they cleared the escalation GUARD without moving the
 * budget WINDOW, so the very next gate fell straight back into
 * `budget-exhausted`.
 */
describe("a retry never produces a second escalation comment", () => {
  it("an explicit request on a budget-exhausted PR posts ONE comment total", async () => {
    // `explicitRequest` bypasses the `escalated:` guard by design — a
    // maintainer asking directly is an intentional override. It used to then
    // fall through into the budget gate, which has no override, and re-escalate:
    // one duplicate comment per ask, for as many times as anyone asked.
    const github = fakeGithub();
    const budget = { ...fix, maxCostUsd: 1.0 };
    const state = liveState({ cumulativeCostUsd: 5.4 });

    const first = resolveFixDisposition(state, budget);
    expect(first.escalation).toBe("budget-exhausted");
    await escalatePr(WORKFLOW, state, first, budget, { db, github });
    expect(github.postComment).toHaveBeenCalledTimes(1);

    // Three asks, none of them a recorded retry (an `@bot fix this`, say).
    const escalated = { ...state, escalatedAtSha: state.headSha };
    for (let i = 0; i < 3; i++) {
      const decision = resolveFixDisposition(escalated, budget, { explicitRequest: true });
      expect(decision.escalation).toBe("budget-exhausted");
      const outcome = await escalatePr(WORKFLOW, escalated, decision, budget, { db, github });
      expect(outcome).toBeNull();
    }

    expect(github.postComment).toHaveBeenCalledTimes(1);
    expect(github.addLabels).toHaveBeenCalledTimes(1);
  });

  it("removing `requires-human` re-arms rather than re-labels", async () => {
    // THE second regression. `escalatedBy` used to fall to null when the label
    // came off, the guard cleared, the budget gate fired anyway — and the label
    // went straight back with a duplicate comment. Now the label's absence is a
    // recorded retry, which moves the window instead of lifting the guard.
    const github = fakeGithub();
    const budget = { ...fix, maxCostUsd: 1.0 };

    recordFixRun({ n: 1, attempt: 3, headSha: "aaaa111bbbb222", diagnosisClass: "reproducible" });
    const exhausted = snapshot(github, { cumulativeCostUsd: 5.4 });
    await escalatePr(WORKFLOW, exhausted, resolveFixDisposition(exhausted, budget), budget, { db, github });
    expect(github.labels.has(REQUIRES_HUMAN_LABEL)).toBe(true);
    expect(github.postComment).toHaveBeenCalledTimes(1);

    // A maintainer takes the label off. No webhook: the next event simply reads
    // "we escalated at this head, the head has not moved, our label is gone".
    github.labels.delete(REQUIRES_HUMAN_LABEL);
    const rearmed = snapshot(github);
    expect(rearmed.intervention).toMatchObject({ via: "label", atSha: "aaaa111bbbb222" });
    expect(rearmed.escalatedAtSha).toBeNull();
    expect(rearmed.attempt).toBe(1);
    expect(rearmed.cumulativeCostUsd).toBe(0);

    const out = await dispatchOnce(github, rearmed);
    expect(out.decision.decision).toBe("run");
    expect(out.outcome).toBeNull();
    // Not re-labelled, and not re-commented.
    expect(github.addLabels).toHaveBeenCalledTimes(1);
    expect(github.postComment).toHaveBeenCalledTimes(1);
    expect(github.labels.has(REQUIRES_HUMAN_LABEL)).toBe(false);
  });
});

/**
 * `recordIntervention` — the standalone row, and the seam an admin route uses.
 *
 * A retry that is immediately followed by a dispatch needs no row of its own:
 * `dispatchWorkflow` persists the whole snapshot on the run's
 * `context.prState`, so the dispatched run carries the record. This is the
 * exception — the retry the gate then skips for an unrelated reason, where a
 * skip writes no row and the ask would otherwise evaporate.
 */
describe("recordIntervention", () => {
  it("persists a retry that produced no run, so it survives to the next event", async () => {
    const github = fakeGithub();
    // `upstream-broken`: the base branch is red at the exact moment somebody
    // asks. The retry is real; the dispatch is not going to happen.
    const asked = snapshot(github, { baseChecksState: "failing", attempt: 4 }, { via: "comment", by: "alice" });
    expect(resolveFixDisposition(asked, fix).reason).toMatch(/^upstream-broken:/);

    const outcome = await recordIntervention(WORKFLOW, asked, { db, github });
    expect(outcome).toMatchObject({ via: "comment", at: asked.intervention!.at });

    const row = db.runs.getRun(outcome!.runId)!;
    expect(row.status).toBe("succeeded");
    expect(row.phaseHistory.map((p) => p.phase)).toEqual(["retry-requested"]);
    expect((row.context as any).prState.intervention).toMatchObject({ via: "comment", by: "alice" });

    // The base goes green an hour later. The window is still armed, because the
    // record is on a row the resolver reads back.
    //
    // `dedupOnHeadSha` is NOT optional here, and leaving it off is how this test
    // used to pass while the mechanism was broken: every real dispatch sets it
    // (`applyPrDispatchGate`), and the row this test just wrote is `succeeded`
    // at the current head — so it repopulated `assessedHeadShaByWorkflow` and
    // the `already-assessed` skip ate the very ask the row exists to preserve.
    const later = snapshot(github);
    expect(later.intervention?.at).toBe(asked.intervention!.at);
    expect(later.attempt).toBe(1);
    expect(later.assessedHeadShaByWorkflow[WORKFLOW]).toBeUndefined();
    expect(resolveFixDisposition(later, fix, { dedupOnHeadSha: true }).decision).toBe("run");
  });

  it("is not swallowed by the per-SHA dedup on the tick AFTER it was recorded", async () => {
    // The whole sequence, through the real transport and the real gate — the
    // one the standalone row exists for:
    //
    //   attempt 3 runs at this head and succeeds  → assessed = this head
    //   the budget is spent                       → escalation row, same head
    //   `lastlight pr retry`                      → re-armed, but the base is red
    //   `recordIntervention`                      → the standalone row, same head
    //   the base goes green on a later tick       → this must RUN
    //
    // Two rows claim `succeeded` at this head by then — the escalation and the
    // retry record — and neither ran anything. Before the fix, either one was
    // enough to make the next tick answer `already-assessed`, so the ask was
    // swallowed by the row written to preserve it.
    const github = fakeGithub();
    recordFixRun({ n: 3, attempt: 3, headSha: "aaaa111bbbb222", diagnosisClass: "reproducible" });

    // Both rows below are stamped `now` by the code under test, and
    // `latestForTrigger` orders on `started_at` — so the ticks have to be an
    // hour apart the way real ones are, or the retry record and the escalation
    // it answers tie and the "prior run" is whichever the tie broke toward.
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2030-01-01T00:00:00.000Z"));
      const exhausted = snapshot(github, { attempt: 4 });
      await escalatePr(WORKFLOW, exhausted, resolveFixDisposition(exhausted, fix), fix, { db, github });
      expect(github.postComment).toHaveBeenCalledTimes(1);

      // The ask arrives while the base is red, so the gate skips it for a reason
      // that has nothing to do with the retry.
      vi.setSystemTime(new Date("2030-01-01T01:00:00.000Z"));
      const asked = snapshot(github, { baseChecksState: "failing" }, { via: "api", by: "ops" });
      expect(asked.attempt).toBe(1);
      expect(resolveFixDisposition(asked, fix, { dedupOnHeadSha: true }).reason).toMatch(
        /^upstream-broken:/,
      );
      expect(await recordIntervention(WORKFLOW, asked, { db, github })).not.toBeNull();
      vi.setSystemTime(new Date("2030-01-01T02:00:00.000Z"));
    } finally {
      vi.useRealTimers();
    }

    // Next tick, base green, nothing else changed.
    const later = snapshot(github);
    expect(later.attempt).toBe(1);
    expect(later.escalatedAtSha).toBeNull();
    expect(later.assessedHeadShaByWorkflow[WORKFLOW]).toBeUndefined();
    expect(resolveFixDisposition(later, fix, { dedupOnHeadSha: true }).decision).toBe("run");
    // And still exactly one escalation comment across the whole sequence.
    expect(github.postComment).toHaveBeenCalledTimes(1);
  });

  it("survives the same ordering on the LABEL surface, which nothing hands in", async () => {
    // The other two surfaces reach the same place by different roads, and both
    // land on this ordering:
    //
    // - `@<bot> retry` sets `explicitRequest`, which bypasses the dedup on the
    //   tick it arrives — and on no tick after that, so a comment retry that is
    //   skipped for `upstream-broken` is swallowed by the cron tick that could
    //   finally have served it.
    // - a removed `requires-human` is DETECTED rather than delivered and never
    //   sets `explicitRequest` at all.
    //
    // The label case is the one worth driving end to end, because its record is
    // detected once and then only ever carried forward.
    const github = fakeGithub();
    const budget = { ...fix, maxCostUsd: 1.0 };
    recordFixRun({ n: 1, attempt: 3, headSha: "aaaa111bbbb222", diagnosisClass: "reproducible" });

    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2030-01-01T00:00:00.000Z"));
      const exhausted = snapshot(github, { cumulativeCostUsd: 5.4 });
      await escalatePr(WORKFLOW, exhausted, resolveFixDisposition(exhausted, budget), budget, { db, github });
      expect(github.labels.has(REQUIRES_HUMAN_LABEL)).toBe(true);

      // A maintainer takes the label off — and the base happens to be red.
      vi.setSystemTime(new Date("2030-01-01T01:00:00.000Z"));
      github.labels.delete(REQUIRES_HUMAN_LABEL);
      const asked = snapshot(github, { baseChecksState: "failing" });
      expect(asked.intervention).toMatchObject({ via: "label", atSha: "aaaa111bbbb222" });
      expect(resolveFixDisposition(asked, budget, { dedupOnHeadSha: true }).reason).toMatch(
        /^upstream-broken:/,
      );
      expect(await recordIntervention(WORKFLOW, asked, { db, github })).not.toBeNull();
      vi.setSystemTime(new Date("2030-01-01T02:00:00.000Z"));
    } finally {
      vi.useRealTimers();
    }

    const later = snapshot(github);
    expect(later.intervention?.via).toBe("label");
    expect(later.cumulativeCostUsd).toBe(0);
    expect(later.assessedHeadShaByWorkflow[WORKFLOW]).toBeUndefined();
    expect(resolveFixDisposition(later, budget, { dedupOnHeadSha: true }).decision).toBe("run");
    expect(github.postComment).toHaveBeenCalledTimes(1);
  });

  it("un-assesses the SIBLING workflow's row too, not just the dispatching one", async () => {
    // The record is written under whichever workflow was dispatching, but
    // `already-assessed` fires on ANY workflow in the fix family. So keeping the
    // retry record out of the map is not enough on its own: a real `pr-fix` run
    // that assessed this head before the ask still claims it, and the dedup
    // reads that claim. What clears it is that the claiming row never saw the
    // ask — the same predicate, applied per workflow.
    const github = fakeGithub();
    db.runs.createRun({
      id: "sibling",
      workflowName: "pr-fix",
      triggerId: TRIGGER,
      owner: "cliftonc",
      repo: "lastlight",
      issueNumber: PR,
      currentPhase: "fix",
      status: "succeeded",
      context: { prState: liveState({ attempt: 3 }) },
      startedAt: "2020-01-01T00:00:01.000Z",
    });

    const asked = snapshot(github, { baseChecksState: "failing", attempt: 4 }, { via: "comment", by: "alice" });
    expect(asked.assessedHeadShaByWorkflow["pr-fix"]).toBeUndefined();
    await recordIntervention(WORKFLOW, asked, { db, github });

    const later = snapshot(github);
    expect(later.assessedHeadShaByWorkflow["pr-fix"]).toBeUndefined();
    expect(resolveFixDisposition(later, fix, { dedupOnHeadSha: true }).decision).toBe("run");
  });

  it("stops un-assessing once a run has actually served the ask", async () => {
    // The bound on the clause above. A retry lifts the dedup only until a run
    // that SAW it has assessed the head; after that the head is genuinely
    // assessed again and a redelivered webhook must not buy a second run.
    const github = fakeGithub();
    const asked = snapshot(github, { baseChecksState: "failing", attempt: 4 }, { via: "api", by: "ops" });
    await recordIntervention(WORKFLOW, asked, { db, github });

    const later = snapshot(github);
    expect(resolveFixDisposition(later, fix, { dedupOnHeadSha: true }).decision).toBe("run");

    // …which dispatches. The run carries the intervention forward on its own
    // snapshot, exactly as `dispatchWorkflow` persists it.
    db.runs.createRun({
      id: "served",
      workflowName: WORKFLOW,
      triggerId: TRIGGER,
      owner: "cliftonc",
      repo: "lastlight",
      issueNumber: PR,
      currentPhase: "fix",
      status: "succeeded",
      context: { prState: later },
      startedAt: "2030-01-01T00:00:00.000Z",
    });

    const after = snapshot(github);
    expect(after.assessedHeadShaByWorkflow[WORKFLOW]).toBe(after.headSha);
    expect(resolveFixDisposition(after, fix, { dedupOnHeadSha: true }).reason).toMatch(
      /^already-assessed:/,
    );
  });

  it("is idempotent — the same record never earns a second row", async () => {
    const github = fakeGithub();
    const asked = snapshot(github, { baseChecksState: "failing" }, { via: "api", by: "ops" });

    const first = await recordIntervention(WORKFLOW, asked, { db, github });
    expect(first).not.toBeNull();
    // The next event resolves the SAME record off the row above — so this is
    // exactly what a redelivered webhook, or a route that both records and
    // dispatches, presents.
    const second = await recordIntervention(WORKFLOW, snapshot(github), { db, github });
    expect(second).toBeNull();
  });

  it("says nothing at all when there is no record, or no head SHA", async () => {
    const github = fakeGithub();
    expect(await recordIntervention(WORKFLOW, snapshot(github), { db, github })).toBeNull();
    const headless = snapshot(github, { headSha: "" }, { via: "comment" });
    expect(headless.intervention).toBeNull();
    expect(await recordIntervention(WORKFLOW, headless, { db, github })).toBeNull();
  });
});
