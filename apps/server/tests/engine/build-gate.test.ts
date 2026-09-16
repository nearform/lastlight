/**
 * The BUILD dispatch gate — the impure applier around `resolveBuildTrigger`.
 *
 * `build-decisions.test.ts` already tables every branch of the POLICY, so
 * nothing here re-tests a decision. What these cases protect is the part a pure
 * function cannot: that the inputs are resolved from the real config and the
 * real state DB, and that the one consequence belonging to the decision — the
 * stage-label advance, **guard 2** — actually happens, in the right direction,
 * on exactly the dispatches that earn it.
 *
 * So they run against a real `StateDb` and a real `advanceStage`, with only
 * GitHub faked. The label assertions are made on the CLIENT calls rather than on
 * a mocked `advanceStage`, because "the entry label came off before the run
 * started" is a claim about what reached GitHub — mocking the advance would fake
 * exactly the link the sweep's re-pickup guard depends on.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { applyBuildDispatchGate, type BuildGateArgs } from "#src/engine/build-gate.js";
import { issueTriggerId } from "#src/engine/build-decisions.js";
import { loadConfig, resetRuntimeConfigForTests } from "#src/config/config.js";
import {
  STAGE_READY_FOR_AGENT,
  STAGE_AGENT_BUILDING,
  STAGE_AGENT_BLOCKED,
  STAGE_READY_FOR_HUMAN,
} from "#src/engine/stage-labels.js";
import type { AutonomyBudgetConfig } from "#src/config/config.js";
import { makeTestDb } from "../helpers/state-db.js";
import type { StateDb } from "#src/state/db.js";
import type { GitHubClient } from "#src/engine/github/github.js";

// The gate and `advanceStage` log through the pino LoggerPort; mock it so the
// suite's stderr stays free of real JSON from the degradation cases.
vi.mock("#src/logging/logger.js", () => {
  const noopLogger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    fatal: vi.fn(),
    child: () => noopLogger,
  };
  return { logger: () => noopLogger };
});

const REPO = "cliftonc/lastlight";
const ISSUE = 412;
const HOLD = "lastlight-ignore";

/** A GitHub stand-in that records the two label writes the advance is made of. */
function fakeGithub(over: { addLabels?: () => Promise<void> } = {}) {
  const addLabels = vi.fn(async (_o: string, _r: string, _n: number, _names: string[]) => {
    if (over.addLabels) await over.addLabels();
  });
  const removeLabel = vi.fn(async () => {});
  const postComment = vi.fn(async () => 1);
  return { addLabels, removeLabel, postComment } as unknown as GitHubClient & {
    addLabels: ReturnType<typeof vi.fn>;
    removeLabel: ReturnType<typeof vi.fn>;
    postComment: ReturnType<typeof vi.fn>;
  };
}

/** A clean human-applied `ready-for-agent`. Each case overrides what it is about. */
function args(over: Partial<BuildGateArgs> = {}): BuildGateArgs {
  return {
    repo: REPO,
    issueNumber: ISSUE,
    labels: [STAGE_READY_FOR_AGENT],
    addedLabel: STAGE_READY_FOR_AGENT,
    route: "labeled",
    senderIsBot: false,
    stage: "build",
    ...over,
  };
}

/** A prior `build` run for this issue — what `alreadyBuilt` reads. */
async function seedBuildRun(db: StateDb, status: "succeeded" | "running" = "succeeded") {
  await db.runs.createRun({
    id: `run-${status}-${Math.random().toString(36).slice(2)}`,
    workflowName: "build",
    triggerId: issueTriggerId(REPO, ISSUE),
    owner: "cliftonc",
    repo: "lastlight",
    issueNumber: ISSUE,
    currentPhase: "architect",
    status,
    startedAt: new Date().toISOString(),
  });
}

