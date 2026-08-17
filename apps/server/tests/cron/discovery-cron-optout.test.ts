import { describe, it, expect, vi, beforeEach } from "vitest";

// src/cron/repo-crons.ts + src/cron/fanout.ts now log per-repo participation
// diagnostics via the pino LoggerPort instead of console — mock the logger
// module so the suite's stderr stays free of real pino JSON (no assertions
// here depend on the logged content).
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

import type { DependencyPr } from "#src/cron/dependabot-discovery.js";
import type { CronDispatcher } from "#src/cron/fanout.js";
import type { GitHubClient } from "#src/engine/github/github.js";

/**
 * Per-repo participation on a DISCOVERY cron (issue #180).
 *
 * The dependabot/pr-review crons don't fan out per repo — they discover PRs
 * across the repo list first and then fan out one run per PR — so they take a
 * different branch in `src/index.ts` than `dispatchCronWorkflow`. That branch
 * used to read `context.repos` verbatim, which meant a repo that opted out of
 * e.g. `dependabot-merge` in its `.lastlight/lastlight.yml` still got runs.
 *
 * These tests drive the real context producer (`jobs.ts`), the real resolver
 * (`repo-crons.ts`), the real fan-out and the real runner, with the repo layer
 * stubbed at the `repo-config` seam.
 *
 * They used to reproduce `index.ts`'s discovery branch in a local helper and
 * pin the original by reading its source, because `src/index.ts` calls `main()`
 * at module scope and cannot be imported. That branch now lives in
 * `src/cron/runner.ts` behind `makeCronRunner`, so these drive the shipping
 * code directly and the source-scrape guard is gone with the copy it guarded.
 */

const repoLayers = new Map<string, { config?: Record<string, unknown>; cached?: boolean; fail?: string }>();
const fetchSpy = vi.fn();
const policy = {
  enabled: true,
  allowKeys: ["models", "variants", "crons", "disabled.workflows", "disabled.crons", "approval"],
  allowedModels: null as string[] | null,
  allowAssets: true,
};

vi.mock("#src/config/repo-config.js", () => ({
  repoConfigPolicy: () => policy,
  getCachedRepoLayer: (repo: string) => {
    const entry = repoLayers.get(repo);
    return entry?.cached ? { repo, config: entry.config } : undefined;
  },
  fetchRepoLayer: async (repo: string) => {
    fetchSpy(repo);
    const entry = repoLayers.get(repo);
    if (entry?.fail) throw new Error(entry.fail);
    return entry ? { repo, config: entry.config } : undefined;
  },
}));

const cronDefs = vi.fn(() => [
  {
    name: "dependabot-merge",
    workflow: "dependabot-merge",
    schedule: "0 * * * *",
    context: { discover: "green-dependency-prs" },
  },
]);
vi.mock("#src/workflows/loader.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("#src/workflows/loader.js")>();
  return { ...actual, getCronWorkflows: () => cronDefs() };
});

const managedRepos = vi.fn(() => ["acme/in", "acme/out"]);
vi.mock("#src/managed-repos.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("#src/managed-repos.js")>();
  return { ...actual, getAccessibleManagedRepos: () => managedRepos() };
});

const { getJobs } = await import("#src/cron/jobs.js");
const { CRON_NAME_KEY } = await import("#src/cron/repo-crons.js");
const { makeCronRunner } = await import("#src/cron/runner.js");
const { StateDb } = await import("#src/state/db.js");

/**
 * Fire the REAL runner over the real collaborators and hand back the counts it
 * recorded. Reading them off the ledger rather than a return value is the point
 * of the feature: the runner writes the outcome, it does not return it.
 */
async function discoveryTick(
  job: { workflow: string; context: Record<string, unknown> },
  discoverer: (repos: string[]) => Promise<DependencyPr[]>,
  dispatch: CronDispatcher,
) {
  const db = new StateDb(":memory:");
  try {
    const runner = makeCronRunner({
      db,
      github: {} as unknown as GitHubClient,
      discoverers: { "green-dependency-prs": (repos) => discoverer(repos) },
      dispatch,
    });
    await runner(job.workflow, job.context);

    const cronName = job.context[CRON_NAME_KEY];
    const row = typeof cronName === "string" ? db.cronRuns.latestByCron().get(cronName) : undefined;
    return {
      dispatched: row?.dispatched ?? 0,
      failures: row?.failures ?? 0,
      reposScanned: row?.reposScanned ?? null,
      status: row?.status ?? null,
    };
  } finally {
    db.close();
  }
}

