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
const { makeTestDb } = await import("../helpers/state-db.js");
// Hoisted 2026-08-22, with the three above, because they were NOT: imported
// inside the first test body, the module-graph load was billed to that test's
// 5 s budget. Under parallel load it took 6963 ms and the suite failed with
// `Test timed out in 5000ms` — an import cost, never the assertion. It passed
// standalone every time, and a passing re-run overwrites `.turbo/turbo-test.log`,
// so it read as an unattributable flake twice before it was captured.
//
// Hoisting is the fix rather than a bigger timeout: the cost is paid once at
// collection instead of once per suite run, and a raised ceiling would have hidden
// a real slowdown here later, which is the opposite of what this suite is for.
const { withLedger } = await import("#src/cron/handlers.js");
const { CronScheduler } = await import("#src/cron/scheduler.js");

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
  it("attaches the resolved handler to the job", async () => {
    const handler = vi.fn(async () => {});
    cronDefs.mockReturnValue([{ name: "repo-digest", handler: "repo-digest", schedule: "0 9 * * 1" }]);

    const jobs = await getJobs({ crons: NO_CRONS, handlers: { "repo-digest": handler } });

    expect(jobs).toHaveLength(1);
    expect(jobs[0].handler).toBe(handler);
    expect(jobs[0].workflow).toBeUndefined();
  });

  it("DROPS a cron whose handler is unavailable, and says which one", async () => {
    // The opposite direction to `condition.unless`, where registering is safe
    // because there is still a workflow to run. Here there is nothing to run,
    // so a registered tick would only throw — the boot warning is the signal.
    cronDefs.mockReturnValue([
      { name: "repo-digest", handler: "repo-digest", schedule: "0 9 * * 1" },
      { name: "health", workflow: "repo-health", schedule: "0 9 * * 1" },
    ]);

    const jobs = await getJobs({ crons: NO_CRONS, handlers: {} });

    expect(jobs.map((j) => j.name)).toEqual(["health"]);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("Unknown cron handler"),
      expect.objectContaining({ cron: "repo-digest", handler: "repo-digest" }),
    );
  });

  it("still honours the operator's crons.disable for a handler cron", async () => {
    // Off-by-default, not unregistered — a repo may still opt back in, which is
    // why the job survives with the control key rather than disappearing.
    cronDefs.mockReturnValue([{ name: "repo-digest", handler: "repo-digest", schedule: "0 9 * * 1" }]);

    const jobs = await getJobs({
      crons: { enable: [], disable: ["repo-digest"] },
      handlers: { "repo-digest": vi.fn(async () => {}) },
    });

    expect(jobs).toHaveLength(1);
    expect(jobs[0].context._cronGloballyEnabled).toBe(false);
  });

  it("gives a handler cron the same repo list and control keys a workflow cron gets", async () => {
    cronDefs.mockReturnValue([{ name: "repo-digest", handler: "repo-digest", schedule: "0 9 * * 1" }]);
    const jobs = await getJobs({ crons: NO_CRONS, handlers: { "repo-digest": vi.fn(async () => {}) } });

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
   *
   * The rows now land in `cron_runs` rather than `executions` — one ledger for
   * every cron fire, so `GET /crons` stops branching on the kind of cron.
   */
  it("records a row per invocation, keyed by the CRON name", async () => {
    const db = await makeTestDb();
    const wrapped = withLedger(db, "repo-digest", async () => {});
    await wrapped({ repos: ["acme/a"] });

    const row = (await db.cronRuns.latestByCron()).get("repo-digest")!;
    expect(row).toMatchObject({ handler: "repo-digest", status: "ok" });
    expect(row.finishedAt).toBeTruthy();
    // A handler cron dispatches nothing and narrows repos inside itself, so
    // these stay null by design (design §3).
    expect(row.workflow).toBeNull();
    expect(row.dispatched).toBeNull();
    expect(row.reposScanned).toBeNull();
  });

  it("records the failure AND re-throws — the row is a record, not a swallow", async () => {
    const db = await makeTestDb();
    const wrapped = withLedger(db, "repo-digest", async () => {
      throw new Error("invalid_auth");
    });

    await expect(wrapped({})).rejects.toThrow("invalid_auth");

    const row = (await db.cronRuns.latestByCron()).get("repo-digest")!;
    expect(row).toMatchObject({ status: "failed", error: "invalid_auth" });
  });

  it("makes the alerting input — recentFailures — actually count", async () => {
    const db = await makeTestDb();
    const wrapped = withLedger(db, "repo-digest", async () => {
      throw new Error("not_in_channel");
    });
    for (let i = 0; i < 3; i++) await wrapped({}).catch(() => {});

    expect(await db.cronRuns.recentFailures("repo-digest")).toBe(3);
  });

  it("attributes a manual 'Run now' to the person who pressed it", async () => {
    const db = await makeTestDb();
    await withLedger(db, "repo-digest", async () => {})({
      sender: "cliftonc",
      _cronSource: "manual",
      _cronActor: "cliftonc",
    });
    const row = (await db.cronRuns.latestByCron()).get("repo-digest")!;
    expect(row.source).toBe("manual");
    expect(row.actor).toBe("cliftonc");
  });

  it("defaults a scheduled tick to source=schedule with no actor", async () => {
    const db = await makeTestDb();
    await withLedger(db, "repo-digest", async () => {})({ repos: ["acme/a"] });
    const row = (await db.cronRuns.latestByCron()).get("repo-digest")!;
    expect(row.source).toBe("schedule");
    expect(row.actor).toBeNull();
  });

  it("writes nothing to the executions ledger", async () => {
    const db = await makeTestDb();
    await withLedger(db, "repo-digest", async () => {})({});
    // The move is a REPLACEMENT, not a dual write — an executions row here
    // would pollute the agent-phase views that table feeds.
    expect(await db.executions.recentExecutions("repo-digest", 10)).toHaveLength(0);
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
    const db = await makeTestDb();
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
    }
  });

  it("counts a throwing handler's failures under the CRON name", async () => {
    const db = await makeTestDb();
    // The gap: this used to be gated on `job.workflow`, so a handler cron
    // failing every tick produced one log line, no count, and a dashboard
    // reporting zero failures beside it. Counting now happens at fire grain off
    // `cron_runs` (issue #327), still keyed on the cron's own name.
    const recentFailures = vi.spyOn(db.cronRuns, "recentFailures");
    const handler = vi.fn(async () => {
      throw new Error("slack is down");
    });
    const scheduler = new CronScheduler(db, vi.fn(async () => {}));
    try {
      scheduler.register({ name: "repo-digest", schedule: EVERY_SECOND, handler, context: {} });
      await untilCalled(handler);
      await untilCalled(recentFailures);

      expect(recentFailures).toHaveBeenCalledWith("repo-digest");
    } finally {
      scheduler.stopAll();
    }
  });
});
