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
  holdReply,
  mayMerge,
  resolveFixDisposition,
  resolveMergeDisposition,
  resolveReviewTrigger,
  resolveDispatchDisposition,
  reviewCheckPlacement,
  renderContext,
  isGeneratedPath,
  allPathsGenerated,
  hasMaterialChange,
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
    lastBotReview: null,
    pathsSinceLastBotReview: null,
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
      // The ONE read whose failure is not fail-open. `getPullRequest` supplies
      // `labels`, `isFork`, `isDraft` and `headSha`, and every degraded value is
      // the PERMISSIVE one — `labels: []` so the hold does not apply, `isFork:
      // false` so the fork guard does not, `headSha: ""` so the dedup does not.
      // A 403 therefore yields a snapshot that LOOKS healthy, and the cron route
      // then dispatches a repo-write sandbox run against a PR we cannot see.
      "an unreadable PULL REQUEST skips — every guard below would be reading defaults",
      { readErrors: ["getPullRequest: 403 Forbidden"], labels: [], headSha: "" },
      {},
      {},
      "skip",
      /^read-degraded: could not read the pull request/,
    ],
    [
      // Transient, so it must outrank even a fork PR's own explanation: we do
      // not know that it IS a fork.
      "the degraded read outranks the fork guard, because `isFork: false` is a default too",
      { readErrors: ["getPullRequest: 502"], isFork: true },
      {},
      {},
      "skip",
      /^read-degraded:/,
    ],
    [
      // THE behaviour change of 02-hold-label.md. `requires-human` was the only
      // label read as a decision input, and the read inferred WHOSE it was from
      // "have we ever run on this PR" — so a maintainer's hand-applied label was
      // honoured only on a PR the bot had never touched. Nothing reads it now.
      // The hold a maintainer actually wants is its own label, below.
      "a hand-applied requires-human holds nothing — it is a notification",
      { labels: ["requires-human"] },
      {},
      {},
      "run",
      /^attempt/,
    ],
    [
      "our own escalation binds while the head is the one we escalated at",
      { escalatedAtSha: "abcdef1234567890" },
      {},
      {},
      "skip",
      /^escalated: we escalated this PR at abcdef1/,
    ],
    [
      "...and while the only commit since is one WE authored",
      { escalatedAtSha: "0000000", headIsOurs: true },
      {},
      {},
      "skip",
      /^escalated:/,
    ],
    [
      // The behaviour a human expects after being asked to intervene: a push
      // re-arms the loop with no label to remove.
      "a maintainer's push clears our escalation without touching the label",
      { escalatedAtSha: "0000000", headIsOurs: false },
      {},
      {},
      "run",
      /^attempt/,
    ],
    [
      "...as does an explicit @bot request at the same head",
      { escalatedAtSha: "abcdef1234567890" },
      {},
      { explicitRequest: true },
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
    // (`escalated`), or a duplicate delivery (`already-assessed`): each would
    // put a label on a PR nobody needs to look at, or comment again on every
    // subsequent event.
    const escalating = (over: Partial<PrState>, opts = {}) =>
      resolveFixDisposition(state(over), fix, opts).escalation;

    expect(escalating({ attempt: 4 })).toBe("attempts-exhausted");
    expect(escalating({ cumulativeCostUsd: 99 })).toBe("budget-exhausted");
    expect(escalating({ attempt: 2, priorDiagnosisClass: "infra-dependent" })).toBe("not-retryable");

    expect(escalating({ baseChecksState: "failing" })).toBeUndefined();
    expect(escalating({ isFork: true })).toBeUndefined();
    expect(
      escalating({ escalatedAtSha: "abcdef1234567890", attempt: 9 }),
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
    // `.git/lastlight-verify.sh`.
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
      // The same behaviour change as on the fix route: nothing reads the label.
      "a hand-applied requires-human does not block a merge either",
      { checksState: "passing", labels: ["requires-human"] },
      {},
      "run",
      /^checks passing$/,
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

  it("our own escalation is still binding while the head has not moved", () => {
    const d = resolveMergeDisposition(
      state({
        checksState: "passing",
        labels: ["requires-human"],
        escalatedAtSha: "abcdef1234567890",
        headSha: "abcdef1234567890",
      }),
      deps,
    );
    expect(d.decision).toBe("skip");
    expect(d.reason).toMatch(/^escalated: we escalated this PR at abcdef1/);
  });

  it("OUR OWN fix commit clears the escalation — it is the resolution, not a repeat", () => {
    // The `#239` shape, and the reason the merge route must NOT inherit
    // `resolveFixDisposition`'s `|| state.headIsOurs`: we escalated at an old
    // head, `dependabot-ci-fix` then pushed a fix, and CI went green. The whole
    // ci-fix → `pr.checks_passed` → merge handoff ends with our commit at the
    // head, so treating that as "nothing has changed" made the handoff
    // unreachable for every PR we had ever escalated.
    const d = resolveMergeDisposition(
      state({
        checksState: "passing",
        labels: ["requires-human"],
        escalatedAtSha: "fe5bc73aaaaaaaaa",
        headSha: "099bca81bbbbbbbb",
        headAuthor: "last-light[bot]",
        headIsOurs: true,
      }),
      deps,
    );
    expect(d.decision).toBe("run");
    expect(d.reason).toMatch(/^checks passing$/);
  });

  it("but that same PR is bounded to ONE assessment per head SHA", () => {
    // What replaces the guard we just dropped: the merge run assesses the fix
    // commit once, records it, and every later dispatch at that head dedups.
    const d = resolveMergeDisposition(
      state({
        checksState: "passing",
        labels: ["requires-human"],
        escalatedAtSha: "fe5bc73aaaaaaaaa",
        headSha: "099bca81bbbbbbbb",
        headIsOurs: true,
        assessedHeadShaByWorkflow: { "dependabot-pr-merge": "099bca81bbbbbbbb" },
      }),
      deps,
      { dedupOnHeadSha: true },
    );
    expect(d.decision).toBe("skip");
    expect(d.reason).toMatch(/^already-assessed: dependabot-pr-merge/);
  });

  it("and re-escalating at the new head stops it again", () => {
    // The other half of the bound: a merge run that declines re-stamps
    // `escalatedAtSha` at the head it just assessed, so the guard above catches
    // the very next dispatch even with nothing in `assessedHeadShaByWorkflow`.
    const d = resolveMergeDisposition(
      state({
        checksState: "passing",
        labels: ["requires-human"],
        escalatedAtSha: "099bca81bbbbbbbb",
        headSha: "099bca81bbbbbbbb",
        headIsOurs: true,
      }),
      deps,
    );
    expect(d.decision).toBe("skip");
    expect(d.reason).toMatch(/^escalated:/);
  });

  it("the FIX route keeps `headIsOurs` — our retry is the same problem there", () => {
    // The clause is dropped on the merge route ONLY. On the fix route it is
    // load-bearing: without it our own retry push would re-arm the attempt
    // counter forever.
    const d = resolveFixDisposition(
      state({
        checksState: "failing",
        labels: ["requires-human"],
        escalatedAtSha: "fe5bc73aaaaaaaaa",
        headSha: "099bca81bbbbbbbb",
        headIsOurs: true,
      }),
      deps,
    );
    expect(d.decision).toBe("skip");
    expect(d.reason).toMatch(/^escalated:/);
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

/**
 * The generated-only re-review gate (issue #271).
 *
 * Per-head dedup was the ONLY suppression gate, so every new head SHA earned a
 * full formal review — and a lock file re-derivation is a new head SHA.
 * nearform/skillspro#1641 posted two byte-identical APPROVEs six minutes apart
 * for exactly that.
 *
 * Every case below is really about the SAFETY DIRECTION: the gate may only ever
 * suppress on positive evidence that the delta is entirely derived, so each
 * degraded or ambiguous input has to dispatch.
 */
describe("resolveReviewTrigger — nothing new to say", () => {
  /** A PR whose head moved past a review we posted, with `paths` in between. */
  const moved = (paths: string[] | null, over: Partial<PrState> = {}) =>
    state({
      checksState: "passing",
      lastBotReview: { state: "APPROVED", sha: "0ld5ha0000000000" },
      pathsSinceLastBotReview: paths,
      ...over,
    });

  const eager = { ...review, trigger: "eager" as const };

  it("skips a push that only re-derived the lock file", () => {
    const d = resolveReviewTrigger(moved(["pnpm-lock.yaml"]), eager);
    expect(d.decision).toBe("skip");
    expect(d.reason).toMatch(/^generated-only: the 1 file changed since we reviewed 0ld5ha0/);
    // The typed field, not the prose, is what carries the prior verdict onto
    // the new head's check run.
    expect(d.reviewUnchanged).toEqual({ sha: "0ld5ha0000000000", state: "APPROVED" });
  });

  it("skips a whole workspace's worth of lock files", () => {
    const d = resolveReviewTrigger(
      moved(["pnpm-lock.yaml", "packages/a/package-lock.json", "go.sum"]),
      eager,
    );
    expect(d.decision).toBe("skip");
    expect(d.reason).toMatch(/^generated-only: the 3 files/);
  });

  it("dispatches when ONE hand-written file rode along", () => {
    const d = resolveReviewTrigger(moved(["pnpm-lock.yaml", "src/auth.ts"]), eager);
    expect(d.decision).toBe("dispatch");
    expect(d.reviewUnchanged).toBeUndefined();
  });

  // Every remaining case is a degraded read. The delta is the only evidence
  // that a re-review would be pointless, so anything less than a complete,
  // trusted list has to dispatch — a review we didn't need costs $0.22, a
  // review we skipped wrongly costs the bug.
  it("dispatches when the compare read failed or was truncated (null)", () => {
    expect(resolveReviewTrigger(moved(null), eager).decision).toBe("dispatch");
  });

  it("dispatches on an empty delta — 'nothing changed' is not evidence", () => {
    expect(resolveReviewTrigger(moved([]), eager).decision).toBe("dispatch");
  });

  it("dispatches when the operator emptied review.generatedPaths — that IS the off switch", () => {
    const d = resolveReviewTrigger(moved(["pnpm-lock.yaml"]), { ...eager, generatedPaths: [] });
    expect(d.decision).toBe("dispatch");
  });

  it("dispatches a FIRST review — no prior review means no baseline", () => {
    const d = resolveReviewTrigger(
      state({ checksState: "passing", pathsSinceLastBotReview: ["pnpm-lock.yaml"] }),
      eager,
    );
    expect(d.decision).toBe("dispatch");
  });

  // The gate sits BELOW the explicit-request branch on purpose: it answers "was
  // this push worth an unprompted review?", never "may a human ask?".
  it("an explicit @bot review overrides it", () => {
    const d = resolveReviewTrigger(moved(["pnpm-lock.yaml"]), eager, { explicitRequest: true });
    expect(d.decision).toBe("dispatch");
    expect(d.reason).toMatch(/^requested:/);
  });

  it("the request label overrides it too", () => {
    const d = resolveReviewTrigger(moved(["pnpm-lock.yaml"], { labels: ["needs-review"] }), {
      ...eager,
      trigger: "on-request",
      requestLabel: "needs-review",
    });
    expect(d.decision).toBe("dispatch");
    expect(d.reason).toMatch(/^requested: the `needs-review` label/);
  });

  // Ordering: per-head dedup still wins when it applies, because its reason is
  // the more specific one and `resolvePrState` doesn't even fetch the delta.
  it("stays behind the per-head dedup", () => {
    const d = resolveReviewTrigger(
      moved(["pnpm-lock.yaml"], { botReviewAtHead: { state: "APPROVED" } }),
      eager,
    );
    expect(d.reason).toMatch(/^already-reviewed:/);
  });

  it("projects onto a carried-over check so a required check is never missing", () => {
    const d = resolveDispatchDisposition("pr-review", moved(["pnpm-lock.yaml"]), {
      fix,
      dependencies: deps,
      review: eager,
    });
    expect(d.decision).toBe("skip");
    expect(d.review).toBe("skip");
    expect(d.reviewUnchanged).toEqual({ sha: "0ld5ha0000000000", state: "APPROVED" });
    expect(reviewCheckPlacement(d.review!, eager, { unchanged: true })).toBe("carried-over");
    // Any OTHER skip still leaves the PR alone.
    expect(reviewCheckPlacement("skip", eager)).toBe("none");
  });
});

describe("isGeneratedPath", () => {
  const patterns = defaultReviewConfig().generatedPaths;

  it.each([
    // A pattern with no `/` matches the BASENAME anywhere — which is what an
    // operator writing `pnpm-lock.yaml` means, and what a workspace monorepo
    // with one lock file per package needs.
    ["pnpm-lock.yaml", true],
    ["packages/cli/pnpm-lock.yaml", true],
    ["deep/nested/dir/yarn.lock", true],
    ["Cargo.lock", true],
    ["go.sum", true],
    ["static/app.min.js", true],
    ["src/api/types.generated.ts", true],
    ["src/__generated__/schema.ts", true],
    ["__generated__/schema.ts", true],
    // Hand-written code that merely LOOKS adjacent to the patterns.
    ["src/auth.ts", false],
    ["src/lock.ts", false],
    ["src/generated.ts", false],
    ["docs/go.sum.md", false],
    ["src/min.js", false],
  ])("%s → %s", (path, expected) => {
    expect(isGeneratedPath(path, patterns)).toBe(expected);
  });

  it("never lets a pattern act as a regex", () => {
    // `.` is escaped, so this matches the literal name and nothing else.
    expect(isGeneratedPath("goxsum", ["go.sum"])).toBe(false);
    expect(isGeneratedPath("go.sum", ["go.sum"])).toBe(true);
  });

  it("keeps `*` inside one path segment and lets `**` cross", () => {
    expect(isGeneratedPath("a/b/c.pb.go", ["*.pb.go"])).toBe(true); // basename rule
    expect(isGeneratedPath("a/b/c.pb.go", ["gen/*.pb.go"])).toBe(false);
    expect(isGeneratedPath("gen/c.pb.go", ["gen/*.pb.go"])).toBe(true);
    expect(isGeneratedPath("gen/deep/c.pb.go", ["gen/*.pb.go"])).toBe(false);
    expect(isGeneratedPath("gen/deep/c.pb.go", ["gen/**"])).toBe(true);
  });

  // The two predicates are mirrors, not negations: both refuse to answer `true`
  // on a degraded read, because both are asked by a caller looking for
  // permission to suppress something.
  it("answers false in both directions for a degraded delta", () => {
    for (const delta of [null, []]) {
      expect(allPathsGenerated(delta, patterns)).toBe(false);
      expect(hasMaterialChange(delta, patterns)).toBe(false);
    }
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

/**
 * The HOLD label (02-hold-label.md) — *"Last Light, stay off this."*
 *
 * A LIVE precondition rather than a stored verdict, which is the whole reason it
 * is a label: present or absent right now, nothing persisted, nothing to
 * migrate, and removing it resumes the bot with no record to clean up. It also
 * replaces the one place `requires-human` was read as a decision input, which is
 * what makes that label a pure notification.
 *
 * Every case here is really about ORDERING. The hold is only a block if it
 * outranks the run lock, the fork check, the budgets and an explicit request —
 * and it must NOT outrank "we could not read the pull request at all", because
 * `labels: []` is exactly what that failure degrades to.
 */
describe("resolveDispatchDisposition — the hold label", () => {
  const cfg = { fix, dependencies: deps, review };
  const HOLD = "lastlight-ignore";
  const held = (over: Partial<PrState> = {}) => state({ labels: [HOLD], ...over });

  it("blocks every PR-scoped workflow, silently", () => {
    // Locked decision 3: one word, one meaning. A hold that some workflows
    // honoured and others did not would be a label nobody could remember the
    // scope of, which is a label nobody reaches for.
    for (const w of ["pr-fix", "dependabot-ci-fix", "dependabot-pr-merge", "pr-review"]) {
      const d = resolveDispatchDisposition(w, held({ checksState: "passing" }), cfg);
      expect(d.decision).toBe("skip");
      expect(d.reason).toMatch(/^on-hold: `lastlight-ignore` is applied/);
      // A typed field, like `escalation` and `runInFlight` — the caller must
      // not parse the prose. It carries the LABEL, because naming it is the
      // only useful thing to say to whoever asked.
      expect(d.onHold).toEqual({ label: HOLD });
      // NOTHING is applied. No label, no comment, no run row (no
      // `EscalationCase`), and — for `pr-review` — no placeholder check either,
      // since `postReviewCheckForSkip` is keyed on `review` being present.
      expect(d.escalation).toBeUndefined();
      expect(d.review).toBeUndefined();
    }
  });

  it("blocks a workflow no disposition governs, too", () => {
    // The `ungated` fallback. The hold is an instruction about the SUBJECT, not
    // a verdict about a fix / merge / review, so it has to read the same
    // whichever branch would otherwise have answered.
    const d = resolveDispatchDisposition("build", held(), cfg);
    expect(d.decision).toBe("skip");
    expect(d.onHold).toEqual({ label: HOLD });
  });

  it("beats an explicit @bot request — otherwise it is not a block", () => {
    // Locked decision 4. The one thing the request earns is a REPLY, and that
    // belongs to the route with a human on the other end, not to this decision.
    const d = resolveDispatchDisposition("pr-fix", held(), cfg, { explicitRequest: true });
    expect(d.decision).toBe("skip");
    expect(d.reason).toMatch(/^on-hold:/);
  });

  it("beats the run lock, and is the reason reported", () => {
    // Above the lock on purpose: the lock says "come back later" and the hold
    // says "do not come back". Reporting the transient one would be true and
    // useless.
    const d = resolveDispatchDisposition(
      "pr-fix",
      held({ runInFlight: { workflow: "pr-review", runId: "4821" } }),
      cfg,
    );
    expect(d.reason).toMatch(/^on-hold:/);
    expect(d.runInFlight).toBeUndefined();
  });

  it("beats the fork guard and both budgets", () => {
    // Labelling `requires-human` and commenting on a PR a maintainer has told
    // us to leave alone is the exact opposite of what the label asked for, so
    // the hold has to sit above the three escalating skips.
    const d = resolveDispatchDisposition(
      "pr-fix",
      held({ isFork: true, attempt: 9, cumulativeCostUsd: 99, priorDiagnosisClass: "infra-dependent" }),
      cfg,
    );
    expect(d.reason).toMatch(/^on-hold:/);
    expect(d.escalation).toBeUndefined();
    expect(d.forkPr).toBeUndefined();
  });

  it("LOSES to a degraded read — `labels: []` is what that failure looks like", () => {
    // The one guard above it. When `getPullRequest` fails we do not know
    // whether the hold is there; reporting "on hold" off a default would be a
    // statement made on no information, and it would hide the real problem.
    const d = resolveDispatchDisposition(
      "pr-fix",
      state({ labels: [], readErrors: ["getPullRequest: 403 Forbidden"] }),
      cfg,
    );
    expect(d.reason).toMatch(/^read-degraded:/);
    expect(d.onHold).toBeUndefined();
    expect(d.readDegraded).toBe(true);
  });

  it("...and a degraded read on a pr-review still carries the check verdict", () => {
    // The degraded probe above the hold must not flatten the per-workflow
    // disposition: `postReviewCheckForSkip` keys on `review`, and the caller
    // needs `readDegraded` to know not to post a placeholder against a head SHA
    // it does not have.
    const d = resolveDispatchDisposition(
      "pr-review",
      state({ labels: [], readErrors: ["getPullRequest: 502"] }),
      cfg,
    );
    expect(d.review).toBe("skip");
    expect(d.readDegraded).toBe(true);
  });

  it("removing it re-dispatches, with no record to clear", () => {
    // The property that makes a label the right shape for this: it is
    // idempotent and live, so "last one wins" never has to be applied and there
    // is nothing to un-persist. The SAME snapshot minus the label runs.
    const s = held({ checksState: "failing" });
    expect(resolveDispatchDisposition("pr-fix", s, cfg).decision).toBe("skip");
    expect(
      resolveDispatchDisposition("pr-fix", { ...s, labels: [] }, cfg).decision,
    ).toBe("run");
  });

  it("honours the operator's configured name, and only that name", () => {
    const s = state({ labels: ["do-not-touch"] });
    expect(resolveDispatchDisposition("pr-fix", s, cfg).decision).toBe("run");
    expect(
      resolveDispatchDisposition("pr-fix", s, { ...cfg, holdLabel: "do-not-touch" }).decision,
    ).toBe("skip");
    // …and the packaged default no longer applies once renamed.
    expect(
      resolveDispatchDisposition("pr-fix", held(), { ...cfg, holdLabel: "do-not-touch" }).decision,
    ).toBe("run");
  });

  it("names the label in the one reply it ever produces", () => {
    // The label IS the remedy, and it is operator-configurable, so the prose
    // cannot carry it as a literal.
    expect(holdReply("do-not-touch")).toContain("`do-not-touch`");
    expect(holdReply(HOLD)).toMatch(/remove the label/i);
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
    expect(ctx.ciLogsUnavailable).toBe(false);
  });

  it("distinguishes 'the log download failed' from 'there was nothing to fetch'", () => {
    // Not the negation of `ciLogsAvailable`, which is also false on a green PR.
    // `prompts/diagnose-ci.md` branches on this one, so getting it wrong warns
    // "the harness could not download the job logs" on a PR with no failures.
    const failed = renderContext(state({ ciReport: { jobs: [], logsAvailable: false } }));
    expect(failed.ciLogsAvailable).toBe(false);
    expect(failed.ciLogsUnavailable).toBe(true);

    const nothingToFetch = renderContext(state({ checksState: "passing", ciReport: null }));
    expect(nothingToFetch.ciLogsAvailable).toBe(false);
    expect(nothingToFetch.ciLogsUnavailable).toBe(false);
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

/**
 * The read-degraded drop is transient, and the merge route is where that
 * matters most: enabling auto-merge is the one irreversible thing this codebase
 * does, and `mergeable_state`, the labels and the fork flag all come from the
 * read that failed.
 */
describe("resolveMergeDisposition — an unreadable pull request", () => {
  it("refuses to assess a PR whose read failed", () => {
    const decision = resolveMergeDisposition(
      state({ readErrors: ["getPullRequest: 404 Not Found"], checksState: "passing" }),
      defaultDependenciesConfig(),
    );

    expect(decision.decision).toBe("skip");
    expect(decision.readDegraded).toBe(true);
    expect(decision.reason).toMatch(/^read-degraded:/);
    // Transient, not terminal: nothing to label, nothing to comment.
    expect(decision.escalation).toBeUndefined();
  });

  it("names the failed read, so the log line says which call to look at", () => {
    const decision = resolveMergeDisposition(
      state({ readErrors: ["getPullRequest: 404 Not Found", "getChecksSummary: 502"] }),
      defaultDependenciesConfig(),
    );

    expect(decision.reason).toContain("404 Not Found");
    // Only the PR read is quoted — the others still fail open, so naming them
    // here would suggest they had something to do with the refusal.
    expect(decision.reason).not.toContain("getChecksSummary");
  });

  it("still fails open on every other read", () => {
    const decision = resolveMergeDisposition(
      state({
        readErrors: ["getChecksSummary: 502", "getBaseChecksState: 502"],
        checksState: "passing",
        settledCheckCount: 3,
      }),
      defaultDependenciesConfig(),
    );

    expect(decision.readDegraded).toBeUndefined();
    expect(decision.decision).toBe("run");
  });
});

describe("resolveReviewTrigger — an unreadable pull request", () => {
  it("skips rather than defers, because a deferral is a claim about a head SHA", () => {
    // `defer` posts the placeholder check that says "not yet" against the head
    // — and we do not reliably know the head.
    const decision = resolveReviewTrigger(
      state({ readErrors: ["getPullRequest: 403"], headSha: "" }),
      defaultReviewConfig(),
    );

    expect(decision.decision).toBe("skip");
    expect(decision.readDegraded).toBe(true);
  });

  it("outranks an explicit request — asking does not make the PR readable", () => {
    const decision = resolveReviewTrigger(
      state({ readErrors: ["getPullRequest: 403"] }),
      defaultReviewConfig(),
      { explicitRequest: true },
    );

    expect(decision.decision).toBe("skip");
    expect(decision.readDegraded).toBe(true);
  });
});

/**
 * What a retry does **not** override (03-retry-intervention.md).
 *
 * A recorded retry re-arms the two budgets, and that is all it does. Every
 * other guard is either a FACT about the pull request (a fork has no branch to
 * push to, a red base cannot be made green from here) or an instruction that
 * outranks it (the hold), and none of them cares how nicely you ask. The
 * distinction is the same one the explicit-request carve-out has always drawn:
 * policy yields to a maintainer, facts do not.
 *
 * These are pure table tests: `applyDerivedState` has already done the re-arming
 * by the time any of this runs, so a fixture with an `intervention` and
 * `attempt: 1` is exactly what the resolver would be handed.
 */
describe("resolveFixDisposition — what a retry does not override", () => {
  const RETRY = {
    at: "2026-08-02T10:00:00.000Z",
    atSha: "abcdef1234567890",
    via: "comment" as const,
    by: "alice",
    note: "arm64 runner was flaky",
  };
  /** A PR whose budgets a retry has just re-armed. */
  const retried = (over: Partial<PrState> = {}) =>
    state({ intervention: RETRY, escalatedAtSha: null, attempt: 1, cumulativeCostUsd: 0, ...over });

  it("re-arms the PR it is recorded on — the control case", () => {
    const d = resolveFixDisposition(retried(), fix, { dedupOnHeadSha: true });
    expect(d.decision).toBe("run");
    expect(d.reason).toBe("attempt 1/3");
    // Carried on `inputs` for the run detail panel — WHO asked and why the
    // budgets look freshly armed — and read by no branch.
    expect(d.inputs.intervention).toEqual(RETRY);
  });

  it("does not override the HOLD label", () => {
    // Locked decision 4, and the single case where "a maintainer asked and was
    // not obeyed" is intentional — which is why the route owes them a reply.
    const d = resolveDispatchDisposition(
      "pr-fix",
      retried({ labels: ["lastlight-ignore"] }),
      { fix, dependencies: deps, review },
    );
    expect(d.decision).toBe("skip");
    expect(d.onHold).toEqual({ label: "lastlight-ignore" });
    expect(d.escalation).toBeUndefined();
  });

  it("does not override the fork guard", () => {
    const d = resolveFixDisposition(
      retried({ isFork: true, headRepoFullName: "octocat/lastlight" }),
      fix,
    );
    expect(d.decision).toBe("skip");
    expect(d.reason).toMatch(/^fork-pr:/);
    expect(d.forkPr).toBe(true);
  });

  it("does not override the run lock", () => {
    // Not policy but a physical constraint: one workspace, one branch, one
    // agent. The cron re-pickup is what makes dropping sound.
    const d = resolveFixDisposition(
      retried({ runInFlight: { workflow: "pr-fix", runId: "run-1" } }),
      fix,
    );
    expect(d.decision).toBe("skip");
    expect(d.reason).toMatch(/^run-in-flight:/);
  });

  it("does not override `upstream-broken`", () => {
    // A fact, not a verdict: re-running against a red base cannot make CI
    // green. It self-heals, and the retry is recorded so it survives the wait.
    const d = resolveFixDisposition(retried({ baseChecksState: "failing" }), fix);
    expect(d.decision).toBe("skip");
    expect(d.reason).toMatch(/^upstream-broken:/);
    expect(d.escalation).toBeUndefined();
  });

  it("does not override a degraded read", () => {
    // "We could not read the pull request" outranks every reading of it —
    // including the one that says a human asked.
    const d = resolveFixDisposition(
      retried({ readErrors: ["getPullRequest: 403"], headSha: "" }),
      fix,
    );
    expect(d.decision).toBe("skip");
    expect(d.readDegraded).toBe(true);
  });
});