describe("applyBuildDispatchGate", () => {
  let db: StateDb;
  let overlayDir: string;

  /**
   * Re-write the overlay and reload config. The budget is real config rather
   * than a stub for the same reason the allow-list is: these ceilings are read
   * through `getAutonomyConfig()`, and a stubbed value would let the block's
   * shape drift from what a deployment actually gets.
   */
  function useBudget(budget: Partial<AutonomyBudgetConfig> = {}): void {
    const lines = Object.entries(budget)
      .map(([k, v]) => `    ${k}: ${v}`)
      .join("\n");
    writeFileSync(
      join(overlayDir, "config.yaml"),
      `autonomy:\n  repos:\n    - "${REPO}"\n` + (lines ? `  budget:\n${lines}\n` : ""),
    );
    loadConfig();
  }

  beforeEach(async () => {
    db = await makeTestDb();
    // Real config, loaded from a real overlay — the gate reads `autonomy.repos`,
    // the stage's labels and the hold label, and a stubbed config would let all
    // three drift from what a deployment actually gets.
    for (const k of ["GITHUB_APP_ID", "SLACK_BOT_TOKEN", "LASTLIGHT_MODEL", "LASTLIGHT_MODELS"]) {
      vi.stubEnv(k, "");
    }
    overlayDir = mkdtempSync(join(tmpdir(), "build-gate-"));
    vi.stubEnv("LASTLIGHT_OVERLAY_DIR", overlayDir);
    useBudget();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    resetRuntimeConfigForTests();
  });

  it("clears a STALE terminal verdict as it advances into `running`", async () => {
    // A run STARTING means neither terminal verdict holds any more, and nothing
    // else ever clears them: this advance removes `enter`, the terminal observer
    // removes `running`. Without this an issue that failed, was re-run and
    // succeeded keeps `agent-blocked` beside its new `ready-for-human` forever,
    // and the board files the finished build under the older, scarier label.
    const github = fakeGithub();

    const result = await applyBuildDispatchGate(
      args({ labels: [STAGE_READY_FOR_AGENT, STAGE_AGENT_BLOCKED] }),
      { db, github },
    );

    expect(result.decision).toBe("dispatch");
    expect(github.addLabels).toHaveBeenCalledWith("cliftonc", "lastlight", ISSUE, [
      STAGE_AGENT_BUILDING,
    ]);
    const removed = github.removeLabel.mock.calls.map((c: unknown[]) => c[3]);
    expect(removed).toContain(STAGE_READY_FOR_AGENT);
    expect(removed).toContain(STAGE_AGENT_BLOCKED);
    expect(removed).toContain(STAGE_READY_FOR_HUMAN);
    // Never the label it just applied.
    expect(removed).not.toContain(STAGE_AGENT_BUILDING);
  });

  it("dispatches a clean issue — and advances the label BEFORE the run, entry off", async () => {
    const github = fakeGithub();

    const result = await applyBuildDispatchGate(args(), { db, github });

    expect(result.decision).toBe("dispatch");
    expect(result.reason).toMatch(/^ready:/);
    // Guard 2, in the direction that matters: the running label ON…
    expect(github.addLabels).toHaveBeenCalledWith("cliftonc", "lastlight", ISSUE, [
      STAGE_AGENT_BUILDING,
    ]);
    // …and the ENTRY label off, which is what the sweep's `label:<enter>` query
    // can no longer find.
    expect(github.removeLabel).toHaveBeenCalledWith(
      "cliftonc",
      "lastlight",
      ISSUE,
      STAGE_READY_FOR_AGENT,
    );
  });

  it("hands back the stage's gates, for the run's approval map to union", async () => {
    const result = await applyBuildDispatchGate(args(), { db, github: fakeGithub() });

    expect(result.gates).toEqual({ post_architect: true, post_reviewer: true });
  });

  it("skips a BOT re-label of an already-built issue — and touches no label", async () => {
    await seedBuildRun(db);
    const github = fakeGithub();

    const result = await applyBuildDispatchGate(args({ senderIsBot: true }), { db, github });

    expect(result.decision).toBe("skip");
    expect(result.reason).toMatch(/^already-built:/);
    expect(result.gates).toBeUndefined();
    // A skip that moved a label would take the issue out of the pipeline for a
    // build that never ran.
    expect(github.addLabels).not.toHaveBeenCalled();
    expect(github.removeLabel).not.toHaveBeenCalled();
  });

  it("dispatches a HUMAN re-label of the same issue — the retry asymmetry", async () => {
    await seedBuildRun(db);

    const result = await applyBuildDispatchGate(args({ senderIsBot: false }), {
      db,
      github: fakeGithub(),
    });

    expect(result.decision).toBe("dispatch");
    expect(result.reason).toMatch(/^retry:/);
  });

  it("skips a held issue silently — no label, no advance", async () => {
    const github = fakeGithub();

    const result = await applyBuildDispatchGate(
      args({ labels: [STAGE_READY_FOR_AGENT, HOLD] }),
      { db, github },
    );

    expect(result.decision).toBe("skip");
    expect(result.reason).toMatch(/^on-hold:/);
    expect(github.addLabels).not.toHaveBeenCalled();
    expect(github.removeLabel).not.toHaveBeenCalled();
  });

  it("skips a repo that is not on the autonomy allow-list", async () => {
    const github = fakeGithub();

    const result = await applyBuildDispatchGate(args({ repo: "other/repo" }), { db, github });

    expect(result.decision).toBe("skip");
    expect(result.reason).toMatch(/^not-autonomous:/);
    expect(github.addLabels).not.toHaveBeenCalled();
  });

  it("skips while a build run for the issue is live", async () => {
    await seedBuildRun(db, "running");

    // A HUMAN retry, so the already-built branch cannot be what answers: two
    // agents in one workspace is physical, and no instruction overrides it.
    const result = await applyBuildDispatchGate(args({ senderIsBot: false }), {
      db,
      github: fakeGithub(),
    });

    expect(result.decision).toBe("skip");
    expect(result.reason).toMatch(/^run-in-flight:/);
  });

  it("still dispatches when the advance FAILS — guard 2 degrades, guard 3 holds", async () => {
    const github = fakeGithub({
      addLabels: async () => {
        throw new Error("GitHub is down");
      },
    });

    const result = await applyBuildDispatchGate(args(), { db, github });

    expect(result.decision).toBe("dispatch");
    // The ordering rule: a failed ADD must not be followed by the remove, or the
    // issue leaves the pipeline carrying neither label.
    expect(github.removeLabel).not.toHaveBeenCalled();
  });

  it("dispatches in chat-only mode, where there is no GitHub to label", async () => {
    const result = await applyBuildDispatchGate(args(), { db, github: null });

    expect(result.decision).toBe("dispatch");
  });

  it("skips an unknown stage name rather than running un-gated", async () => {
    const github = fakeGithub();

    const result = await applyBuildDispatchGate(args({ stage: "ghost" }), { db, github });

    expect(result.decision).toBe("skip");
    expect(result.reason).toMatch(/^unknown-stage:/);
    expect(github.addLabels).not.toHaveBeenCalled();
  });
});

