/**
 * The derived half of the PR state machine, driven as a SEQUENCE OF RUNS.
 *
 * `attempt`, `priorAttempts` and `flakyDeferrals` are not readable from one
 * snapshot — each is a fold over the PR's run history, and the defects they
 * exist to prevent are all sequences: a crashed run silently burning the
 * budget, a flaky test deferring forever, a maintainer's push failing to re-arm
 * an exhausted PR. So these tests replay real sequences through the actual
 * transport (harvest → `scratch` → `latestForTrigger` → `applyDerivedState`)
 * rather than hand-constructing the intermediate state.
 */

import { describe, it, expect, vi } from "vitest";
import type { StateDb } from "#src/state/db.js";
import type { WorkflowRun } from "#src/state/workflow-run-store.js";
import {
  applyDerivedState,
  resolvePrState,
  type PrState,
  type PrStateDeps,
} from "#src/engine/pr-state.js";
import { harvestFixMarkers, readHarvestedMarkers } from "#src/engine/fix-harvest.js";
import { resolveFixDisposition } from "#src/engine/pr-decisions.js";
import { REQUIRES_HUMAN_LABEL } from "#src/cron/dependabot-discovery.js";
import { defaultFixConfig } from "#src/config/config.js";

const BOT = "last-light[bot]";
const TRIGGER = "cliftonc/lastlight#190";

