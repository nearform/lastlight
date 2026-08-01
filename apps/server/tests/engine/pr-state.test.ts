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

import { describe, it, expect } from "vitest";
import type { StateDb } from "#src/state/db.js";
import type { WorkflowRun } from "#src/state/workflow-run-store.js";
import { applyDerivedState, type PrState, type PrStateDeps } from "#src/engine/pr-state.js";
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
  function dispatch(over: Partial<PrState> = {}): { id: string; state: PrState } {
    const state = liveState(over);
    applyDerivedState(state, deps);
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
  function finish(id: string, phase: string, output: string): void {
    harvestFixMarkers(db, id, "dependabot-ci-fix", phase, output);
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
  it("starts at attempt 1 with an empty history", () => {
    const h = harness();
    const { state } = h.dispatch();
    expect(state.attempt).toBe(1);
    expect(state.priorAttempts).toEqual([]);
    expect(state.flakyDeferrals).toBe(0);
  });
});

describe("applyDerivedState — the attempt counter", () => {
  it("increments on a same-head retry and appends the prior attempt's line", () => {
    const h = harness();
    const first = h.dispatch();
    h.finish(first.id, "diagnose", diagnosis("reproducible"));
    h.finish(first.id, "fix", fixOutcome("gave-up", "red"));

    const second = h.dispatch();
    expect(second.state.attempt).toBe(2);
    expect(second.state.priorAttempts).toEqual([
      "attempt 1: class=reproducible cause=the lockfile is stale | outcome=gave-up gate=red",
    ]);
  });

  it("increments when WE authored the new head — our fix landed, CI is still red", () => {
    const h = harness();
    const first = h.dispatch();
    h.finish(first.id, "diagnose", diagnosis("reproducible"));
    h.finish(first.id, "fix", fixOutcome("pushed", "green"));

    const second = h.dispatch({ headSha: "bbbb222", headAuthor: BOT, headIsOurs: true });
    expect(second.state.attempt).toBe(2);
    expect(second.state.priorAttempts).toHaveLength(1);
  });

  it("resets to 1 — and clears the journal — when SOMEONE ELSE pushes", () => {
    // A maintainer's push, a Dependabot rebase, a Renovate recreate. The world
    // moved, so the counter, the journal and the deferral count all describe a
    // problem that no longer exists — and a prompt that says "attempt 1" while
    // recounting three of them is incoherent.
    const h = harness();
    const first = h.dispatch();
    h.finish(first.id, "diagnose", diagnosis("reproducible"));
    const second = h.dispatch();
    expect(second.state.attempt).toBe(2);
    h.finish(second.id, "diagnose", diagnosis("flaky"));

    const third = h.dispatch({ headSha: "cccc333", headAuthor: "octocat", headIsOurs: false });
    expect(third.state.attempt).toBe(1);
    expect(third.state.priorAttempts).toEqual([]);
    expect(third.state.flakyDeferrals).toBe(0);
  });

  it("a CRASHED run costs nothing — no marker, no increment, no line", () => {
    // The single most important robustness rule in the design: without it, one
    // bad hour escalates every open dependency PR in every managed repo.
    const h = harness();
    const first = h.dispatch();
    h.finish(first.id, "diagnose", "the sandbox failed to provision");

    const second = h.dispatch();
    expect(second.state.attempt).toBe(1);
    expect(second.state.priorAttempts).toEqual([]);
  });

  it("a run that never reached onPhaseEnd falls back to the ledger probe", () => {
    // Upgrade compatibility: a run row written before the harvest existed (or
    // one that died before its first phase ended) carries no `fixMarkers` key
    // at all, and must not be read as "spent nothing".
    const h = harness({ ledgerSaysDiagnosed: true });
    h.dispatch();
    expect(h.dispatch().state.attempt).toBe(2);
  });

  it("a run that HARVESTED but parsed nothing still charges the attempt", () => {
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
    const first = h.dispatch();
    h.finish(first.id, "diagnose", "DIAGNOSIS_COMPLETE without a colon, so nothing parses");

    // The harvest DID run — this is not the "no namespace" case.
    expect(readHarvestedMarkers(h.db.runs.getRun(first.id))).not.toBeNull();
    expect(readHarvestedMarkers(h.db.runs.getRun(first.id))?.diagnosis).toBeNull();
    expect(h.dispatch().state.attempt).toBe(2);
  });

  it("…but a genuinely crashed diagnose still costs nothing", () => {
    // Same shape on the harvest side, opposite answer, and the ledger is what
    // tells them apart: a run whose `diagnose` never finished has no succeeded
    // row. Failing closed here is only safe because of that.
    const h = harness({ ledgerSaysDiagnosed: false });
    const first = h.dispatch();
    h.finish(first.id, "diagnose", "the sandbox failed to provision");
    expect(h.dispatch().state.attempt).toBe(1);
  });

  it("a `flaky` verdict costs no attempt", () => {
    // 09 → S1's class table. `fix.maxFlakyDeferrals` is the bound instead — and
    // that counter would be unreachable if `flaky` also spent an attempt.
    const h = harness();
    const first = h.dispatch();
    h.finish(first.id, "diagnose", diagnosis("flaky", "network timeout on install"));
    const second = h.dispatch();
    expect(second.state.attempt).toBe(1);
    // The line is still recorded — attempt 2 should know it already deferred.
    expect(second.state.priorAttempts).toEqual([
      "attempt 1: class=flaky cause=network timeout on install",
    ]);
  });

  it("an `upstream-broken` verdict costs no attempt", () => {
    const h = harness();
    const first = h.dispatch();
    h.finish(first.id, "diagnose", diagnosis("upstream-broken", "base is red too"));
    expect(h.dispatch().state.attempt).toBe(1);
  });

  it("an `infra-dependent` verdict DOES cost an attempt", () => {
    const h = harness();
    const first = h.dispatch();
    h.finish(first.id, "diagnose", diagnosis("infra-dependent", "needs a live postgres"));
    expect(h.dispatch().state.attempt).toBe(2);
  });

  it("an unrecognised class costs an attempt — fail closed", () => {
    const h = harness();
    const first = h.dispatch();
    h.finish(first.id, "diagnose", diagnosis("probably-flaky"));
    expect(h.dispatch().state.attempt).toBe(2);
  });
});

