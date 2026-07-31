/**
 * Table tests over literal {@link PrState} fixtures — no GitHub mock, no
 * sandbox, no harness.
 *
 * This is the payoff of 09-state-machine.md's reframe: once the PR's state is
 * ONE resolved snapshot, every policy question is a pure function over it, and
 * most of the plan's verification becomes a table. Each case names the sequence
 * it protects, and each asserts the REASON as well as the decision — the reason
 * is the thing rendered in the log line, the escalation comment and the admin
 * detail panel, so a decision whose justification drifted is a real regression
 * even when the boolean is unchanged.
 */

import { describe, it, expect } from "vitest";
import type { PrState } from "#src/engine/pr-state.js";
import {
  mayMerge,
  resolveFixDisposition,
  resolveMergeDisposition,
  resolveReviewTrigger,
  resolveDispatchDisposition,
  renderContext,
} from "#src/engine/pr-decisions.js";
import {
  defaultDependenciesConfig,
  defaultFixConfig,
  defaultReviewConfig,
} from "lastlight-shared/config-types";

/** An ordinary same-repo PR with a red build and no history. Override per case. */
function state(over: Partial<PrState> = {}): PrState {
  return {
    repo: "cliftonc/lastlight",
    prNumber: 190,
    headSha: "abcdef1234567890",
    headAuthor: "octocat",
    headIsOurs: false,
    headRef: "dependabot/npm/lodash-4.17.21",
    baseRef: "main",
    isDraft: false,
    isFork: false,
    headRepoFullName: "cliftonc/lastlight",
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
    priorAttempts: [],
    cumulativeCostUsd: 0,
    assessedHeadShaByWorkflow: {},
    runInFlight: null,
    readErrors: [],
    ...over,
  };
}

const fix = defaultFixConfig();
const deps = defaultDependenciesConfig();
const review = defaultReviewConfig();

describe("mayMerge", () => {
  const cases: Array<[string, Partial<PrState>, Partial<typeof deps>, boolean, RegExp]> = [
    [
      "settled green with enough checks merges",
      { checksState: "passing", settledCheckCount: 3 },
      {},
      true,
      /^checks-passing:/,
    ],
    [
      "CI still running never merges",
      { checksState: "pending" },
      {},
      false,
      /^checks-pending:/,
    ],
    [
      "a red head never merges",
      { checksState: "failing" },
      {},
      false,
      /^checks-failing:/,
    ],
    [
      // 09 → D10: `"none"` is not `"passing"`. A repo with no CI never fires
      // the webhook, so only the cron sees it — and there `mergeable_state:
      // clean` is true for a PR nothing has looked at.
      "no checks at all is insufficient evidence, not approval",
      { checksState: "none", settledCheckCount: 0 },
      {},
      false,
      /^no-checks:/,
    ],
    [
      // One trivial check and a full matrix both report "passing".
      "one settled check is not enough when the operator demands two",
      { checksState: "passing", settledCheckCount: 1 },
      { minSettledChecks: 2 },
      false,
      /^too-few-checks: 1 settled/,
    ],
    [
      "an operator who turned the requirement off gets today's behaviour",
      { checksState: "failing" },
      { requireSettledChecks: false },
      true,
      /^checks-not-required:/,
    ],
  ];

  it.each(cases)("%s", (_name, over, cfgOver, expected, reason) => {
    const d = mayMerge(state(over), { ...deps, ...cfgOver });
    expect(d.decision).toBe(expected);
    expect(d.reason).toMatch(reason);
    // The panel renders `inputs` verbatim; it must carry what the decision read.
    expect(d.inputs).toMatchObject({ checksState: over.checksState ?? "failing" });
  });
});

