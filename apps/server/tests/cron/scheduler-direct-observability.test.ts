import { describe, it, expect, vi, beforeEach, type Mock } from "vitest";
import { CronScheduler } from "#src/cron/scheduler.js";
import { logger } from "#src/logging/logger.js";
import type { StateDb } from "#src/state/db.js";

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

function cronLog() {
  return logger("cron") as unknown as { info: Mock; error: Mock };
}

/** Fire a tick deterministically instead of waiting on the schedule. croner
 *  exposes `trigger()`; `jobs` is TS-private, which is compile-time only. */
function fire(scheduler: CronScheduler, name: string): Promise<void> {
  const jobs = (scheduler as unknown as { jobs: Map<string, { trigger: () => Promise<void> }> })
    .jobs;
  const job = jobs.get(name);
  expect(job, `no cron registered as "${name}"`).toBeDefined();
  return job!.trigger();
}

function makeScheduler(): CronScheduler {
  // A direct job never touches the db or the workflow runner — both are only
  // reached by `register()`'s workflow path.
  return new CronScheduler({} as StateDb, async () => {});
}

// Far-future pattern: nothing fires on its own, so every tick in these tests is
// one we triggered.
const NEVER = "0 0 1 1 *";

describe("registerDirect observability", () => {
  beforeEach(() => {
    const log = cronLog();
    log.info.mockClear();
    log.error.mockClear();
  });

  it("logs that the job ran, matching register()'s tick logging", async () => {
    // Without this, a direct job is silent between "Registered" and a throw, so
    // a working job and a dead one look identical.
    const scheduler = makeScheduler();
    const handler = vi.fn().mockResolvedValue(undefined);
    scheduler.registerDirect({ name: "sweep", schedule: NEVER, handler });

    await fire(scheduler, "sweep");

    expect(handler).toHaveBeenCalledOnce();
    expect(cronLog().info).toHaveBeenCalledWith("Running", { job: "sweep" });
    scheduler.stopAll();
  });

  it("logs the overlap skip instead of returning silently", async () => {
    // A direct job wedged in `running` would otherwise be skipped on every
    // subsequent tick forever with no signal at all.
    const scheduler = makeScheduler();
    let release!: () => void;
    const handler = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    scheduler.registerDirect({ name: "sweep", schedule: NEVER, handler });

    const first = fire(scheduler, "sweep"); // still in flight
    await fire(scheduler, "sweep"); // overlaps

    expect(handler).toHaveBeenCalledOnce(); // the second tick did not run it
    expect(cronLog().info).toHaveBeenCalledWith("Skipping — still running from previous tick", {
      job: "sweep",
    });

    release();
    await first;
    scheduler.stopAll();
  });

  it("logs a throwing handler and releases the overlap latch", async () => {
    // The latch must clear on the failure path too, or one throw wedges the job
    // permanently — the silent-stall this logging exists to surface.
    const scheduler = makeScheduler();
    const handler = vi.fn().mockRejectedValue(new Error("boom"));
    scheduler.registerDirect({ name: "sweep", schedule: NEVER, handler });

    await fire(scheduler, "sweep");
    expect(cronLog().error).toHaveBeenCalledWith(
      "Job failed",
      expect.objectContaining({ job: "sweep" }),
    );

    await fire(scheduler, "sweep");
    expect(handler).toHaveBeenCalledTimes(2); // not wedged
    scheduler.stopAll();
  });
});