/**
 * THE SKIP CONSEQUENCES — the half a pure function cannot have.
 *
 * `build-decisions.test.ts` already pins WHICH budget branch answers; nothing
 * here re-tests that. What these cases protect is the proportionality rule from
 * `pr-escalation.ts`: a transient skip costs a log line, a configured ceiling
 * costs an audit row, and only the terminal-for-today one reaches the issue —
 * exactly once, keyed on the label rather than on its own prose.
 *
 * The de-duplication case is the load-bearing one. The budget does not clear
 * until midnight, so every sweep tick between the refusal and then comes back
 * through this code. A dedup that failed would not be a cosmetic bug; it would
 * be a comment every twenty minutes on somebody's issue.
 */
describe("applyBuildDispatchGate — budget skip consequences", () => {
  let db: StateDb;
  let overlayDir: string;

  function useBudget(budget: Partial<AutonomyBudgetConfig> = {}): void {
    const lines = Object.entries(budget)
      .map(([k, v]) => `    ${k}: ${v}`)
      .join("\n");
    writeFileSync(
      join(overlayDir, "config.yaml"),
      `autonomy:\n  repos:\n    - "${REPO}"\n` + (lines ? `  budget:\n${lines}\n` : ""),
    );
    loadConfig();
  }

  /** A finished build run for a DIFFERENT issue on this repo — quota, not dedup. */
  async function seedRepoBuild(n: number): Promise<void> {
    await db.runs.createRun({
      id: `quota-${n}`,
      workflowName: "build",
      triggerId: issueTriggerId(REPO, 900 + n),
      owner: "cliftonc",
      repo: "lastlight",
      issueNumber: 900 + n,
      currentPhase: "architect",
      status: "succeeded",
      startedAt: new Date().toISOString(),
    });
  }

  /** A live build run for another issue — the concurrency input. */
  async function seedActiveBuild(
    n: number,
    autonomous: boolean,
    status: "running" | "queued" | "paused" = "running",
  ): Promise<void> {
    await db.runs.createRun({
      id: `live-${n}`,
      workflowName: "build",
      triggerId: issueTriggerId(REPO, 800 + n),
      owner: "cliftonc",
      repo: "lastlight",
      issueNumber: 800 + n,
      currentPhase: status === "paused" ? "waiting_approval" : "architect",
      status,
      context: autonomous ? { _autonomous: true } : {},
      startedAt: new Date().toISOString(),
    });
  }

  /** Model spend recorded against this repo today. */
  async function seedSpend(usd: number): Promise<void> {
    const id = `exec-${Math.random().toString(36).slice(2)}`;
    await db.executions.recordStart({
      id,
      skill: "build",
      triggerType: "webhook",
      triggerId: issueTriggerId(REPO, 901),
      repo: REPO,
      issueNumber: 901,
      startedAt: new Date().toISOString(),
    });
    await db.executions.recordFinish(id, { success: true, costUsd: usd });
  }

  async function activityRows() {
    return (await db.activity.list()).activity;
  }

  beforeEach(async () => {
    db = await makeTestDb();
    for (const k of ["GITHUB_APP_ID", "SLACK_BOT_TOKEN", "LASTLIGHT_MODEL", "LASTLIGHT_MODELS"]) {
      vi.stubEnv(k, "");
    }
    overlayDir = mkdtempSync(join(tmpdir(), "build-gate-budget-"));
    vi.stubEnv("LASTLIGHT_OVERLAY_DIR", overlayDir);
    useBudget();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    resetRuntimeConfigForTests();
  });

  it("a repo over its daily quota: an activity row, and NOTHING on the issue", async () => {
    useBudget({ maxBuildsPerRepoPerDay: 1 });
    await seedRepoBuild(1);
    const github = fakeGithub();

    const result = await applyBuildDispatchGate(args(), { db, github });

    expect(result.decision).toBe("skip");
    expect(result.reason).toMatch(/^repo-quota-exhausted:/);

    // Recorded — a ceiling somebody configured and may want to raise.
    const rows = await activityRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      action: "autonomy.skip",
      outcome: "denied",
      targetType: "issue",
      targetId: issueTriggerId(REPO, ISSUE),
    });
    expect(rows[0]!.detail).toMatchObject({ case: "repo-quota-exhausted" });

    // But not commented, and not labelled: the issue WILL be built, just not
    // today, so there is nothing terminal to say on it.
    expect(github.postComment).not.toHaveBeenCalled();
    expect(github.addLabels).not.toHaveBeenCalled();
  });

  it("a budget-exhausted skip comments exactly once and applies the blocked label", async () => {
    useBudget({ dailyUsd: 1 });
    await seedSpend(5);
    const github = fakeGithub();

    const result = await applyBuildDispatchGate(args(), { db, github });

    expect(result.decision).toBe("skip");
    expect(result.reason).toMatch(/^budget-exhausted:/);

    expect(github.addLabels).toHaveBeenCalledTimes(1);
    expect(github.addLabels).toHaveBeenCalledWith("cliftonc", "lastlight", ISSUE, [
      STAGE_AGENT_BLOCKED,
    ]);
    expect(github.postComment).toHaveBeenCalledTimes(1);

    const body = github.postComment.mock.calls[0]![3] as string;
    // The three things the comment owes a human: which ceiling (with its
    // configured value), when it resets, and how to get out.
    expect(body).toContain("$1.00");
    expect(body).toContain("midnight UTC");
    expect(body).toContain(STAGE_AGENT_BLOCKED);

    expect(await activityRows()).toHaveLength(1);
  });

  it("names the REPO's ceiling when that is the one that was hit", async () => {
    // Harness spend is inside its own ceiling; only the repo's is blown.
    useBudget({ repoDailyUsd: 1 });
    await seedSpend(5);
    const github = fakeGithub();

    await applyBuildDispatchGate(args(), { db, github });

    const body = github.postComment.mock.calls[0]![3] as string;
    expect(body).toContain(REPO);
  });

  it("says NOTHING the second time — the dedup keys on the label, not on the prose", async () => {
    useBudget({ dailyUsd: 1 });
    await seedSpend(5);
    const github = fakeGithub();

    // The issue now carries the blocked label the first refusal applied. This
    // is what every sweep tick between now and midnight looks like.
    const result = await applyBuildDispatchGate(
      args({ labels: [STAGE_READY_FOR_AGENT, STAGE_AGENT_BLOCKED] }),
      { db, github },
    );

    expect(result.decision).toBe("skip");
    expect(result.reason).toMatch(/^budget-exhausted:/);
    expect(github.postComment).not.toHaveBeenCalled();
    expect(github.addLabels).not.toHaveBeenCalled();

    // The audit row is NOT deduped, deliberately: each refusal is a real event,
    // and the stream is where "how often is this happening" gets answered.
    expect(await activityRows()).toHaveLength(1);
  });

  it("a concurrency skip is logged only — no row, no comment", async () => {
    // It clears itself within minutes and fires on every tick while it holds,
    // so a row per tick would be noise in the one stream whose value is that a
    // human can read it.
    useBudget({ maxConcurrentBuilds: 1 });
    await seedActiveBuild(1, true);
    const github = fakeGithub();

    const result = await applyBuildDispatchGate(args(), { db, github });

    expect(result.decision).toBe("skip");
    expect(result.reason).toMatch(/^concurrency-exhausted:/);
    expect(await activityRows()).toHaveLength(0);
    expect(github.postComment).not.toHaveBeenCalled();
    expect(github.addLabels).not.toHaveBeenCalled();
  });

  it("a NON-autonomous build in flight does not consume the concurrency ceiling", async () => {
    // The ceiling bounds unattended work. A build a human asked for by comment
    // is not spending that budget and must not exhaust it.
    useBudget({ maxConcurrentBuilds: 1 });
    await seedActiveBuild(1, false);

    const result = await applyBuildDispatchGate(args(), { db, github: fakeGithub() });

    expect(result.decision).toBe("dispatch");
  });

  it("a build PAUSED on a human does not consume the concurrency ceiling", async () => {
    // A run waiting at an approval gate holds no agent and no sandbox slot.
    // Counting it let two architect plans awaiting review stop the whole
    // pipeline (nearform, 2026-09-16).
    useBudget({ maxConcurrentBuilds: 1 });
    await seedActiveBuild(1, true, "paused");
    await seedActiveBuild(2, true, "paused");

    const result = await applyBuildDispatchGate(args(), { db, github: fakeGithub() });

    expect(result.decision).toBe("dispatch");
  });

  it("a QUEUED autonomous build still consumes the ceiling — it is about to run", async () => {
    useBudget({ maxConcurrentBuilds: 1 });
    await seedActiveBuild(1, true, "queued");

    const result = await applyBuildDispatchGate(args(), { db, github: fakeGithub() });

    expect(result.reason).toMatch(/^concurrency-exhausted:/);
  });

  it("gates a burst atomically — one sweep tick cannot dispatch past the ceiling", async () => {
    // The fan-out gates every discovered issue in parallel, and none of their
    // run rows exist yet when the others read the count. Seven issues against a
    // ceiling of one all read zero and all dispatched.
    useBudget({ maxConcurrentBuilds: 1 });
    const github = fakeGithub();

    const results = await Promise.all(
      [1, 2, 3, 4, 5, 6, 7].map((n) =>
        applyBuildDispatchGate(args({ issueNumber: 100 + n }), { db, github }),
      ),
    );

    expect(results.filter((r) => r.decision === "dispatch")).toHaveLength(1);
    expect(results.filter((r) => /^concurrency-exhausted:/.test(r.reason))).toHaveLength(6);
  });

  it("does not count an issue's own reservation against it — the board gates twice", async () => {
    // The board route crosses the gate, then `dispatchWorkflow` crosses it again
    // for the same issue before the run row exists.
    useBudget({ maxConcurrentBuilds: 1 });
    const github = fakeGithub();

    expect((await applyBuildDispatchGate(args({ route: "api" }), { db, github })).decision).toBe("dispatch");
    expect((await applyBuildDispatchGate(args({ route: "api" }), { db, github })).decision).toBe("dispatch");
  });

  it("releases a reservation once its run exists — the row is the count from then on", async () => {
    useBudget({ maxConcurrentBuilds: 1 });
    const github = fakeGithub();
    expect((await applyBuildDispatchGate(args({ issueNumber: 1 }), { db, github })).decision).toBe("dispatch");

    // The dispatched run starts, then stops at its approval gate.
    await db.runs.createRun({
      id: "burst-1",
      workflowName: "build",
      triggerId: issueTriggerId(REPO, 1),
      owner: "cliftonc",
      repo: "lastlight",
      issueNumber: 1,
      currentPhase: "waiting_approval",
      status: "paused",
      context: { _autonomous: true },
      startedAt: new Date().toISOString(),
    });

    expect((await applyBuildDispatchGate(args({ issueNumber: 2 }), { db, github })).decision).toBe("dispatch");
  });

  it("counts a dispatch ONCE when its run row appears — the reservation gives way to the row", async () => {
    useBudget({ maxConcurrentBuilds: 2 });
    const github = fakeGithub();
    expect((await applyBuildDispatchGate(args({ issueNumber: 1 }), { db, github })).decision).toBe("dispatch");
    await db.runs.createRun({
      id: "realised-1",
      workflowName: "build",
      triggerId: issueTriggerId(REPO, 1),
      owner: "cliftonc",
      repo: "lastlight",
      issueNumber: 1,
      currentPhase: "architect",
      status: "running",
      context: { _autonomous: true },
      startedAt: new Date(Date.now() + 1).toISOString(),
    });

    // One running row against a ceiling of two. Had the reservation for issue 1
    // survived beside its row, the count would read two and refuse this.
    expect((await applyBuildDispatchGate(args({ issueNumber: 2 }), { db, github })).decision).toBe("dispatch");
  });

  it("no budget skip EVER advances the issue to the running label", async () => {
    // A skip that moved the stage on would take the issue out of the pipeline
    // for a build that never ran — the one label write that is never correct
    // here.
    for (const budget of [
      { maxConcurrentBuilds: 0 },
      { maxBuildsPerRepoPerDay: 0 },
      { dailyUsd: 0 },
    ]) {
      useBudget(budget);
      const github = fakeGithub();
      const result = await applyBuildDispatchGate(args(), { db, github });

      expect(result.decision).toBe("skip");
      expect(github.addLabels).not.toHaveBeenCalledWith(
        "cliftonc",
        "lastlight",
        ISSUE,
        [STAGE_AGENT_BUILDING],
      );
      // And the entry label stays on: the issue has not left the queue.
      expect(github.removeLabel).not.toHaveBeenCalled();
    }
  });
});