describe("resolveFixDisposition", () => {
  const cases: Array<[string, Partial<PrState>, Partial<typeof fix>, Parameters<typeof resolveFixDisposition>[2], "run" | "skip", RegExp]> = [
    ["a red PR on attempt 1 runs", {}, {}, {}, "run", /^attempt 1\/3$/],
    [
      // Cheapest possible skip: before the budget arithmetic, before any sandbox.
      "a fork PR has no branch to push to",
      { isFork: true, headRepoFullName: "octocat/lastlight" },
      {},
      {},
      "skip",
      /^fork-pr: head octocat\/lastlight/,
    ],
    [
      "a deleted fork reads as a fork",
      { isFork: true, headRepoFullName: null },
      {},
      {},
      "skip",
      /\(deleted fork\)/,
    ],
    [
      // 09 → D1. This is a LIVE precondition, not a stored verdict: the moment
      // the base goes green the PR is eligible again, with no label to clear and
      // no run row required to un-stick it. The original design gated on the
      // prior run's diagnosis class through a path that writes no run row, which
      // latched the PR dead forever.
      "a failing base branch skips — a fix here cannot make CI green",
      { baseChecksState: "failing", baseRef: "release/2.x" },
      {},
      {},
      "skip",
      /^upstream-broken: base branch release\/2\.x/,
    ],
    [
      "an unreadable base is NOT upstream-broken (fail-open leaves it `none`)",
      { baseChecksState: "none", readErrors: ["getBaseChecksState: 502"] },
      {},
      {},
      "run",
      /^attempt/,
    ],
    [
      // No escalating run of ours to match → a maintainer applied the label by
      // hand to mean "bot, stay out".
      "a human-applied requires-human is a permanent override",
      { labels: ["requires-human"], escalatedBy: "human" },
      {},
      {},
      "skip",
      /^human-hold:/,
    ],
    [
      "...which an explicit @bot request still overrides",
      { labels: ["requires-human"], escalatedBy: "human" },
      {},
      { explicitRequest: true },
      "run",
      /^attempt/,
    ],
    [
      "our own escalation binds while the head is the one we escalated at",
      { escalatedBy: "us", escalatedAtSha: "abcdef1234567890" },
      {},
      {},
      "skip",
      /^escalated: we escalated this PR at abcdef1/,
    ],
    [
      "...and while the only commit since is one WE authored",
      { escalatedBy: "us", escalatedAtSha: "0000000", headIsOurs: true },
      {},
      {},
      "skip",
      /^escalated:/,
    ],
    [
      // The behaviour a human expects after being asked to intervene: a push
      // re-arms the loop with no label to remove.
      "a maintainer's push clears our escalation without touching the label",
      { escalatedBy: "us", escalatedAtSha: "0000000", headIsOurs: false },
      {},
      {},
      "run",
      /^attempt/,
    ],
    [
      "the cumulative cost cap is a brake that is actually connected",
      { cumulativeCostUsd: 5.4 },
      { maxCostUsd: 5.0 },
      {},
      "skip",
      /^budget-exhausted: \$5\.40 spent/,
    ],
    [
      "an unbounded cost cap never trips",
      { cumulativeCostUsd: 500 },
      { maxCostUsd: null },
      {},
      "run",
      /^attempt/,
    ],
    [
      "attempt 4 of 3 is exhausted",
      { attempt: 4 },
      {},
      {},
      "skip",
      /^attempts-exhausted: attempt 4 exceeds fix\.maxAttempts 3/,
    ],
    [
      // A re-fired suite on a multi-app repo, or the daily cron overlapping the
      // webhook. SUCCEEDED runs only — a crash at this SHA records nothing and
      // is attempted again.
      "a SHA either fix workflow already handled is a duplicate",
      { assessedHeadShaByWorkflow: { "dependabot-ci-fix": "abcdef1234567890" } },
      {},
      { dedupOnHeadSha: true },
      "skip",
      /^already-assessed: dependabot-ci-fix already handled abcdef1/,
    ],
    [
      "...keyed on the FAMILY, so `pr-fix`'s assessment counts too",
      { assessedHeadShaByWorkflow: { "pr-fix": "abcdef1234567890" } },
      {},
      { dedupOnHeadSha: true },
      "skip",
      /^already-assessed: pr-fix/,
    ],
    [
      "...but `dependabot-pr-merge` having assessed it says nothing about fixing it",
      { assessedHeadShaByWorkflow: { "dependabot-pr-merge": "abcdef1234567890" } },
      {},
      { dedupOnHeadSha: true },
      "run",
      /^attempt/,
    ],
    [
      "a route with no per-SHA contract is not deduped",
      { assessedHeadShaByWorkflow: { "pr-fix": "abcdef1234567890" } },
      {},
      {},
      "run",
      /^attempt/,
    ],
  ];

  it.each(cases)("%s", (_name, over, cfgOver, opts, expected, reason) => {
    const d = resolveFixDisposition(state(over), { ...fix, ...cfgOver }, opts);
    expect(d.decision).toBe(expected);
    expect(d.reason).toMatch(reason);
  });

  it("orders the guards cheapest-first: a fork is refused before the budget is even read", () => {
    // A fork PR that is ALSO over budget and escalated must report the fork —
    // it is the reason a human can act on.
    const d = resolveFixDisposition(
      state({ isFork: true, headRepoFullName: "octocat/lastlight", cumulativeCostUsd: 99, attempt: 9 }),
      fix,
    );
    expect(d.reason).toMatch(/^fork-pr:/);
  });

  it("does not let an explicit request override upstream-broken or the budget", () => {
    // Facts, not policy: re-running against a red base cannot help however
    // nicely you ask, and the cap exists to stop exactly this.
    expect(
      resolveFixDisposition(state({ baseChecksState: "failing" }), fix, { explicitRequest: true }).decision,
    ).toBe("skip");
    expect(
      resolveFixDisposition(state({ cumulativeCostUsd: 99 }), fix, { explicitRequest: true }).decision,
    ).toBe("skip");
  });
});