/** A discoverer that finds exactly one PR per repo it is given. */
function fakeDiscoverer() {
  return vi.fn(async (repos: string[]) =>
    repos.map((repo, i) => ({ repo, prNumber: i + 1, title: `Bump dep in ${repo}` }) as DependencyPr),
  );
}

const okDispatch: CronDispatcher = vi.fn(async () => ({ success: true }));

beforeEach(() => {
  repoLayers.clear();
  fetchSpy.mockClear();
  vi.mocked(okDispatch).mockClear();
  policy.allowKeys = ["models", "variants", "crons", "disabled.workflows", "disabled.crons", "approval"];
});

describe("discovery cron participation", () => {
  it("skips a repo that opted out — it is never even discovered against", async () => {
    repoLayers.set("acme/out", { config: { crons: { disable: ["dependabot-merge"] } }, cached: true });
    const [job] = getJobs();
    const discoverer = fakeDiscoverer();

    const result = await discoveryTick(job, discoverer, okDispatch);

    // The opted-out repo costs nothing: no listing call, no PRs, no runs.
    expect(discoverer).toHaveBeenCalledWith(["acme/in"]);
    expect(result.dispatched).toBe(1);
    expect(vi.mocked(okDispatch).mock.calls.map((c) => (c[1] as { repo: string }).repo)).toEqual(["acme/in"]);
  });

  it("fans out over every repo when nobody opted out", async () => {
    const [job] = getJobs();
    const discoverer = fakeDiscoverer();

    await discoveryTick(job, discoverer, okDispatch);

    expect(discoverer).toHaveBeenCalledWith(["acme/in", "acme/out"]);
    expect(vi.mocked(okDispatch)).toHaveBeenCalledTimes(2);
  });

  it("runs only the opted-in repos when the cron is globally off", async () => {
    repoLayers.set("acme/in", { config: { crons: { enable: ["dependabot-merge"] } }, cached: true });
    const db = { getAllCronOverrides: () => new Map([["dependabot-merge", { enabled: false }]]) };
    const [job] = getJobs({ db: db as unknown as import("#src/state/db.js").StateDb });
    const discoverer = fakeDiscoverer();

    await discoveryTick(job, discoverer, okDispatch);

    expect(discoverer).toHaveBeenCalledWith(["acme/in"]);
    expect(vi.mocked(okDispatch)).toHaveBeenCalledTimes(1);
  });

  it("is a free no-op tick when a globally-off cron has no takers", async () => {
    const db = { getAllCronOverrides: () => new Map([["dependabot-merge", { enabled: false }]]) };
    const [job] = getJobs({ db: db as unknown as import("#src/state/db.js").StateDb });
    const discoverer = fakeDiscoverer();

    const result = await discoveryTick(job, discoverer, okDispatch);

    // No discovery calls at all — the expensive part of a sweep is the GitHub
    // listing, and there is nothing to list for.
    expect(discoverer).not.toHaveBeenCalled();
    expect(result).toMatchObject({ dispatched: 0, failures: 0 });
    // Recorded, not silent: the tick is a green no-op rather than an absent row.
    expect(result.status).toBe("ok");
    expect(result.reposScanned).toBe(0);
  });

  it("does not block the tick on a repo whose layer can't be read", async () => {
    repoLayers.set("acme/in", { fail: "GitHub is down" });
    repoLayers.set("acme/out", { config: { crons: { disable: ["dependabot-merge"] } } });
    const [job] = getJobs();
    const discoverer = fakeDiscoverer();

    await discoveryTick(job, discoverer, okDispatch);

    // The unreadable repo falls back to its inherited (global) behaviour; the
    // readable opt-out is still honoured. Both misses were fetched, not cached.
    expect(discoverer).toHaveBeenCalledWith(["acme/in"]);
    expect(fetchSpy.mock.calls.map((c) => c[0]).sort()).toEqual(["acme/in", "acme/out"]);
  });

  it("uses the repo list verbatim when the context carries no cron name", async () => {
    // A caller that builds its own context (a manual fire from a script, a test)
    // behaves exactly as it did before per-repo participation existed.
    repoLayers.set("acme/out", { config: { crons: { disable: ["dependabot-merge"] } }, cached: true });
    const discoverer = fakeDiscoverer();

    await discoveryTick(
      {
        workflow: "dependabot-merge",
        // `discover` is what selects a discoverer at all — the cron NAME is the
        // key deliberately absent here.
        context: { discover: "green-dependency-prs", repos: ["acme/in", "acme/out"] },
      },
      discoverer,
      okDispatch,
    );

    expect(discoverer).toHaveBeenCalledWith(["acme/in", "acme/out"]);
  });
});