describe("applyDerivedState — flakyDeferrals", () => {
  it("counts CONSECUTIVE flaky diagnoses", () => {
    const h = harness();
    const first = h.dispatch();
    expect(first.state.flakyDeferrals).toBe(0);
    h.finish(first.id, "diagnose", diagnosis("flaky"));

    const second = h.dispatch();
    expect(second.state.flakyDeferrals).toBe(1);
    h.finish(second.id, "diagnose", diagnosis("flaky"));

    const third = h.dispatch();
    // `fix.maxFlakyDeferrals: 2` — the next diagnosis is promoted.
    expect(third.state.flakyDeferrals).toBe(2);
  });

  it("resets to 0 on any non-flaky class", () => {
    const h = harness();
    const first = h.dispatch();
    h.finish(first.id, "diagnose", diagnosis("flaky"));
    const second = h.dispatch();
    expect(second.state.flakyDeferrals).toBe(1);

    h.finish(second.id, "diagnose", diagnosis("reproducible"));
    expect(h.dispatch().state.flakyDeferrals).toBe(0);
  });

  it("a crash neither advances nor resets it — it says nothing about flakiness", () => {
    const h = harness();
    const first = h.dispatch();
    h.finish(first.id, "diagnose", diagnosis("flaky"));
    const second = h.dispatch();
    expect(second.state.flakyDeferrals).toBe(1);

    h.finish(second.id, "diagnose", "sandbox provisioning failed");
    expect(h.dispatch().state.flakyDeferrals).toBe(1);
  });
});

describe("applyDerivedState — priorDiagnosisClass", () => {
  it("carries the LAST run's class, which is what the escalation gate reads", () => {
    const h = harness();
    const first = h.dispatch();
    h.finish(first.id, "diagnose", diagnosis("infra-dependent", "needs a live postgres"));
    expect(h.dispatch().state.priorDiagnosisClass).toBe("infra-dependent");
  });

  it("is null after a run that diagnosed nothing — that is how the manual exit works", () => {
    // Deliberately NOT carried like `flakyDeferrals`. Our own escalation row
    // harvests no diagnosis, so a maintainer who removes `requires-human` by
    // hand gets a genuine retry instead of an instant re-escalation that puts
    // the label straight back.
    const h = harness();
    const first = h.dispatch();
    h.finish(first.id, "diagnose", diagnosis("infra-dependent"));
    const second = h.dispatch();
    expect(second.state.priorDiagnosisClass).toBe("infra-dependent");

    h.finish(second.id, "diagnose", "the sandbox failed to provision");
    expect(h.dispatch().state.priorDiagnosisClass).toBeNull();
  });

  it("is null on a fresh problem, with the rest of the history", () => {
    const h = harness();
    const first = h.dispatch();
    h.finish(first.id, "diagnose", diagnosis("infra-dependent"));
    const pushed = h.dispatch({ headSha: "cccc333", headAuthor: "octocat", headIsOurs: false });
    expect(pushed.state.priorDiagnosisClass).toBeNull();
  });

  it("never reports an unrecognised class", () => {
    // A hallucinated token must not be compared against `retryableClasses` —
    // `class=probably-flaky` is not evidence of anything.
    const h = harness();
    const first = h.dispatch();
    h.finish(first.id, "diagnose", diagnosis("probably-flaky"));
    expect(h.dispatch().state.priorDiagnosisClass).toBeNull();
  });
});

