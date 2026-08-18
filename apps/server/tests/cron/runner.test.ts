import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// The runner logs one structured completion line per fire. Mocked so the
// suite's stderr stays free of real pino JSON — and CAPTURED, so tests can
// assert what was logged. Hoisted because `vi.mock` is lifted above ordinary
// declarations.
const logSpy = vi.hoisted(() => ({
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  fatal: vi.fn(),
}));
vi.mock("#src/logging/logger.js", () => ({ logger: () => logSpy }));

import { StateDb } from "#src/state/db.js";
import { makeCronRunner, completionMessage, type CronDiscoverer } from "#src/cron/runner.js";
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
  for (const fn of Object.values(logSpy)) fn.mockClear();
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

describe("completionMessage", () => {
  const counts = (over = {}) => ({
    reposEligible: 16,
    reposScanned: 16,
    discovered: 0,
    dispatched: 0,
    failures: 0,
    ...over,
  });

  it("names the cron, because a collapsed log view shows the message and nothing else", () => {
    // Seven crons are registered; "Cron fire complete: scanned 16" identifies
    // none of them in `kubectl logs` or a Grafana panel that renders only `msg`.
    expect(completionMessage("check-prs-awaiting-review", counts())).toBe(
      "Cron fire complete: check-prs-awaiting-review — scanned 16, found 0, dispatched 0",
    );
  });

  it("keeps the stable prefix first so one query finds every fire", () => {
    // `|~ "Cron fire complete"` must still match — including the handler-cron
    // line in cron/handlers.ts, which shares this prefix.
    for (const m of [
      completionMessage("a", counts()),
      completionMessage("b", counts({ reposScanned: null, reposEligible: null, discovered: null, dispatched: null, failures: null })),
    ]) {
      expect(m.startsWith("Cron fire complete:")).toBe(true);
    }
  });

  it("shows the narrowing only when repos actually opted out", () => {
    expect(completionMessage("c", counts({ reposEligible: 19, reposScanned: 14 }))).toContain("scanned 14 of 19");
    expect(completionMessage("c", counts())).toContain("scanned 16,");
    expect(completionMessage("c", counts())).not.toContain(" of ");
  });

  it("omits discovered for a non-discovery cron rather than printing 0", () => {
    // null means "this cron discovers nothing", which is different from
    // "discovered nothing" — the message must not conflate them.
    const msg = completionMessage("weekly-health-report", counts({ discovered: null, dispatched: 16 }));
    expect(msg).not.toContain("found");
    expect(msg).toContain("dispatched 16");
  });

  it("calls out failures, and stays quiet when there are none", () => {
    expect(completionMessage("d", counts({ failures: 2 }))).toContain("2 failed");
    expect(completionMessage("d", counts())).not.toContain("failed");
  });

  it("degrades to just the cron name when a fire threw before counting", () => {
    expect(
      completionMessage("e", counts({ reposEligible: null, reposScanned: null, discovered: null, dispatched: null, failures: null })),
    ).toBe("Cron fire complete: e");
  });
});

describe("the completion line the runner actually emits", () => {
  /**
   * Regression: `completionMessage` was built correctly and then NOT used on
   * the success branch, which still passed a hardcoded "Cron fire complete".
   * Every fire is `ok` in practice, so the common path — the one issue #341 is
   * about — shipped with none of the improvement, and unit-testing the builder
   * in isolation could not see it. These assert the LOGGED message.
   */
  const runFire = async (over: Record<string, unknown> = {}) => {
    const runner = makeCronRunner({
      db,
      github: fakeGh,
      discoverers: { "green-dependency-prs": async () => [] },
      dispatch: vi.fn(async () => ({ success: true })),
      resolveRepos: allParticipate,
    });
    await runner("dependabot-pr-merge", {
      discover: "green-dependency-prs",
      repos: ["o/a", "o/b"],
      _cronName: "merge-green-dependency-prs",
      ...over,
    });
  };

  it("names the cron and counts on the SUCCESS path", async () => {
    await runFire();
    const [msg] = logSpy.info.mock.calls.at(-1) as [string];
    expect(msg).toBe("Cron fire complete: merge-green-dependency-prs — scanned 2, found 0, dispatched 0");
  });

  it("names the cron and counts on the FAILED path", async () => {
    const runner = makeCronRunner({
      db,
      github: fakeGh,
      discoverers: { "green-dependency-prs": async () => { throw new Error("gh down"); } },
      dispatch: vi.fn(),
      resolveRepos: allParticipate,
    });
    await expect(
      runner("dependabot-pr-merge", { discover: "green-dependency-prs", repos: ["o/a"], _cronName: "c-fail" }),
    ).rejects.toThrow();
    const [msg] = logSpy.error.mock.calls.at(-1) as [string];
    expect(msg).toBe("Cron fire complete: c-fail");
  });

  it("uses the builder rather than a literal, on every branch", async () => {
    await runFire();
    for (const fn of [logSpy.info, logSpy.warn, logSpy.error]) {
      for (const [msg] of fn.mock.calls as [string][]) {
        if (typeof msg === "string" && msg.startsWith("Cron fire complete")) {
          expect(msg).toBe(completionMessage("merge-green-dependency-prs", {
            reposEligible: 2, reposScanned: 2, discovered: 0, dispatched: 0, failures: 0,
          }));
        }
      }
    }
  });
});

describe("the removed Discovered PRs line", () => {
  it("carries discoverKey on the completion line instead", async () => {
    // `Discovered PRs` fired ~1s before the completion line and duplicated its
    // counts, without naming the cron. Its one unique datum moves here.
    const runner = makeCronRunner({
      db,
      github: fakeGh,
      discoverers: { "green-dependency-prs": async () => [] },
      dispatch: vi.fn(async () => ({ success: true })),
      resolveRepos: allParticipate,
    });
    await runner("dependabot-pr-merge", {
      discover: "green-dependency-prs",
      repos: ["o/a"],
      _cronName: "c-dk",
    });

    const [, fields] = logSpy.info.mock.calls.at(-1) as [string, Record<string, unknown>];
    expect(fields.discoverKey).toBe("green-dependency-prs");
  });

  it("omits discoverKey entirely for a non-discovery cron", async () => {
    const runner = makeCronRunner({
      db,
      github: fakeGh,
      discoverers: {},
      dispatch: vi.fn(async () => ({ success: true })),
      resolveRepos: allParticipate,
    });
    await runner("repo-health", { repos: ["o/a"], _cronName: "c-nodk" });

    const [, fields] = logSpy.info.mock.calls.at(-1) as [string, Record<string, unknown>];
    expect("discoverKey" in fields).toBe(false);
  });

  it("does not leak discoverKey into the ledger row", async () => {
    // `finish()` spreads `counts` straight into the store; discoverKey is not a
    // column and must not ride along.
    const runner = makeCronRunner({
      db,
      github: fakeGh,
      discoverers: { "green-dependency-prs": async () => [] },
      dispatch: vi.fn(async () => ({ success: true })),
      resolveRepos: allParticipate,
    });
    await runner("dependabot-pr-merge", {
      discover: "green-dependency-prs",
      repos: ["o/a"],
      _cronName: "c-leak",
    });

    const row = db.cronRuns.latestByCron().get("c-leak")!;
    expect(row.status).toBe("ok");
    expect("discoverKey" in row).toBe(false);
  });
});