describe("resolveMergeDisposition", () => {
  const cases: Array<[string, Partial<PrState>, Parameters<typeof resolveMergeDisposition>[2], "run" | "skip", RegExp]> = [
    ["a settled-green dependency PR runs", { checksState: "passing" }, {}, "run", /^checks passing$/],
    [
      "CI still running is the cheapest possible wait",
      { checksState: "pending" },
      {},
      "skip",
      /^checks-pending:/,
    ],
    [
      "a human-applied requires-human is a permanent override here too",
      { checksState: "passing", labels: ["requires-human"], escalatedBy: "human" },
      {},
      "skip",
      /^human-hold:/,
    ],
    [
      "an already-assessed head is a duplicate",
      { checksState: "passing", assessedHeadShaByWorkflow: { "dependabot-pr-merge": "abcdef1234567890" } },
      { dedupOnHeadSha: true },
      "skip",
      /^already-assessed: dependabot-pr-merge/,
    ],
    [
      // The merge route's budget is NOT the fix family's: a PR whose fix
      // attempts are exhausted must still merge the moment CI goes green.
      "exhausted fix attempts do not block a merge",
      { checksState: "passing", attempt: 9, cumulativeCostUsd: 99 },
      {},
      "run",
      /^checks passing$/,
    ],
    [
      // 09 → D10 keeps the CI-less case for the MAJOR-bump decision inside the
      // run, where the impact tier is known. Refusing the whole route here
      // would silently stop every patch bump on a CI-less repo.
      "a CI-less repo still reaches the run",
      { checksState: "none", settledCheckCount: 0 },
      {},
      "run",
      /^checks none$/,
    ],
  ];

  it.each(cases)("%s", (_name, over, opts, expected, reason) => {
    const d = resolveMergeDisposition(state(over), deps, opts);
    expect(d.decision).toBe(expected);
    expect(d.reason).toMatch(reason);
  });
});

describe("resolveReviewTrigger", () => {
  const cases: Array<[string, Partial<PrState>, Partial<typeof review>, Parameters<typeof resolveReviewTrigger>[2], "dispatch" | "skip", RegExp]> = [
    [
      // Today this carve-out is accidental — the comment path simply never
      // crosses these code paths. As one branch of the resolver it is a decision.
      "an explicit @bot review always dispatches, overriding mode, draft and dedup",
      { isDraft: true, botReviewAtHead: { state: "APPROVED" }, checksState: "pending" },
      { trigger: "on-request" },
      { explicitRequest: true },
      "dispatch",
      /^requested:/,
    ],
    [
      "the request label is an explicit ask too",
      { labels: ["needs-review"] },
      { trigger: "on-request", requestLabel: "needs-review" },
      {},
      "dispatch",
      /^requested: the `needs-review` label/,
    ],
    ["on-request with nobody asking skips", {}, { trigger: "on-request" }, {}, "skip", /^on-request:/],
    ["a draft is skipped when skipDraft is on", { isDraft: true }, { trigger: "eager" }, {}, "skip", /^draft:/],
    [
      // FIX OUTRANKS REVIEW — a consequence of the PR-scoped lock, not a
      // separate field. Reviewing a tree a fix run is concurrently rewriting
      // produces a review that is stale before it lands.
      "a run in flight suppresses the review",
      { runInFlight: { workflow: "dependabot-ci-fix", runId: "4821" } },
      { trigger: "eager" },
      {},
      "skip",
      /^run-in-flight: dependabot-ci-fix 4821/,
    ],
    [
      "we do not review the same head twice",
      { botReviewAtHead: { state: "CHANGES_REQUESTED" } },
      { trigger: "eager" },
      {},
      "skip",
      /^already-reviewed: we reviewed abcdef1 \(CHANGES_REQUESTED\)/,
    ],
    [
      "eager reviews on PR attention, in parallel with CI",
      { checksState: "pending" },
      { trigger: "eager" },
      { route: "attention" },
      "dispatch",
      /^eager: attention route/,
    ],
    [
      "after-checks waits for the suite to settle",
      { checksState: "pending" },
      { trigger: "after-checks" },
      { route: "checks-settled" },
      "skip",
      /^checks-pending:/,
    ],
    [
      "after-checks does not fire on PR attention alone",
      { checksState: "passing" },
      { trigger: "after-checks" },
      { route: "attention" },
      "skip",
      /^after-checks:/,
    ],
    [
      // 09 → S2 locked decision 14: the `passing` variant was deleted. A PR we
      // gave up on never goes green, so under `passing` the escalated PRs — the
      // ones most needing human eyes — would be the only ones never reviewed.
      "after-checks means EITHER COLOUR, so a red PR is reviewed",
      { checksState: "failing" },
      { trigger: "after-checks" },
      { route: "checks-settled" },
      "dispatch",
      /^after-checks: checks-settled route, checks failing$/,
    ],
    [
      // The release mechanism for every PR whose fix chain ended without
      // pushing: no new commit exists, so no further check_suite will ever fire.
      "the sweep releases a PR the fix chain abandoned",
      { checksState: "failing" },
      { trigger: "after-checks" },
      { route: "sweep" },
      "dispatch",
      /sweep route, checks failing$/,
    ],
  ];

  it.each(cases)("%s", (_name, over, cfgOver, opts, expected, reason) => {
    const d = resolveReviewTrigger(state(over), { ...review, ...cfgOver }, opts);
    expect(d.decision).toBe(expected);
    expect(d.reason).toMatch(reason);
  });
});

