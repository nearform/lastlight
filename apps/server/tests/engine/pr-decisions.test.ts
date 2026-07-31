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
  reviewCheckPlacement,
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
    notes: [],
    priorDiagnosisClass: null,
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
      // The ONE prior-run verdict allowed to gate dispatch — and only because
      // this skip WRITES A RUN ROW (09 → D1's general rule). Expressed against
      // `fix.retryableClasses`, whose contract is exactly "classes another
      // attempt may help with; every other class escalates immediately".
      "a prior `infra-dependent` escalates rather than spending the rest of the budget",
      { attempt: 2, priorDiagnosisClass: "infra-dependent" },
      {},
      {},
      "skip",
      /^not-retryable: attempt 1 diagnosed `infra-dependent`/,
    ],
    [
      // Same two classes that cost no attempt: one is a deferral bounded by
      // `fix.maxFlakyDeferrals`, the other is not this PR's fault.
      "a prior `flaky` is a deferral, not a verdict",
      { attempt: 2, priorDiagnosisClass: "flaky" },
      {},
      {},
      "run",
      /^attempt/,
    ],
    [
      "a prior `upstream-broken` never escalates — 09 → D1",
      { attempt: 2, priorDiagnosisClass: "upstream-broken" },
      {},
      {},
      "run",
      /^attempt/,
    ],
    [
      "a retryable class is exactly what the remaining attempts are for",
      { attempt: 2, priorDiagnosisClass: "reproducible" },
      {},
      {},
      "run",
      /^attempt/,
    ],
    [
      // The leaf is configurable: an operator who narrows it narrows what a
      // second attempt is spent on.
      "an operator who drops a class from retryableClasses escalates it instead",
      { attempt: 2, priorDiagnosisClass: "env-mismatch" },
      { retryableClasses: ["reproducible"] },
      {},
      "skip",
      /^not-retryable:.*`env-mismatch`/,
    ],
    [
      "...which an explicit @bot request still overrides",
      { attempt: 2, priorDiagnosisClass: "infra-dependent" },
      {},
      { explicitRequest: true },
      "run",
      /^attempt/,
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
    // it is the reason a human can act on — and must NOT be labelled
    // `requires-human` for a problem that is not its author's to fix.
    const d = resolveFixDisposition(
      state({ isFork: true, headRepoFullName: "octocat/lastlight", cumulativeCostUsd: 99, attempt: 9 }),
      fix,
    );
    expect(d.reason).toMatch(/^fork-pr:/);
    expect(d.escalation).toBeUndefined();
  });

  it("marks exactly the three TERMINAL skips as escalating, and nothing else", () => {
    // The escalation case travels on the decision as a typed field, produced by
    // the branch that decided — so the applier never string-matches the prose.
    // What must not creep in here is a skip that is temporary (`upstream-broken`
    // self-heals), not this PR's problem (`fork-pr`), already escalated
    // (`human-hold` / `escalated`), or a duplicate delivery
    // (`already-assessed`): each would put a label on a PR nobody needs to look
    // at, or comment again on every subsequent event.
    const escalating = (over: Partial<PrState>, opts = {}) =>
      resolveFixDisposition(state(over), fix, opts).escalation;

    expect(escalating({ attempt: 4 })).toBe("attempts-exhausted");
    expect(escalating({ cumulativeCostUsd: 99 })).toBe("budget-exhausted");
    expect(escalating({ attempt: 2, priorDiagnosisClass: "infra-dependent" })).toBe("not-retryable");

    expect(escalating({ baseChecksState: "failing" })).toBeUndefined();
    expect(escalating({ isFork: true })).toBeUndefined();
    expect(escalating({ labels: ["requires-human"], escalatedBy: "human" })).toBeUndefined();
    expect(
      escalating({ escalatedBy: "us", escalatedAtSha: "abcdef1234567890", attempt: 9 }),
    ).toBeUndefined();
    expect(
      escalating(
        { assessedHeadShaByWorkflow: { "pr-fix": "abcdef1234567890" } },
        { dedupOnHeadSha: true },
      ),
    ).toBeUndefined();
    expect(escalating({})).toBeUndefined(); // a plain `run`
  });

  it("drops on the PR-scoped run lock, before every other guard", () => {
    // 09 → S4. `resolveReviewTrigger` read `runInFlight` and these two did not,
    // so the daily `fix-red-dependency-prs` could dispatch `dependabot-ci-fix`
    // onto a PR with a live `pr-fix` run — and the fix family now shares ONE
    // workspace per PR, so that is two agents fetching, `reset --hard`-ing and
    // `clean -fdx`-ing the same directory, each deleting the other's
    // `.lastlight-verify.sh`.
    const held = { runInFlight: { workflow: "pr-fix", runId: "4821" } };
    const d = resolveFixDisposition(state(held), fix);
    expect(d.decision).toBe("skip");
    expect(d.reason).toMatch(/^run-in-flight: pr-fix 4821 is already working this PR$/);
    // A typed field, like `escalation` — the caller must not parse the prose.
    expect(d.runInFlight).toEqual({ workflow: "pr-fix", runId: "4821" });
    // NOT terminal: no label, no comment, no run row. It is a "come back later"
    // that every dropped case has a cron re-pickup for.
    expect(d.escalation).toBeUndefined();

    // Before the escalating skips: a PR whose budget the in-flight run is still
    // spending must not be labelled `requires-human` for it.
    expect(resolveFixDisposition(state({ ...held, attempt: 9, cumulativeCostUsd: 99 }), fix).escalation)
      .toBeUndefined();
    // And before the explicit-request override — `@bot fix this` cannot walk
    // into the running agent's workspace.
    expect(resolveFixDisposition(state(held), fix, { explicitRequest: true }).decision).toBe("skip");
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

  it("drops on the run lock — no auto-merge against a PR whose fix run is in flight", () => {
    // The sequence 09 → S4 names verbatim: `dependabot-ci-fix` pushes a fix, CI
    // goes green while the run is still writing its comment and marker,
    // `pr.checks_passed` fires, and the merge route acts on a tree still being
    // rewritten. This route never read `runInFlight` at all.
    const d = resolveMergeDisposition(
      state({ checksState: "passing", runInFlight: { workflow: "dependabot-ci-fix", runId: "99" } }),
      deps,
    );
    expect(d.decision).toBe("skip");
    expect(d.reason).toMatch(/^run-in-flight: dependabot-ci-fix 99/);
    expect(d.runInFlight).toEqual({ workflow: "dependabot-ci-fix", runId: "99" });
  });
});

