import { describe, it, expect, vi } from "vitest";

// `vi.hoisted` because `vi.mock` is lifted above ordinary declarations, so a
// plain `const` here is still in its temporal dead zone when the factory runs.
const logSpy = vi.hoisted(() => ({
  error: vi.fn(),
  warn: vi.fn(),
  info: vi.fn(),
  debug: vi.fn(),
  fatal: vi.fn(),
}));
vi.mock("#src/logging/logger.js", () => ({ logger: () => logSpy }));

import { StateDb } from "#src/state/db.js";
import { CronScheduler } from "#src/cron/scheduler.js";

/**
 * The consecutive-failure alert (issue #327).
 *
 * `consecutiveFailures(skill)` matched `executions.skill` exactly, while every
 * phase row is written as `"<workflow>:<phase>"` — so for a workflow cron the
 * predicate could never match and the alert branch was unreachable. Measured on
 * a live instance: 1,622 execution rows, ZERO with a bare skill.
 *
 * Every existing test stubbed it with `consecutiveFailures: () => 0` — the exact
 * value the real implementation always returned — so the fake and the bug agreed
 * and no test could tell them apart. These seed REAL `cron_runs` rows instead.
 */

const EVERY_SECOND = "* * * * * *";

const untilCalled = async (spy: { mock: { calls: unknown[] } }, ms = 3000): Promise<void> => {
  const deadline = Date.now() + ms;
  while (spy.mock.calls.length === 0 && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 25));
  }
};

/** Record `count` finished, failed fires of `cronName`. */
function seedFailures(db: StateDb, cronName: string, count: number): void {
  for (let i = 0; i < count; i++) {
    const id = db.cronRuns.start({ cronName, workflow: "repo-health", source: "schedule", actor: null });
    db.cronRuns.finish(id, { status: "failed", error: "boom" });
  }
}

async function tickUntilAlert(db: StateDb, cronName: string) {
  const runner = vi.fn(async () => {
    throw new Error("still broken");
  });
  const scheduler = new CronScheduler(db, runner);
  try {
    scheduler.register({ name: cronName, schedule: EVERY_SECOND, workflow: "repo-health", context: {} });
    await untilCalled(runner);
    // The alert is logged in the same catch as the failure, so one tick is enough.
    await new Promise((r) => setTimeout(r, 100));
  } finally {
    scheduler.stopAll();
  }
}

const alertCalls = () =>
  logSpy.error.mock.calls.filter(([msg]) => typeof msg === "string" && msg.includes("failed consecutively"));

describe("CronScheduler — the consecutive-failure alert", () => {
  it("fires once the cron's own fires have failed MAX_CONSECUTIVE_FAILURES times", async () => {
    const db = new StateDb(":memory:");
    logSpy.error.mockClear();
    try {
      // Two prior failures + the failing tick itself = 3, the threshold.
      seedFailures(db, "weekly-health-report", 3);
      await tickUntilAlert(db, "weekly-health-report");

      expect(alertCalls().length).toBeGreaterThan(0);
    } finally {
      db.close();
    }
  });

  it("stays quiet below the threshold", async () => {
    const db = new StateDb(":memory:");
    logSpy.error.mockClear();
    try {
      seedFailures(db, "weekly-health-report", 2);
      await tickUntilAlert(db, "weekly-health-report");

      expect(alertCalls()).toHaveLength(0);
    } finally {
      db.close();
    }
  });

  it("counts the CRON's fires, not the workflow's runs", async () => {
    const db = new StateDb(":memory:");
    logSpy.error.mockClear();
    try {
      // The same workflow is reachable from /api/run, a GitHub comment and
      // Slack. Keyed on the workflow, those failures would inflate this cron's
      // health; keyed on the cron, they are invisible to it (issue #341).
      seedFailures(db, "some-other-cron-on-the-same-workflow", 5);
      await tickUntilAlert(db, "weekly-health-report");

      expect(alertCalls()).toHaveLength(0);
      expect(db.cronRuns.recentFailures("weekly-health-report")).toBe(0);
    } finally {
      db.close();
    }
  });

  it("resets after a successful fire", async () => {
    const db = new StateDb(":memory:");
    logSpy.error.mockClear();
    try {
      seedFailures(db, "weekly-health-report", 5);
      const ok = db.cronRuns.start({
        cronName: "weekly-health-report",
        workflow: "repo-health",
        source: "schedule",
        actor: null,
      });
      db.cronRuns.finish(ok, { status: "ok" });

      await tickUntilAlert(db, "weekly-health-report");

      expect(alertCalls()).toHaveLength(0);
    } finally {
      db.close();
    }
  });
});