describe("applyDerivedState — the priorAttempts journal", () => {
  it("accumulates one line per attempt, oldest first", () => {
    const h = harness();
    const first = h.dispatch();
    h.finish(first.id, "diagnose", diagnosis("reproducible", "lockfile stale"));
    h.finish(first.id, "fix", fixOutcome("pushed", "green"));

    const second = h.dispatch({ headSha: "bbbb222", headAuthor: BOT, headIsOurs: true });
    h.finish(second.id, "diagnose", diagnosis("env-mismatch", "CI runs node 22"));
    h.finish(second.id, "fix", fixOutcome("gave-up", "red"));

    const third = h.dispatch({ headSha: "bbbb222", headAuthor: BOT, headIsOurs: true });
    expect(third.state.attempt).toBe(3);
    expect(third.state.priorAttempts).toEqual([
      "attempt 1: class=reproducible cause=lockfile stale | outcome=pushed gate=green",
      "attempt 2: class=env-mismatch cause=CI runs node 22 | outcome=gave-up gate=red",
    ]);
  });

  it("stays bounded across a long series of free flaky deferrals", () => {
    // The unbounded case 09 → S1 names: `fix-red-dependency-prs` runs daily
    // against a PR with one flaky test, and none of those runs spends an
    // attempt — so only the journal's own bound stops the prompt growing.
    const h = harness();
    for (let i = 0; i < 12; i++) {
      const run = h.dispatch();
      h.finish(run.id, "diagnose", diagnosis("flaky", `blip ${i}`));
    }
    const last = h.dispatch();
    expect(last.state.priorAttempts.length).toBeLessThanOrEqual(6);
    // Newest kept, oldest dropped.
    expect(last.state.priorAttempts[last.state.priorAttempts.length - 1]).toContain("blip 11");
  });
});

/**
 * Who owns a `requires-human` label — the one question that decides whether the
 * bot may ever touch the PR again.
 *
 * `escalatedBy: "human"` is a PERMANENT hard override, so reading our own label
 * as a maintainer's is the one-way door 09 → S1 exists to remove. Two routes put
 * our label on a PR with no `escalatedAtSha` behind it: the agent applying it
 * mid-run (the packaged fix and merge prompts both instruct it to, and
 * `context.prState` is written at dispatch and never rewritten), and every run
 * row written before this module existed.
 */
describe("applyDerivedState — whose `requires-human` is this", () => {
  const LABELLED = { labels: [REQUIRES_HUMAN_LABEL] };

  it("a maintainer's label on a PR we have NEVER touched is a permanent hold", () => {
    // The distinction the whole rule exists to preserve. No run of ours has ever
    // seen this PR, so nobody but a maintainer can have applied the label.
    const h = harness();
    const { state } = h.dispatch(LABELLED);
    expect(state.escalatedBy).toBe("human");
    expect(state.escalatedAtSha).toBeNull();
    expect(resolveFixDisposition(state, defaultFixConfig()).reason).toMatch(/^human-hold:/);
  });

  it("a label the AGENT applied mid-run reads as ours, not as a human's", () => {
    // The packaged `dependabot-ci-fix` prompt tells the agent to apply
    // `requires-human` when it cannot land the PR. That run persists no
    // `escalatedAtSha` — its snapshot was written at dispatch, before the label
    // existed — so a bare `escalatedAtSha ? "us" : "human"` test latched the PR
    // dead on the very next event.
    const h = harness();
    const first = h.dispatch();
    h.finish(first.id, "diagnose", diagnosis("reproducible"));
    h.finish(first.id, "fix", fixOutcome("gave-up", "red"));
    expect(first.state.escalatedAtSha).toBeNull();

    const next = h.dispatch(LABELLED);
    expect(next.state.escalatedBy).toBe("us");
    // The head we were at when the label landed stands in for the SHA nobody
    // recorded, so the guard binds on THIS problem rather than on nothing.
    expect(next.state.escalatedAtSha).toBe(first.state.headSha);
    expect(resolveFixDisposition(next.state, defaultFixConfig()).reason).toMatch(/^escalated:/);
  });

  it("and it stops holding the moment anyone else pushes", () => {
    // The anti-latch property, for the agent-applied label too: a new head from
    // anyone but us is a fresh problem, so the label stops binding with nobody
    // having to remove it by hand.
    const h = harness();
    const first = h.dispatch();
    h.finish(first.id, "diagnose", diagnosis("reproducible"));
    h.dispatch(LABELLED);

    const pushed = h.dispatch({
      ...LABELLED,
      headSha: "cccc333",
      headAuthor: "octocat",
      headIsOurs: false,
    });
    expect(pushed.state.escalatedBy).toBe("us");
    expect(pushed.state.attempt).toBe(1);
    expect(resolveFixDisposition(pushed.state, defaultFixConfig()).decision).toBe("run");
  });

  it("a LEGACY row with no prState does not read as a human hold either", () => {
    // On upgrade, every PR already carrying the label has rows of exactly this
    // shape — so the old test would have latched all of them at once, each
    // needing a human to un-stick it by hand.
    const h = harness();
    h.recordLegacyRun({ headSha: "aaaa111", owner: "cliftonc", repo: "lastlight" });

    const { state } = h.dispatch(LABELLED);
    expect(state.escalatedBy).toBe("us");
    expect(state.escalatedAtSha).toBe("aaaa111");
    expect(resolveFixDisposition(state, defaultFixConfig()).reason).toMatch(/^escalated:/);
  });

  it("a legacy row with no head SHA at all is still ours, just without one", () => {
    const h = harness();
    h.recordLegacyRun({ owner: "cliftonc", repo: "lastlight" });

    const { state } = h.dispatch(LABELLED);
    expect(state.escalatedBy).toBe("us");
    expect(state.escalatedAtSha).toBeNull();
    // Nothing to match the head against, so the guard falls through to the
    // ordinary budget gates rather than to a permanent hold.
    expect(resolveFixDisposition(state, defaultFixConfig()).decision).toBe("run");
  });

  it("a recorded escalation still wins over the stand-in", () => {
    // `escalatePr`'s row is the real thing; the fallbacks only ever fill a gap.
    const h = harness();
    const first = h.dispatch();
    h.rows[0].context = {
      prState: { ...first.state, escalatedAtSha: "eeee555", escalatedBy: "us" },
    };
    expect(h.dispatch(LABELLED).state.escalatedAtSha).toBe("eeee555");
  });

  it("no label ⇒ nobody escalated, whatever the history says", () => {
    const h = harness();
    h.recordLegacyRun({ headSha: "aaaa111" });
    expect(h.dispatch().state.escalatedBy).toBeNull();
  });
});

