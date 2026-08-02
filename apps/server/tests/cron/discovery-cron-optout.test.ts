import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

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
 * (`repo-crons.ts`) and the real fan-out with the repo layer stubbed at the
 * `repo-config` seam, then pin `index.ts`'s wiring to them. The wiring itself
 * has to be pinned by reading the source: `src/index.ts` calls `main()` at
 * module scope, so a test can't import it.
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
const { fanOutContexts } = await import("#src/cron/fanout.js");
const { CRON_GLOBALLY_ENABLED_KEY, CRON_NAME_KEY, resolveCronRepos } = await import("#src/cron/repo-crons.js");

/**
 * The discovery branch of `src/index.ts`'s cron runner, reproduced over the real
 * collaborators: narrow the repos, discover across the survivors, fan out one
 * context per PR. Kept to the same shape as the source so the guard test below
 * stays meaningful.
 */
async function discoveryTick(
  job: { workflow: string; context: Record<string, unknown> },
  discoverer: (repos: string[]) => Promise<DependencyPr[]>,
  dispatch: CronDispatcher,
) {
  const candidates = (job.context.repos as string[]) ?? [];
  const cronName = typeof job.context[CRON_NAME_KEY] === "string" ? (job.context[CRON_NAME_KEY] as string) : "";
  const repos = cronName
    ? (
        await resolveCronRepos({
          cron: cronName,
          repos: candidates,
          globallyEnabled: job.context[CRON_GLOBALLY_ENABLED_KEY] !== false,
        })
      ).repos
    : candidates;
  const prs = repos.length ? await discoverer(repos) : [];
  return fanOutContexts(
    job.workflow,
    prs.map((pr) => ({ _triggerType: "cron", repo: pr.repo, prNumber: pr.prNumber, title: pr.title })),
    dispatch,
  );
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
    expect(result).toEqual({ dispatched: 0, failures: 0 });
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
      { workflow: "dependabot-merge", context: { repos: ["acme/in", "acme/out"] } },
      discoverer,
      okDispatch,
    );

    expect(discoverer).toHaveBeenCalledWith(["acme/in", "acme/out"]);
  });
});

describe("src/index.ts wiring", () => {
  /**
   * A source-level guard, not a style check: `index.ts` runs `main()` on import,
   * so the only way to pin its discovery branch to `resolveCronRepos` is to read
   * it. Without the narrowing, every behaviour above is unreachable in prod.
   */
  const source = readFileSync(fileURLToPath(new URL("../../src/index.ts", import.meta.url)), "utf-8");
  const branch = source.slice(source.indexOf("if (discoverer) {"), source.indexOf("fanOutContexts(workflowName, contexts"));

  it("narrows the repo list through resolveCronRepos before discovering", () => {
    expect(branch).toContain("resolveCronRepos({");
    expect(branch.indexOf("resolveCronRepos({")).toBeLessThan(branch.indexOf("await discoverer("));
  });

  it("reads the cron name and the globally-enabled flag from the tick context", () => {
    expect(branch).toContain("CRON_NAME_KEY");
    expect(branch).toContain(`${"CRON_GLOBALLY_ENABLED_KEY"}] !== false`);
  });
});