describe("resolveDispatchDisposition", () => {
  const cfg = { fix, dependencies: deps, review };

  it("routes each fix-shaped workflow to the fix disposition", () => {
    for (const w of ["pr-fix", "dependabot-ci-fix"]) {
      const d = resolveDispatchDisposition(w, state({ isFork: true }), cfg);
      expect(d.decision).toBe("skip");
      expect(d.reason).toMatch(/^fork-pr:/);
    }
  });

  it("routes dependabot-pr-merge to the merge disposition", () => {
    const d = resolveDispatchDisposition("dependabot-pr-merge", state({ checksState: "pending" }), cfg);
    expect(d.reason).toMatch(/^checks-pending:/);
  });

  it("leaves pr-review ungated — the run lock covers it, the trigger modes are Phase 7", () => {
    const d = resolveDispatchDisposition(
      "pr-review",
      state({ isDraft: true, botReviewAtHead: { state: "APPROVED" } }),
      cfg,
    );
    expect(d.decision).toBe("run");
    expect(d.reason).toMatch(/^ungated:/);
  });

  it("never blocks a workflow it knows nothing about", () => {
    expect(resolveDispatchDisposition("build", state(), cfg).decision).toBe("run");
  });
});

describe("renderContext", () => {
  it("projects the snapshot into the variables the prompts render", () => {
    const ctx = renderContext(
      state({
        headSha: "cafe0001",
        headRef: "dependabot/npm/lodash",
        // A PR targeting a release branch used to have the fix prompt merge
        // `main` into it, because `baseBranch` came from `getDefaultBranch()`.
        baseRef: "release/2.x",
        attempt: 2,
        priorAttempts: ["attempt=1 class=reproducible gate=red"],
        ciReport: {
          logsAvailable: true,
          jobs: [
            {
              name: "test (node 22)",
              conclusion: "failure",
              logExcerpt: "FAIL src/a.test.ts",
              logsAvailable: true,
            },
          ],
        },
      }),
    );

    expect(ctx.baseBranch).toBe("release/2.x");
    expect(ctx.branch).toBe("dependabot/npm/lodash");
    expect(ctx.headSha).toBe("cafe0001");
    expect(ctx.attempt).toBe(2);
    expect(ctx.priorAttempts).toEqual(["attempt=1 class=reproducible gate=red"]);
    expect(ctx.ciSection).toContain("CI FAILURES");
    expect(ctx.ciSection).toContain("test (node 22)");
    expect(ctx.ciLogsAvailable).toBe(true);
  });

  it("does not pass the empty-report sentinel off as CI evidence", () => {
    // `{{#if ciSection}}` is how the templates gate the block, so the
    // "No failed checks found." sentinel must render as an EMPTY ciSection.
    const ctx = renderContext(state({ ciReport: { jobs: [], logsAvailable: false } }));
    expect(ctx.failedChecks).toBe("No failed checks found.");
    expect(ctx.ciSection).toBe("");
  });

  it("renders an empty ciSection when the checks were never failing", () => {
    const ctx = renderContext(state({ checksState: "passing", ciReport: null }));
    expect(ctx.ciSection).toBe("");
    expect(ctx.checksSettledPassing).toBe(true);
  });
});