describe("harvestFixMarkers", () => {
  it("merges across phases instead of clobbering — mergeScratch is shallow", () => {
    const h = harness();
    const { id } = h.dispatch();
    h.finish(id, "diagnose", diagnosis("reproducible"));
    h.finish(id, "fix", fixOutcome("pushed", "green"));

    const harvest = readHarvestedMarkers(h.db.runs.getRun(id));
    expect(harvest?.diagnosis?.class).toBe("reproducible");
    expect(harvest?.fix?.outcome).toBe("pushed");
    expect(harvest?.phases).toEqual(["diagnose", "fix"]);
  });

  it("does not clobber other scratch keys", () => {
    const h = harness();
    const { id } = h.dispatch();
    h.db.runs.mergeScratch(id, { notifier: { githubCommentId: 42 } });
    h.finish(id, "diagnose", diagnosis("reproducible"));
    expect(h.db.runs.getRun(id)?.scratch?.notifier).toEqual({ githubCommentId: 42 });
  });

  it("harvests a generic_loop ITERATION label, and the last iteration wins", () => {
    // `phase` is a LABEL: the gate loop delivers `fix_iter_1` / `fix_iter_2`,
    // never `fix`. Keying on equality would harvest nothing at all.
    const h = harness();
    const { id } = h.dispatch();
    h.finish(id, "diagnose", diagnosis("reproducible"));
    h.finish(id, "fix_iter_1", fixOutcome("no-change", "red"));
    h.finish(id, "fix_iter_2", fixOutcome("pushed", "green"));

    const harvest = readHarvestedMarkers(h.db.runs.getRun(id));
    expect(harvest?.fix?.outcome).toBe("pushed");
    expect(harvest?.fix?.gate).toBe("green");
    expect(harvest?.phases).toEqual(["diagnose", "fix"]);
  });

  it("records the namespace even when a phase emitted no marker", () => {
    // Presence of the key — not of a marker — is what tells "the harvest ran
    // and found nothing" from "this row predates the harvest".
    const h = harness();
    const { id } = h.dispatch();
    h.finish(id, "diagnose", "I could not work out what happened.");
    const harvest = readHarvestedMarkers(h.db.runs.getRun(id));
    expect(harvest).not.toBeNull();
    expect(harvest?.diagnosis).toBeNull();
  });

  it("ignores workflows outside the fix family", () => {
    const h = harness();
    const { id } = h.dispatch();
    harvestFixMarkers(h.db, id, "pr-review", "review", diagnosis("reproducible"));
    expect(readHarvestedMarkers(h.db.runs.getRun(id))).toBeNull();
  });

  it("never throws when the run row is gone", () => {
    const h = harness();
    expect(() => h.finish("run-does-not-exist", "diagnose", diagnosis("flaky"))).not.toThrow();
  });
});
