import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * `handler:` crons — a cron YAML that names HOST-SIDE code instead of a
 * workflow (the repo digest is the first).
 *
 * The mechanism exists so such a cron is a first-class citizen: dashboard
 * toggle, `cron_overrides` schedule, operator `crons.disable`, per-repo
 * participation and "Run now". A `registerDirect` job — the sandbox sweep's
 * shape — gets none of those, because it is invisible to `getCronWorkflows()`.
 */

type CronDef = {
  name: string;
  workflow?: string;
  handler?: string;
  schedule: string;
  context?: Record<string, unknown>;
  condition?: { unless?: string };
};

const cronDefs = vi.fn<() => CronDef[]>(() => []);
vi.mock("#src/workflows/loader.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("#src/workflows/loader.js")>();
  return { ...actual, getCronWorkflows: () => cronDefs() };
});
vi.mock("#src/managed-repos.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("#src/managed-repos.js")>();
  return { ...actual, getAccessibleManagedRepos: () => ["acme/a"] };
});

const { warnSpy } = vi.hoisted(() => ({ warnSpy: vi.fn() }));
vi.mock("#src/logging/logger.js", () => {
  const noopLogger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: warnSpy,
    error: vi.fn(),
    fatal: vi.fn(),
    child: () => noopLogger,
  };
  return { logger: () => noopLogger };
});

const { getJobs } = await import("#src/cron/jobs.js");
const { CronWorkflowSchema } = await import("lastlight-workflow-engine");

const NO_CRONS = { enable: [], disable: [] };

beforeEach(() => {
  cronDefs.mockReset();
  warnSpy.mockReset();
});

describe("CronWorkflowSchema — exactly one of workflow/handler", () => {
  const base = { kind: "cron" as const, name: "x", schedule: "0 9 * * 1" };

  it("accepts a workflow cron", () => {
    expect(CronWorkflowSchema.safeParse({ ...base, workflow: "repo-health" }).success).toBe(true);
  });

  it("accepts a handler cron", () => {
    expect(CronWorkflowSchema.safeParse({ ...base, handler: "repo-digest" }).success).toBe(true);
  });

  it("REJECTS both — the two are different execution paths", () => {
    const parsed = CronWorkflowSchema.safeParse({ ...base, workflow: "repo-health", handler: "repo-digest" });
    expect(parsed.success).toBe(false);
  });

  it("REJECTS neither — a cron with nothing to run would tick into the void", () => {
    expect(CronWorkflowSchema.safeParse(base).success).toBe(false);
  });
});

describe("getJobs — resolving a handler", () => {
  it("attaches the resolved handler to the job", () => {
    const handler = vi.fn(async () => {});
    cronDefs.mockReturnValue([{ name: "repo-digest", handler: "repo-digest", schedule: "0 9 * * 1" }]);

    const jobs = getJobs({ crons: NO_CRONS, handlers: { "repo-digest": handler } });

    expect(jobs).toHaveLength(1);
    expect(jobs[0].handler).toBe(handler);
    expect(jobs[0].workflow).toBeUndefined();
  });

  it("DROPS a cron whose handler is unavailable, and says which one", () => {
    // The opposite direction to `condition.unless`, where registering is safe
    // because there is still a workflow to run. Here there is nothing to run,
    // so a registered tick would only throw — the boot warning is the signal.
    cronDefs.mockReturnValue([
      { name: "repo-digest", handler: "repo-digest", schedule: "0 9 * * 1" },
      { name: "health", workflow: "repo-health", schedule: "0 9 * * 1" },
    ]);

    const jobs = getJobs({ crons: NO_CRONS, handlers: {} });

    expect(jobs.map((j) => j.name)).toEqual(["health"]);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("Unknown cron handler"),
      expect.objectContaining({ cron: "repo-digest", handler: "repo-digest" }),
    );
  });

  it("still honours the operator's crons.disable for a handler cron", () => {
    // Off-by-default, not unregistered — a repo may still opt back in, which is
    // why the job survives with the control key rather than disappearing.
    cronDefs.mockReturnValue([{ name: "repo-digest", handler: "repo-digest", schedule: "0 9 * * 1" }]);

    const jobs = getJobs({
      crons: { enable: [], disable: ["repo-digest"] },
      handlers: { "repo-digest": vi.fn(async () => {}) },
    });

    expect(jobs).toHaveLength(1);
    expect(jobs[0].context._cronGloballyEnabled).toBe(false);
  });

  it("gives a handler cron the same repo list and control keys a workflow cron gets", () => {
    cronDefs.mockReturnValue([{ name: "repo-digest", handler: "repo-digest", schedule: "0 9 * * 1" }]);
    const jobs = getJobs({ crons: NO_CRONS, handlers: { "repo-digest": vi.fn(async () => {}) } });

    expect(jobs[0].context).toMatchObject({
      repos: ["acme/a"],
      _cronName: "repo-digest",
      _cronGloballyEnabled: true,
    });
  });
});