describe("resolveReviewTrigger", () => {
  const cases: Array<[string, Partial<PrState>, Partial<typeof review>, Parameters<typeof resolveReviewTrigger>[2], "dispatch" | "defer" | "skip", RegExp]> = [
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
    // DEFER, not skip: a label, a comment or the check's own Re-run button can
    // still ask, and `postsCheck` advertises exactly that with a `neutral` check.
    ["on-request with nobody asking defers", {}, { trigger: "on-request" }, {}, "defer", /^on-request:/],
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
      "defer",
      /^checks-pending:/,
    ],
    [
      "after-checks does not fire on PR attention alone",
      { checksState: "passing" },
      { trigger: "after-checks" },
      { route: "attention" },
      "defer",
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
    [
      // A check run that never CONCLUDES — a fork PR's `workflow_run` awaiting
      // maintainer approval, a dead self-hosted runner, a third-party app that
      // opened a check and crashed — leaves the aggregate `pending` with no
      // further `check_suite` ever coming. `pending` used to be evaluated
      // before the route, so the sweep deferred too and the PR was never
      // reviewed by ANY route; with `postsCheck` on, the `queued` placeholder
      // then sat there permanently and a repo that made `last-light/review`
      // required had an unmergeable PR. This is the packaged default.
      "the sweep releases a PR whose checks never settle",
      { checksState: "pending" },
      { trigger: "after-checks" },
      { route: "sweep" },
      "dispatch",
      /sweep route, checks pending$/,
    ],
    [
      // The exemption is the SWEEP's alone. A settle event that somehow arrives
      // with the aggregate still pending is a genuine "not yet" — another suite
      // is still running and one is coming.
      "a settle event still waits while another suite is running",
      { checksState: "pending" },
      { trigger: "after-checks" },
      { route: "checks-settled" },
      "defer",
      /^checks-pending:/,
    ],
    [
      // The lock outranks the explicit request, unlike every other review skip:
      // it is not policy but a physical constraint (one workspace, one branch,
      // one agent). The dispatcher replies to the human instead.
      "an explicit @bot review does NOT override the run lock",
      { runInFlight: { workflow: "pr-fix", runId: "4821" } },
      { trigger: "eager" },
      { explicitRequest: true },
      "skip",
      /^run-in-flight: pr-fix 4821/,
    ],
    [
      // The cron is a candidate FINDER; the mode is still enforced here, so a
      // repo on `on-request` gets no sweep-driven review. That is the property
      // that made a third implementation of `review.trigger` unnecessary.
      "the sweep respects on-request — no mode is enforced in the discoverer",
      { checksState: "passing" },
      { trigger: "on-request" },
      { route: "sweep" },
      "defer",
      /^on-request:/,
    ],
    [
      // The cron's old draft filter, now decided here for every route.
      "the sweep respects skipDraft too",
      { isDraft: true, checksState: "passing" },
      { trigger: "after-checks" },
      { route: "sweep" },
      "skip",
      /^draft:/,
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

  it("routes pr-review through the review trigger — every route crosses ONE gate", () => {
    const d = resolveDispatchDisposition(
      "pr-review",
      state({ isDraft: true, botReviewAtHead: { state: "APPROVED" } }),
      cfg,
    );
    expect(d.decision).toBe("skip");
    expect(d.reason).toMatch(/^draft:/);
    // The UNDEGRADED verdict rides along, because "do not run" and "what should
    // the check say" are different questions with different answers.
    expect(d.review).toBe("skip");
  });

  it("collapses a review `defer` to skip for dispatch, while carrying it for the check", () => {
    const d = resolveDispatchDisposition(
      "pr-review",
      state({ checksState: "passing" }),
      { ...cfg, review: { ...review, trigger: "after-checks" } },
      { route: "attention" },
    );
    expect(d.decision).toBe("skip");
    expect(d.review).toBe("defer");
    expect(reviewCheckPlacement(d.review!, { ...review, trigger: "after-checks" })).toBe("queued");
  });

  it("dispatches a review on a settled suite, and asks for an in-progress check", () => {
    const d = resolveDispatchDisposition(
      "pr-review",
      state({ checksState: "failing" }),
      { ...cfg, review: { ...review, trigger: "after-checks" } },
      { route: "checks-settled" },
    );
    expect(d.decision).toBe("run");
    expect(d.review).toBe("dispatch");
    expect(reviewCheckPlacement(d.review!, review)).toBe("in-progress");
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

  it("supplies the budget variables the fix prompts already render", () => {
    // All three fix prompts render `{{#if maxAttempts}} of {{maxAttempts}}{{/if}}`
    // — dead until this projection provided it, so every prompt said "this is
    // attempt 2" and never "of 3", which is the half that says spend or stop.
    const ctx = renderContext(state({ attempt: 2, flakyDeferrals: 1 }), fix);
    expect(ctx.attempt).toBe(2);
    expect(ctx.maxAttempts).toBe(fix.maxAttempts);
    expect(ctx.maxFlakyDeferrals).toBe(fix.maxFlakyDeferrals);
    expect(ctx.flakyPromoted).toBe(false);
  });

  it("flags the flaky promotion once the deferrals reach the cap", () => {
    const ctx = renderContext(state({ flakyDeferrals: fix.maxFlakyDeferrals }), fix);
    expect(ctx.flakyPromoted).toBe(true);
  });

  it("omits the budget variables when no policy is passed", () => {
    // `{{#if maxAttempts}}` must render nothing rather than "of undefined".
    const ctx = renderContext(state());
    expect(ctx.maxAttempts).toBeUndefined();
    expect(ctx.flakyPromoted).toBe(false);
  });

  // The merge prompt used to re-derive the gate from `checksSettledPassing`.
  // Projecting the decision itself is what stops the prompt's reading drifting
  // from the predicate's — these are the two cases where they disagreed.
  it("projects the merge gate as one decision, with the reason it produced", () => {
    const deps = defaultDependenciesConfig();
    const ctx = renderContext(
      state({ checksState: "passing", settledCheckCount: 3 }),
      fix,
      deps,
    );
    expect(ctx.mayMerge).toBe(true);
    expect(ctx.mayMergeReason).toBe(mayMerge(state({ checksState: "passing", settledCheckCount: 3 }), deps).reason);
  });

  it("projects a gate that disagrees with checksSettledPassing in both directions", () => {
    // Green checks, but fewer than the operator's floor: passing, yet shut.
    const strict = renderContext(
      state({ checksState: "passing", settledCheckCount: 1 }),
      fix,
      { ...defaultDependenciesConfig(), minSettledChecks: 3 },
    );
    expect(strict.checksSettledPassing).toBe(true);
    expect(strict.mayMerge).toBe(false);

    // Red checks, but this deployment turned the gate off: failing, yet open.
    const off = renderContext(state({ checksState: "failing" }), fix, {
      ...defaultDependenciesConfig(),
      requireSettledChecks: false,
    });
    expect(off.checksSettledPassing).toBe(false);
    expect(off.mayMerge).toBe(true);
  });

  it("omits the gate entirely when no dependencies policy is passed", () => {
    const ctx = renderContext(state({ checksState: "passing" }));
    expect(ctx.mayMerge).toBeUndefined();
    expect(ctx.mayMergeReason).toBeUndefined();
  });
});