/** The live half of a snapshot — everything `resolvePrState` reads off GitHub. */
function liveState(over: Partial<PrState> = {}): PrState {
  return {
    repo: "cliftonc/lastlight",
    prNumber: 190,
    headSha: "aaaa111",
    headAuthor: "dependabot[bot]",
    headIsOurs: false,
    headRef: "dependabot/npm/lodash-4.17.21",
    baseRef: "main",
    isDraft: false,
    isFork: false,
    headRepoFullName: "cliftonc/lastlight",
    labels: [],
    title: "Bump lodash",
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

/**
 * An in-memory stand-in for the two stores `applyDerivedState` reads, plus the
 * `dispatch` / `finish` pair that drives a run through its whole life.
 *
 * `ledgerSaysDiagnosed` is the pre-harvest fallback: it stands for the
 * `diagnose` ledger row a run written before this feature would have left.
 */
function harness(opts: { ledgerSaysDiagnosed?: boolean } = {}) {
  const rows: WorkflowRun[] = [];
  const db = {
    runs: {
      activeForTrigger: () => null,
      latestSucceededForTriggers: () => ({}),
      latestForTrigger: () => (rows.length > 0 ? rows[rows.length - 1] : null),
      getRun: (id: string) => rows.find((r) => r.id === id) ?? null,
      mergeScratch: (id: string, patch: Record<string, unknown>) => {
        const row = rows.find((r) => r.id === id);
        if (row) row.scratch = { ...(row.scratch ?? {}), ...patch };
      },
    },
    executions: {
      costForTriggerWorkflows: () => 0,
      phaseSucceededInRun: () => opts.ledgerSaysDiagnosed ?? false,
    },
  } as unknown as StateDb;

  const deps: PrStateDeps = { github: null, db, botLogin: BOT };

  /** Resolve the derived half for a new dispatch and persist the run row. */
  async function dispatch(over: Partial<PrState> = {}): Promise<{ id: string; state: PrState }> {
    const state = liveState(over);
    await applyDerivedState(state, deps);
    const id = `run-${rows.length + 1}`;
    rows.push({
      id,
      workflowName: "dependabot-ci-fix",
      triggerId: TRIGGER,
      currentPhase: "diagnose",
      phaseHistory: [],
      status: "running",
      context: { prState: state },
      startedAt: new Date(rows.length * 1000).toISOString(),
      updatedAt: new Date(rows.length * 1000).toISOString(),
    });
    return { id, state };
  }

  /** Feed a phase's output through the real `onPhaseEnd` harvest. */
  async function finish(id: string, phase: string, output: string): Promise<void> {
    await harvestFixMarkers(db, id, "dependabot-ci-fix", phase, output);
  }

  /**
   * A run row as a build BEFORE `context.prState` existed left it: no snapshot,
   * no harvest, at most the bare `headSha` the old context carried. Every PR
   * already labelled `requires-human` at upgrade has rows of exactly this shape.
   */
  function recordLegacyRun(context: Record<string, unknown> = {}): string {
    const id = `legacy-${rows.length + 1}`;
    rows.push({
      id,
      workflowName: "dependabot-ci-fix",
      triggerId: TRIGGER,
      currentPhase: "fix",
      phaseHistory: [],
      status: "succeeded",
      context,
      startedAt: new Date(rows.length * 1000).toISOString(),
      updatedAt: new Date(rows.length * 1000).toISOString(),
    } as WorkflowRun);
    return id;
  }

  return { rows, db, deps, dispatch, finish, recordLegacyRun };
}

const diagnosis = (cls: string, cause = "the lockfile is stale") =>
  `DIAGNOSIS_COMPLETE: pr=190 attempt=1 class=${cls} cause=${cause} ci_vs_local=none`;
const fixOutcome = (outcome: string, gate: string) =>
  `CI_FIX_COMPLETE: pr=190 attempt=1 outcome=${outcome} tried=stuff gate=${gate}`;

describe("applyDerivedState — the first dispatch", () => {
  it("starts at attempt 1 with an empty history", async () => {
    const h = harness();
    const { state } = await h.dispatch();
    expect(state.attempt).toBe(1);
    expect(state.priorAttempts).toEqual([]);
    expect(state.flakyDeferrals).toBe(0);
  });
});

describe("applyDerivedState — the attempt counter", () => {
  it("increments on a same-head retry and appends the prior attempt's line", async () => {
    const h = harness();
    const first = await h.dispatch();
    await h.finish(first.id, "diagnose", diagnosis("reproducible"));
    await h.finish(first.id, "fix", fixOutcome("gave-up", "red"));

    const second = await h.dispatch();
    expect(second.state.attempt).toBe(2);
    expect(second.state.priorAttempts).toEqual([
      "attempt 1: class=reproducible cause=the lockfile is stale | outcome=gave-up gate=red",
    ]);
  });

  it("increments when WE authored the new head — our fix landed, CI is still red", async () => {
    const h = harness();
    const first = await h.dispatch();
    await h.finish(first.id, "diagnose", diagnosis("reproducible"));
    await h.finish(first.id, "fix", fixOutcome("pushed", "green"));

    const second = await h.dispatch({ headSha: "bbbb222", headAuthor: BOT, headIsOurs: true });
    expect(second.state.attempt).toBe(2);
    expect(second.state.priorAttempts).toHaveLength(1);
  });

  it("resets to 1 — and clears the journal — when SOMEONE ELSE pushes", async () => {
    // A maintainer's push, a Dependabot rebase, a Renovate recreate. The world
    // moved, so the counter, the journal and the deferral count all describe a
    // problem that no longer exists — and a prompt that says "attempt 1" while
    // recounting three of them is incoherent.
    const h = harness();
    const first = await h.dispatch();
    await h.finish(first.id, "diagnose", diagnosis("reproducible"));
    const second = await h.dispatch();
    expect(second.state.attempt).toBe(2);
    await h.finish(second.id, "diagnose", diagnosis("flaky"));

    const third = await h.dispatch({ headSha: "cccc333", headAuthor: "octocat", headIsOurs: false });
    expect(third.state.attempt).toBe(1);
    expect(third.state.priorAttempts).toEqual([]);
    expect(third.state.flakyDeferrals).toBe(0);
  });

  it("a CRASHED run costs nothing — no marker, no increment, no line", async () => {
    // The single most important robustness rule in the design: without it, one
    // bad hour escalates every open dependency PR in every managed repo.
    const h = harness();
    const first = await h.dispatch();
    await h.finish(first.id, "diagnose", "the sandbox failed to provision");

    const second = await h.dispatch();
    expect(second.state.attempt).toBe(1);
    expect(second.state.priorAttempts).toEqual([]);
  });

  it("a run that never reached onPhaseEnd falls back to the ledger probe", async () => {
    // Upgrade compatibility: a run row written before the harvest existed (or
    // one that died before its first phase ended) carries no `fixMarkers` key
    // at all, and must not be read as "spent nothing".
    const h = harness({ ledgerSaysDiagnosed: true });
    await h.dispatch();
    expect((await h.dispatch()).state.attempt).toBe(2);
  });

  it("a run that HARVESTED but parsed nothing still charges the attempt", async () => {
    // The counter that could never advance. `harvestFixMarkers` writes its
    // namespace unconditionally for the fix family, so a malformed marker leaves
    // a NON-null harvest carrying `diagnosis: null` — and reading that as "no
    // harvest happened, so nothing was spent" pinned the PR at attempt 1 for its
    // whole life, with `fix.maxCostUsd` as the only remaining brake.
    //
    // The ledger decides instead: a SUCCEEDED `diagnose` row cannot exist
    // without a well-formed marker, because the phase carries
    // `requires_marker: "DIAGNOSIS_COMPLETE:"`.
    const h = harness({ ledgerSaysDiagnosed: true });
    const first = await h.dispatch();
    await h.finish(first.id, "diagnose", "DIAGNOSIS_COMPLETE without a colon, so nothing parses");

    // The harvest DID run — this is not the "no namespace" case.
    expect(readHarvestedMarkers(await h.db.runs.getRun(first.id))).not.toBeNull();
    expect(readHarvestedMarkers(await h.db.runs.getRun(first.id))?.diagnosis).toBeNull();
    expect((await h.dispatch()).state.attempt).toBe(2);
  });

  it("…but a genuinely crashed diagnose still costs nothing", async () => {
    // Same shape on the harvest side, opposite answer, and the ledger is what
    // tells them apart: a run whose `diagnose` never finished has no succeeded
    // row. Failing closed here is only safe because of that.
    const h = harness({ ledgerSaysDiagnosed: false });
    const first = await h.dispatch();
    await h.finish(first.id, "diagnose", "the sandbox failed to provision");
    expect((await h.dispatch()).state.attempt).toBe(1);
  });

  it("a `flaky` verdict costs no attempt", async () => {
    // 09 → S1's class table. `fix.maxFlakyDeferrals` is the bound instead — and
    // that counter would be unreachable if `flaky` also spent an attempt.
    const h = harness();
    const first = await h.dispatch();
    await h.finish(first.id, "diagnose", diagnosis("flaky", "network timeout on install"));
    const second = await h.dispatch();
    expect(second.state.attempt).toBe(1);
    // The line is still recorded — attempt 2 should know it already deferred.
    expect(second.state.priorAttempts).toEqual([
      "attempt 1: class=flaky cause=network timeout on install",
    ]);
  });

  it("an `upstream-broken` verdict costs no attempt", async () => {
    const h = harness();
    const first = await h.dispatch();
    await h.finish(first.id, "diagnose", diagnosis("upstream-broken", "base is red too"));
    expect((await h.dispatch()).state.attempt).toBe(1);
  });

  it("an `infra-dependent` verdict DOES cost an attempt", async () => {
    const h = harness();
    const first = await h.dispatch();
    await h.finish(first.id, "diagnose", diagnosis("infra-dependent", "needs a live postgres"));
    expect((await h.dispatch()).state.attempt).toBe(2);
  });

  it("an unrecognised class costs an attempt — fail closed", async () => {
    const h = harness();
    const first = await h.dispatch();
    await h.finish(first.id, "diagnose", diagnosis("probably-flaky"));
    expect((await h.dispatch()).state.attempt).toBe(2);
  });
});

describe("applyDerivedState — flakyDeferrals", () => {
  it("counts CONSECUTIVE flaky diagnoses", async () => {
    const h = harness();
    const first = await h.dispatch();
    expect(first.state.flakyDeferrals).toBe(0);
    await h.finish(first.id, "diagnose", diagnosis("flaky"));

    const second = await h.dispatch();
    expect(second.state.flakyDeferrals).toBe(1);
    await h.finish(second.id, "diagnose", diagnosis("flaky"));

    const third = await h.dispatch();
    // `fix.maxFlakyDeferrals: 2` — the next diagnosis is promoted.
    expect(third.state.flakyDeferrals).toBe(2);
  });

  it("resets to 0 on any non-flaky class", async () => {
    const h = harness();
    const first = await h.dispatch();
    await h.finish(first.id, "diagnose", diagnosis("flaky"));
    const second = await h.dispatch();
    expect(second.state.flakyDeferrals).toBe(1);

    await h.finish(second.id, "diagnose", diagnosis("reproducible"));
    expect((await h.dispatch()).state.flakyDeferrals).toBe(0);
  });

  it("a crash neither advances nor resets it — it says nothing about flakiness", async () => {
    const h = harness();
    const first = await h.dispatch();
    await h.finish(first.id, "diagnose", diagnosis("flaky"));
    const second = await h.dispatch();
    expect(second.state.flakyDeferrals).toBe(1);

    await h.finish(second.id, "diagnose", "sandbox provisioning failed");
    expect((await h.dispatch()).state.flakyDeferrals).toBe(1);
  });
});

describe("applyDerivedState — priorDiagnosisClass", () => {
  it("carries the LAST run's class, which is what the escalation gate reads", async () => {
    const h = harness();
    const first = await h.dispatch();
    await h.finish(first.id, "diagnose", diagnosis("infra-dependent", "needs a live postgres"));
    expect((await h.dispatch()).state.priorDiagnosisClass).toBe("infra-dependent");
  });

  it("is null after a run that diagnosed nothing — that is how the manual exit works", async () => {
    // Deliberately NOT carried like `flakyDeferrals`. Our own escalation row
    // harvests no diagnosis, so a maintainer who removes `requires-human` by
    // hand gets a genuine retry instead of an instant re-escalation that puts
    // the label straight back.
    const h = harness();
    const first = await h.dispatch();
    await h.finish(first.id, "diagnose", diagnosis("infra-dependent"));
    const second = await h.dispatch();
    expect(second.state.priorDiagnosisClass).toBe("infra-dependent");

    await h.finish(second.id, "diagnose", "the sandbox failed to provision");
    expect((await h.dispatch()).state.priorDiagnosisClass).toBeNull();
  });

  it("is null on a fresh problem, with the rest of the history", async () => {
    const h = harness();
    const first = await h.dispatch();
    await h.finish(first.id, "diagnose", diagnosis("infra-dependent"));
    const pushed = await h.dispatch({ headSha: "cccc333", headAuthor: "octocat", headIsOurs: false });
    expect(pushed.state.priorDiagnosisClass).toBeNull();
  });

  it("never reports an unrecognised class", async () => {
    // A hallucinated token must not be compared against `retryableClasses` —
    // `class=probably-flaky` is not evidence of anything.
    const h = harness();
    const first = await h.dispatch();
    await h.finish(first.id, "diagnose", diagnosis("probably-flaky"));
    expect((await h.dispatch()).state.priorDiagnosisClass).toBeNull();
  });
});

describe("applyDerivedState — the priorAttempts journal", () => {
  it("accumulates one line per attempt, oldest first", async () => {
    const h = harness();
    const first = await h.dispatch();
    await h.finish(first.id, "diagnose", diagnosis("reproducible", "lockfile stale"));
    await h.finish(first.id, "fix", fixOutcome("pushed", "green"));

    const second = await h.dispatch({ headSha: "bbbb222", headAuthor: BOT, headIsOurs: true });
    await h.finish(second.id, "diagnose", diagnosis("env-mismatch", "CI runs node 22"));
    await h.finish(second.id, "fix", fixOutcome("gave-up", "red"));

    const third = await h.dispatch({ headSha: "bbbb222", headAuthor: BOT, headIsOurs: true });
    expect(third.state.attempt).toBe(3);
    expect(third.state.priorAttempts).toEqual([
      "attempt 1: class=reproducible cause=lockfile stale | outcome=pushed gate=green",
      "attempt 2: class=env-mismatch cause=CI runs node 22 | outcome=gave-up gate=red",
    ]);
  });

  it("stays bounded across a long series of free flaky deferrals", async () => {
    // The unbounded case 09 → S1 names: `fix-red-dependency-prs` runs daily
    // against a PR with one flaky test, and none of those runs spends an
    // attempt — so only the journal's own bound stops the prompt growing.
    const h = harness();
    for (let i = 0; i < 12; i++) {
      const run = await h.dispatch();
      await h.finish(run.id, "diagnose", diagnosis("flaky", `blip ${i}`));
    }
    const last = await h.dispatch();
    expect(last.state.priorAttempts.length).toBeLessThanOrEqual(6);
    // Newest kept, oldest dropped.
    expect(last.state.priorAttempts[last.state.priorAttempts.length - 1]).toContain("blip 11");
  });
});

/**
 * `requires-human` is a notification — and now literally so (02-hold-label.md).
 *
 * The label used to be read as a decision input, with a companion `escalatedBy`
 * field inferring WHOSE it was from "have we ever run on this PR". That made the
 * label a state in practice, and the inference was only ever right on a PR the
 * bot had never touched: on any other, a maintainer's hand-applied
 * `requires-human` read as the bot's own escalation and was cleared by the next
 * person's push. Both are gone. The whole of the escalation state is
 * `escalatedAtSha`, written by `escalatePr` and by nothing else.
 *
 * So every case below asserts the same property from a different angle: the
 * LABEL changes nothing, and the RECORD changes everything.
 */
describe("applyDerivedState — `requires-human` is read by nothing", () => {
  const LABELLED = { labels: [REQUIRES_HUMAN_LABEL] };

  it("a maintainer's label on a PR we have never touched no longer holds anything", async () => {
    // THE behaviour change. It used to resolve `escalatedBy: "human"` — a
    // permanent hard override — and that was the only case the whole inference
    // existed for. A maintainer who wants this now applies the HOLD label, which
    // works on every PR rather than only on virgin ones.
    const h = harness();
    const { state } = await h.dispatch(LABELLED);
    expect(state.escalatedAtSha).toBeNull();
    expect(resolveFixDisposition(state, defaultFixConfig()).decision).toBe("run");
  });

  it("a label the AGENT applied mid-run means nothing to the code either", async () => {
    // The packaged `dependabot-ci-fix` prompt tells the agent to apply
    // `requires-human` when it cannot land the PR. That run persists no
    // `escalatedAtSha` — its snapshot is written at dispatch, before the label
    // exists — so there is no record, and with no record there is no guard. The
    // budgets are what bound this PR now, which is what they were always for.
    const h = harness();
    const first = await h.dispatch();
    await h.finish(first.id, "diagnose", diagnosis("reproducible"));
    await h.finish(first.id, "fix", fixOutcome("gave-up", "red"));
    expect(first.state.escalatedAtSha).toBeNull();

    const next = await h.dispatch(LABELLED);
    expect(next.state.escalatedAtSha).toBeNull();
    expect(resolveFixDisposition(next.state, defaultFixConfig()).decision).toBe("run");
  });

  it("a recorded escalation binds while our notification is still on the PR", async () => {
    // `escalatePr`'s row is the only thing that ever bound, and it still does.
    // Asserted twice, because the record must be what carries the guard: the
    // same history re-resolved must produce the same verdict every time, and no
    // amount of re-reading the PR may turn it into something else.
    const h = harness();
    const first = await h.dispatch();
    h.rows[0].context = { prState: { ...first.state, escalatedAtSha: "aaaa111" } };

    for (let i = 0; i < 2; i++) {
      const { state } = await h.dispatch(LABELLED);
      expect(state.escalatedAtSha).toBe("aaaa111");
      expect(state.intervention).toBeNull();
      expect(resolveFixDisposition(state, defaultFixConfig()).reason).toMatch(/^escalated:/);
    }
  });

  it("but the label coming OFF is a retry — the one thing `requires-human` still says", async () => {
    // 03-retry-intervention.md, surface 2. No webhook: "we escalated at this
    // head, the head has not moved, and our label is gone" can only be a human
    // having removed it — and it is trivially detectable ONLY because Phase 2
    // demoted the label to a pure notification, so its absence is evidence with
    // no competing meaning.
    //
    // It used to CLEAR the guard without moving the budget window, so the
    // dispatch fell straight into `budget-exhausted`, re-labelled the PR and
    // posted a duplicate escalation comment. Now it re-arms.
    const h = harness();
    const first = await h.dispatch();
    h.rows[0].context = { prState: { ...first.state, attempt: 4, escalatedAtSha: "aaaa111" } };

    const { state } = await h.dispatch(LABELLED);
    expect(resolveFixDisposition(state, defaultFixConfig()).reason).toMatch(/^escalated:/);

    const removed = await h.dispatch();
    expect(removed.state.intervention).toMatchObject({ via: "label", atSha: "aaaa111" });
    expect(removed.state.escalatedAtSha).toBeNull();
    expect(removed.state.attempt).toBe(1);
    expect(resolveFixDisposition(removed.state, defaultFixConfig()).decision).toBe("run");

    // ONCE. The record is on the dispatched run's own snapshot, so the next
    // event reads the same intervention back and does not re-arm again — which
    // is what stops a permanently-unlabelled PR getting a fresh window per tick.
    const next = await h.dispatch();
    expect(next.state.intervention?.at).toBe(removed.state.intervention?.at);
    expect(next.state.priorAttempts).toEqual(removed.state.priorAttempts);
    expect(next.state.priorAttempts.filter((l) => l.includes("retried by request"))).toHaveLength(1);
  });

  it("and it stops binding the moment anyone else pushes", async () => {
    // The anti-latch property, unchanged: a new head from anyone but us is a
    // fresh problem, so the record stops binding with nobody having to remove
    // any label by hand.
    const h = harness();
    const first = await h.dispatch();
    h.rows[0].context = { prState: { ...first.state, escalatedAtSha: "aaaa111" } };

    const pushed = await h.dispatch({
      ...LABELLED,
      headSha: "cccc333",
      headAuthor: "octocat",
      headIsOurs: false,
    });
    expect(pushed.state.attempt).toBe(1);
    expect(resolveFixDisposition(pushed.state, defaultFixConfig()).decision).toBe("run");
  });

  it("a LEGACY row with no prState carries no escalation", async () => {
    // On upgrade, every PR already carrying the label has rows of exactly this
    // shape. They used to be inferred into `escalatedBy: "us"` with the row's
    // bare `headSha` standing in for a SHA nobody recorded; now they simply
    // carry no record, and the PR is dispatchable.
    const h = harness();
    h.recordLegacyRun({ headSha: "aaaa111", owner: "cliftonc", repo: "lastlight" });

    const { state } = await h.dispatch(LABELLED);
    expect(state.escalatedAtSha).toBeNull();
    expect(resolveFixDisposition(state, defaultFixConfig()).decision).toBe("run");
  });

  it("reads the record off the WIDEST prior row, not just the fix family's", async () => {
    // `escalatePr` records under whichever workflow was dispatching, which may
    // be `dependabot-pr-merge` or `pr-review` — neither of which the fix-family
    // lookup would find.
    const h = harness();
    const first = await h.dispatch();
    h.rows[0].workflowName = "dependabot-pr-merge";
    h.rows[0].context = { prState: { ...first.state, escalatedAtSha: "eeee555" } };
    expect((await h.dispatch()).state.escalatedAtSha).toBe("eeee555");
  });
});

describe("harvestFixMarkers", () => {
  it("merges across phases instead of clobbering — mergeScratch is shallow", async () => {
    const h = harness();
    const { id } = await h.dispatch();
    await h.finish(id, "diagnose", diagnosis("reproducible"));
    await h.finish(id, "fix", fixOutcome("pushed", "green"));

    const harvest = readHarvestedMarkers(await h.db.runs.getRun(id));
    expect(harvest?.diagnosis?.class).toBe("reproducible");
    expect(harvest?.fix?.outcome).toBe("pushed");
    expect(harvest?.phases).toEqual(["diagnose", "fix"]);
  });

  it("does not clobber other scratch keys", async () => {
    const h = harness();
    const { id } = await h.dispatch();
    await h.db.runs.mergeScratch(id, { notifier: { githubCommentId: 42 } });
    await h.finish(id, "diagnose", diagnosis("reproducible"));
    expect((await h.db.runs.getRun(id))?.scratch?.notifier).toEqual({ githubCommentId: 42 });
  });

  it("harvests a generic_loop ITERATION label, and the last iteration wins", async () => {
    // `phase` is a LABEL: the gate loop delivers `fix_iter_1` / `fix_iter_2`,
    // never `fix`. Keying on equality would harvest nothing at all.
    const h = harness();
    const { id } = await h.dispatch();
    await h.finish(id, "diagnose", diagnosis("reproducible"));
    await h.finish(id, "fix_iter_1", fixOutcome("no-change", "red"));
    await h.finish(id, "fix_iter_2", fixOutcome("pushed", "green"));

    const harvest = readHarvestedMarkers(await h.db.runs.getRun(id));
    expect(harvest?.fix?.outcome).toBe("pushed");
    expect(harvest?.fix?.gate).toBe("green");
    expect(harvest?.phases).toEqual(["diagnose", "fix"]);
  });

  it("records the namespace even when a phase emitted no marker", async () => {
    // Presence of the key — not of a marker — is what tells "the harvest ran
    // and found nothing" from "this row predates the harvest".
    const h = harness();
    const { id } = await h.dispatch();
    await h.finish(id, "diagnose", "I could not work out what happened.");
    const harvest = readHarvestedMarkers(await h.db.runs.getRun(id));
    expect(harvest).not.toBeNull();
    expect(harvest?.diagnosis).toBeNull();
  });

  it("ignores workflows outside the fix family", async () => {
    const h = harness();
    const { id } = await h.dispatch();
    await harvestFixMarkers(h.db, id, "pr-review", "review", diagnosis("reproducible"));
    expect(readHarvestedMarkers(await h.db.runs.getRun(id))).toBeNull();
  });

  it("never throws when the run row is gone", async () => {
    const h = harness();
    await expect(
      h.finish("run-does-not-exist", "diagnose", diagnosis("flaky")),
    ).resolves.not.toThrow();
  });
});

/**
 * The LIVE half's one conditional read (issue #271).
 *
 * `resolvePrState` runs on every PR-scoped dispatch, so a read it does not need
 * is a request per webhook across every managed repo. The compare that feeds
 * the generated-only re-review gate is only useful on one shape of PR — we have
 * posted a review, and the head has moved past it — so it fires there and
 * nowhere else.
 */
describe("resolvePrState — the review-delta compare", () => {
  const emptyDb = {
    runs: {
      activeForTrigger: () => null,
      latestSucceededForTriggers: () => ({}),
      latestForTrigger: () => null,
    },
    executions: { costForTriggerWorkflows: () => 0, phaseSucceededInRun: () => false },
  } as unknown as StateDb;

  function githubStub(history: {
    atHead?: { state: string } | null;
    latest?: { state: string; sha: string } | null;
    paths?: string[] | null;
    comparesThrow?: boolean;
  }) {
    return {
      getPullRequest: async () => ({
        title: "t",
        body: "",
        draft: false,
        labels: [],
        head: { ref: "feature", sha: "newhead", repo: { full_name: "cliftonc/lastlight" } },
        base: { ref: "main", repo: { full_name: "cliftonc/lastlight" } },
      }),
      getChecksSummary: async () => ({ state: "passing", settledCount: 1, pendingCount: 0 }),
      getBaseChecksState: async () => "passing",
      getBotReviewHistory: async () => ({
        atHead: history.atHead ?? null,
        latest: history.latest ?? null,
      }),
      getCommitAuthorName: async () => "octocat",
      getChangedPathsBetween: vi.fn(async () => {
        if (history.comparesThrow) throw new Error("422 no common ancestor");
        return history.paths ?? null;
      }),
    } as any;
  }

  const resolve = (github: any) =>
    resolvePrState("cliftonc", "lastlight", 190, { github, db: emptyDb, botLogin: BOT });

  it("compares, and records both halves, when the head moved past our review", async () => {
    const github = githubStub({
      latest: { state: "APPROVED", sha: "oldhead" },
      paths: ["pnpm-lock.yaml"],
    });
    const state = await resolve(github);
    expect(github.getChangedPathsBetween).toHaveBeenCalledWith(
      "cliftonc",
      "lastlight",
      "oldhead",
      "newhead",
    );
    expect(state.lastBotReview).toEqual({ state: "APPROVED", sha: "oldhead" });
    expect(state.pathsSinceLastBotReview).toEqual(["pnpm-lock.yaml"]);
  });

  it("does not compare when we have never reviewed this PR", async () => {
    const github = githubStub({});
    const state = await resolve(github);
    expect(github.getChangedPathsBetween).not.toHaveBeenCalled();
    expect(state.pathsSinceLastBotReview).toBeNull();
  });

  it("does not compare when our review IS at the head — per-head dedup answers first", async () => {
    const github = githubStub({
      atHead: { state: "APPROVED" },
      latest: { state: "APPROVED", sha: "newhead" },
    });
    const state = await resolve(github);
    expect(github.getChangedPathsBetween).not.toHaveBeenCalled();
    expect(state.botReviewAtHead).toEqual({ state: "APPROVED" });
  });

  // Never throws, and degrades to the value that cannot cause a skip — the same
  // contract every other read in this resolver holds to.
  it("degrades a failed compare to null and notes it", async () => {
    const github = githubStub({ latest: { state: "APPROVED", sha: "oldhead" }, comparesThrow: true });
    const state = await resolve(github);
    expect(state.pathsSinceLastBotReview).toBeNull();
    expect(state.readErrors.join()).toMatch(/getChangedPathsBetween/);
  });
});