describe("withLedger — a handler cron is countable", () => {
  /**
   * The observability gap this closes: a handler cron has no `workflow_runs`
   * row, so before this the scheduler's consecutive-failure check was gated off
   * for it and the admin crons list reported a hardcoded `recentFailures: 0`.
   * A weekly cron could fail for a month behind a healthy-looking dashboard.
   */
  it("records a row per invocation, keyed by the CRON name", async () => {
    const { withLedger } = await import("#src/cron/handlers.js");
    const { StateDb } = await import("#src/state/db.js");
    const db = new StateDb(":memory:");
    try {
      const wrapped = withLedger(db, "repo-digest", async () => {});
      await wrapped({ repos: ["acme/a"] });

      const rows = db.executions.recentExecutions("repo-digest", 10);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ triggerType: "cron", skill: "repo-digest", success: true });
      expect(rows[0].finishedAt).toBeTruthy();
    } finally {
      db.close();
    }
  });

  it("records the failure AND re-throws — the row is a record, not a swallow", async () => {
    const { withLedger } = await import("#src/cron/handlers.js");
    const { StateDb } = await import("#src/state/db.js");
    const db = new StateDb(":memory:");
    try {
      const wrapped = withLedger(db, "repo-digest", async () => {
        throw new Error("invalid_auth");
      });

      await expect(wrapped({})).rejects.toThrow("invalid_auth");

      const [row] = db.executions.recentExecutions("repo-digest", 1);
      expect(row).toMatchObject({ success: false, error: "invalid_auth" });
    } finally {
      db.close();
    }
  });

  it("makes consecutiveFailures — the alerting input — actually count", async () => {
    const { withLedger } = await import("#src/cron/handlers.js");
    const { StateDb } = await import("#src/state/db.js");
    const db = new StateDb(":memory:");
    try {
      const wrapped = withLedger(db, "repo-digest", async () => {
        throw new Error("not_in_channel");
      });
      for (let i = 0; i < 3; i++) await wrapped({}).catch(() => {});

      expect(db.executions.consecutiveFailures("repo-digest")).toBe(3);
    } finally {
      db.close();
    }
  });

  it("attributes a manual 'Run now' to the person who pressed it", async () => {
    const { withLedger } = await import("#src/cron/handlers.js");
    const { StateDb } = await import("#src/state/db.js");
    const db = new StateDb(":memory:");
    try {
      await withLedger(db, "repo-digest", async () => {})({ sender: "cliftonc" });
      const [row] = db.executions.recentExecutions("repo-digest", 1);
      expect(row.triggeredBy).toBe("cliftonc");
    } finally {
      db.close();
    }
  });
});

describe("CronScheduler — running a handler job", () => {
  /** Croner takes a 6-field pattern, so a real tick is one second away. */
  const EVERY_SECOND = "* * * * * *";

  const untilCalled = async (spy: { mock: { calls: unknown[] } }, ms = 3000): Promise<void> => {
    const deadline = Date.now() + ms;
    while (spy.mock.calls.length === 0 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 25));
    }
  };

  it("invokes the handler, with the job's context, instead of the workflow runner", async () => {
    const { CronScheduler } = await import("#src/cron/scheduler.js");
    const { StateDb } = await import("#src/state/db.js");
    const db = new StateDb(":memory:");
    const runner = vi.fn(async () => {});
    const handler = vi.fn(async () => {});
    const scheduler = new CronScheduler(db, runner);
    try {
      scheduler.register({
        name: "repo-digest",
        schedule: EVERY_SECOND,
        handler,
        context: { repos: ["acme/a"], _cronName: "repo-digest" },
      });

      await untilCalled(handler);

      expect(handler).toHaveBeenCalledWith({ repos: ["acme/a"], _cronName: "repo-digest" });
      expect(runner).not.toHaveBeenCalled();
    } finally {
      scheduler.stopAll();
      db.close();
    }
  });

  it("counts a throwing handler's failures under the CRON name", async () => {
    const { CronScheduler } = await import("#src/cron/scheduler.js");
    const { StateDb } = await import("#src/state/db.js");
    const db = new StateDb(":memory:");
    // The gap: this used to be gated on `job.workflow`, so a handler cron
    // failing every tick produced one log line, no count, and a dashboard
    // reporting zero failures beside it.
    const consecutiveFailures = vi.spyOn(db.executions, "consecutiveFailures");
    const handler = vi.fn(async () => {
      throw new Error("slack is down");
    });
    const scheduler = new CronScheduler(db, vi.fn(async () => {}));
    try {
      scheduler.register({ name: "repo-digest", schedule: EVERY_SECOND, handler, context: {} });
      await untilCalled(handler);
      await untilCalled(consecutiveFailures);

      expect(consecutiveFailures).toHaveBeenCalledWith("repo-digest");
    } finally {
      scheduler.stopAll();
      db.close();
    }
  });
});
