import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// The runner logs one structured completion line per fire. Mock the logger so
// the suite's stderr stays free of real pino JSON — no assertion here depends
// on the logged content.
vi.mock("#src/logging/logger.js", () => {
  const noopLogger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    fatal: vi.fn(),
  };
  return { logger: () => noopLogger };
});

import { StateDb } from "#src/state/db.js";
import { makeCronRunner, type CronDiscoverer } from "#src/cron/runner.js";
import type { GitHubClient } from "#src/engine/github/github.js";

const fakeGh = {} as unknown as GitHubClient;

/** Every repo participates — the default when no `.lastlight/` opts out. */
const allParticipate = async ({ repos }: { repos: string[] }) => ({
  repos,
  optedIn: [] as string[],
  optedOut: [] as string[],
});

let db: StateDb;

beforeEach(() => {
  db = new StateDb(":memory:");
});

afterEach(() => {
  db.close();
});

describe("makeCronRunner — discovery crons", () => {
  it("records an ok row with discovered:0 dispatched:0 for an empty discovery", async () => {
    const discoverers: Record<string, CronDiscoverer> = {
      "green-dependency-prs": async () => [],
    };
    const dispatch = vi.fn(async () => ({ success: true }));
    const runner = makeCronRunner({
      db,
      github: fakeGh,
      discoverers,
      dispatch,
      resolveRepos: allParticipate,
    });

    await runner("dependabot-pr-merge", {
      discover: "green-dependency-prs",
      repos: ["o/a", "o/b"],
      _cronName: "merge-green-dependency-prs",
    });

    const row = db.cronRuns.latestByCron().get("merge-green-dependency-prs")!;
    // The whole point of the feature: a zero-discovery fire is a RECORDED
    // green event, not silence.
    expect(row.status).toBe("ok");
    expect(row.reposScanned).toBe(2);
    expect(row.discovered).toBe(0);
    expect(row.dispatched).toBe(0);
    expect(row.workflow).toBe("dependabot-pr-merge");
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("records a partial row when one dispatch fails", async () => {
    const discoverers: Record<string, CronDiscoverer> = {
      "green-dependency-prs": async () => [
        { repo: "o/a", prNumber: 1, title: "bump a" },
        { repo: "o/b", prNumber: 2, title: "bump b" },
      ],
    };
    const dispatch = vi
      .fn()
      .mockResolvedValueOnce({ success: true })
      .mockResolvedValueOnce({ success: false, error: "boom" });
    const runner = makeCronRunner({
      db,
      github: fakeGh,
      discoverers,
      dispatch,
      resolveRepos: allParticipate,
    });

    await runner("dependabot-pr-merge", {
      discover: "green-dependency-prs",
      repos: ["o/a", "o/b"],
      _cronName: "c-partial",
    });

    const row = db.cronRuns.latestByCron().get("c-partial")!;
    expect(row.status).toBe("partial");
    expect(row.discovered).toBe(2);
    expect(row.dispatched).toBe(2);
    expect(row.failures).toBe(1);
  });

  it("records a failed row and re-throws when discovery throws", async () => {
    const discoverers: Record<string, CronDiscoverer> = {
      "green-dependency-prs": async () => {
        throw new Error("gh down");
      },
    };
    const runner = makeCronRunner({
      db,
      github: fakeGh,
      discoverers,
      dispatch: vi.fn(),
      resolveRepos: allParticipate,
    });

    await expect(
      runner("dependabot-pr-merge", {
        discover: "green-dependency-prs",
        repos: ["o/a"],
        _cronName: "c-throw",
      }),
    ).rejects.toThrow("gh down");

    const row = db.cronRuns.latestByCron().get("c-throw")!;
    expect(row.status).toBe("failed");
    expect(row.error).toContain("gh down");
    // A crash mid-fire must leave a terminal row, not a stranded `running`.
    expect(row.finishedAt).not.toBeNull();
  });

  it("records both repo counts when participation narrows the list", async () => {
    const discoverers: Record<string, CronDiscoverer> = {
      "green-dependency-prs": async () => [],
    };
    const runner = makeCronRunner({
      db,
      github: fakeGh,
      discoverers,
      dispatch: vi.fn(async () => ({ success: true })),
      resolveRepos: async () => ({ repos: ["o/a"], optedIn: [], optedOut: ["o/b", "o/c"] }),
    });

    await runner("dependabot-pr-merge", {
      discover: "green-dependency-prs",
      repos: ["o/a", "o/b", "o/c"],
      _cronName: "c-narrow",
    });

    const row = db.cronRuns.latestByCron().get("c-narrow")!;
    expect(row.reposEligible).toBe(3);
    expect(row.reposScanned).toBe(1);
  });

  it("skips discovery when github is null, still recording an ok row", async () => {
    const discoverer = vi.fn(async () => [{ repo: "o/a", prNumber: 1, title: "x" }]);
    const runner = makeCronRunner({
      db,
      github: null,
      discoverers: { "green-dependency-prs": discoverer },
      dispatch: vi.fn(),
      resolveRepos: allParticipate,
    });

    await runner("dependabot-pr-merge", {
      discover: "green-dependency-prs",
      repos: ["o/a"],
      _cronName: "c-nogh",
    });

    const row = db.cronRuns.latestByCron().get("c-nogh")!;
    expect(row.status).toBe("ok");
    expect(row.discovered).toBe(0);
    expect(discoverer).not.toHaveBeenCalled();
  });
});

describe("makeCronRunner — non-discovery crons", () => {
  it("fans out per repo, leaves discovered null, and records source/actor", async () => {
    const dispatch = vi.fn(async () => ({ success: true }));
    const runner = makeCronRunner({
      db,
      github: fakeGh,
      discoverers: {},
      dispatch,
      resolveRepos: allParticipate,
    });

    await runner("repo-health", {
      repos: ["o/a", "o/b"],
      _cronName: "weekly-health-report",
      _cronSource: "manual",
      _cronActor: "robinbowes",
    });

    const row = db.cronRuns.latestByCron().get("weekly-health-report")!;
    expect(row.status).toBe("ok");
    // Null, not 0 — this cron discovers nothing, which is different from
    // discovering nothing.
    expect(row.discovered).toBeNull();
    expect(row.dispatched).toBe(2);
    expect(row.source).toBe("manual");
    expect(row.actor).toBe("robinbowes");
  });

  it("strips the _cron* markers from each dispatched context", async () => {
    const dispatch = vi.fn(async () => ({ success: true }));
    const runner = makeCronRunner({
      db,
      github: fakeGh,
      discoverers: {},
      dispatch,
      resolveRepos: allParticipate,
    });

    await runner("repo-health", {
      repos: ["o/a"],
      _cronName: "weekly-health-report",
      _cronSource: "schedule",
    });

    const [, context] = dispatch.mock.calls[0] as unknown as [string, Record<string, unknown>];
    expect(context._cronName).toBeUndefined();
    expect(context._cronSource).toBeUndefined();
    expect(context._cronActor).toBeUndefined();
    expect(context.repo).toBe("o/a");
  });

  it("defaults source to schedule and actor to null", async () => {
    const runner = makeCronRunner({
      db,
      github: fakeGh,
      discoverers: {},
      dispatch: vi.fn(async () => ({ success: true })),
      resolveRepos: allParticipate,
    });

    await runner("repo-health", { repos: ["o/a"], _cronName: "c-default" });

    const row = db.cronRuns.latestByCron().get("c-default")!;
    expect(row.source).toBe("schedule");
    expect(row.actor).toBeNull();
  });
});

describe("makeCronRunner — a fire with no cron name", () => {
  it("still dispatches, but writes no ledger row", async () => {
    const dispatch = vi.fn(async () => ({ success: true }));
    const runner = makeCronRunner({
      db,
      github: fakeGh,
      discoverers: {},
      dispatch,
      resolveRepos: allParticipate,
    });

    // A caller that built its own context — `resolveCronRepos` already treats a
    // missing name as "use the list verbatim", so there is no cron to key a row
    // on either.
    await runner("repo-health", { repos: ["o/a"] });

    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(db.cronRuns.latestByCron().size).toBe(0);
  });
});
