import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// src/cron/fanout.ts now logs per-repo participation diagnostics via the pino
// LoggerPort instead of console — mock the logger module so the suite's
// stderr stays free of real pino JSON (no assertions here depend on the
// logged content).
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

import type { AdminConfig } from "#src/admin/routes.js";
import type { LastLightConfig } from "#src/config/config.js";
import type { CronJob, CronScheduler } from "#src/cron/scheduler.js";
import type { StateDb } from "#src/state/db.js";
import type { SessionReader } from "#src/admin/sessions.js";
import type { CronDispatcher } from "#src/cron/fanout.js";

/**
 * Cron control keys are system-injected and must not be spoofable from a cron
 * YAML's own `context:` block (issue #180, PR #254 review).
 *
 * `_cronName` and `_cronGloballyEnabled` are how a registered tick tells the
 * fan-out which cron it is and whether it is globally on; the fan-out strips
 * them and resolves per-repo opt-in/opt-out from them. If a cron YAML's
 * `context:` could override them, a stray `_cronName` would apply ANOTHER
 * cron's per-repo rules to this tick, and a stray `_cronGloballyEnabled: true`
 * would make a disabled cron fan out to everyone.
 *
 * The distinction that matters: `context.repos` IS deliberately overridable —
 * a cron YAML may pin its own repo list — so these tests pin both halves, the
 * key that must not be overridable and the one that must stay so.
 */

const repoLayers = new Map<string, { config?: Record<string, unknown> }>();
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
    return entry ? { repo, config: entry.config } : undefined;
  },
  fetchRepoLayer: async (repo: string) => {
    const entry = repoLayers.get(repo);
    return entry ? { repo, config: entry.config } : undefined;
  },
}));

/** The cron definition under test — each test rewrites this before acting. */
let cronDef: { name: string; workflow: string; schedule: string; context: Record<string, unknown> } = {
  name: "repo-health",
  workflow: "repo-health",
  schedule: "0 9 * * 1",
  context: { mode: "report" },
};

vi.mock("#src/workflows/loader.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("#src/workflows/loader.js")>();
  return { ...actual, getCronWorkflows: () => [cronDef] };
});

vi.mock("#src/managed-repos.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("#src/managed-repos.js")>();
  return {
    ...actual,
    getManagedRepos: () => ["acme/in", "acme/out"],
    getAccessibleManagedRepos: () => ["acme/in", "acme/out"],
  };
});

// Unreachable in a unit test and unused by the cron routes.
vi.mock("#src/admin/docker.js", () => ({
  listRunningContainers: vi.fn(async () => []),
  killContainer: vi.fn(async () => {}),
  getContainerStats: vi.fn(async () => []),
  getHostStats: vi.fn(async () => null),
}));
vi.mock("#src/sandbox/k8s/client.js", () => ({ makeK8sApis: vi.fn(() => ({}) as unknown) }));

const { getJobs } = await import("#src/cron/jobs.js");
const { dispatchCronWorkflow } = await import("#src/cron/fanout.js");
const { CRON_NAME_KEY, CRON_GLOBALLY_ENABLED_KEY } = await import("#src/cron/repo-crons.js");
const { createAdminRoutes } = await import("#src/admin/routes.js");
const { setRuntimeConfig, resetRuntimeConfigForTests } = await import("#src/config/config.js");

function fakeDb(overrides: Record<string, { enabled: boolean; schedule?: string }> = {}) {
  const rows = new Map(Object.entries(overrides));
  return {
    getAllCronOverrides: () => rows,
    getCronOverride: (name: string) => rows.get(name),
    setCronOverride: (name: string, patch: { enabled?: boolean; schedule?: string }) => {
      rows.set(name, { ...(rows.get(name) ?? { enabled: true }), ...patch });
    },
    clearCronOverride: (name: string) => rows.delete(name),
    // `GET /crons` reads one ledger for every cron (issues #341/#327). These
    // tests are about participation, not fire outcomes, so an empty ledger is
    // the honest fixture — and it cannot agree with a bug the way the old
    // `consecutiveFailures: () => 0` stub did, since that returned exactly what
    // the broken implementation always returned.
    cronRuns: { latestByCron: () => new Map(), recentFailures: () => 0 },
  } as unknown as StateDb;
}

function fakeScheduler() {
  const jobs = new Map<string, CronJob>();
  const scheduler = {
    has: (name: string) => jobs.has(name),
    list: () => [...jobs.values()],
    register: (job: CronJob) => void jobs.set(job.name, job),
    update: (job: CronJob) => void jobs.set(job.name, job),
    unregister: (name: string) => void jobs.delete(name),
  };
  return { scheduler: scheduler as unknown as CronScheduler, jobs };
}

function runtimeConfig(): LastLightConfig {
  return {
    stateDir: "/tmp",
    managedRepos: ["acme/in", "acme/out"],
    models: {},
    variants: {},
    disabled: { workflows: [], crons: [], prompts: [], skills: [], agentContext: [] },
    crons: { enable: [], disable: [] },
    repoConfig: policy,
  } as unknown as LastLightConfig;
}

function makeApp(over: Partial<AdminConfig>, db: StateDb) {
  return createAdminRoutes(db, {} as unknown as SessionReader, {} as unknown as SessionReader, {
    stateDir: "/tmp",
    sessionsDir: "/tmp/sessions",
    adminPassword: "",
    adminSecret: "test-secret",
    ...over,
  } as AdminConfig);
}

/** Run a context the way the scheduler would, reporting which repos it reached. */
async function tick(context: Record<string, unknown>) {
  const dispatch = vi.fn(async () => ({ success: true })) as unknown as CronDispatcher;
  await dispatchCronWorkflow("repo-health", context, dispatch);
  return vi.mocked(dispatch).mock.calls.map((c) => (c[1] as { repo: string }).repo);
}

beforeEach(() => {
  repoLayers.clear();
  cronDef = { name: "repo-health", workflow: "repo-health", schedule: "0 9 * * 1", context: { mode: "report" } };
  setRuntimeConfig(runtimeConfig());
});

afterEach(() => resetRuntimeConfigForTests());

describe("getJobs — control keys are not spoofable from cron YAML", () => {
  it("ignores `_cronName` and `_cronGloballyEnabled` declared in the YAML context", () => {
    cronDef.context = { mode: "report", [CRON_NAME_KEY]: "some-other-cron", [CRON_GLOBALLY_ENABLED_KEY]: true };

    const [job] = getJobs({ webhooksEnabled: false, db: fakeDb({ "repo-health": { enabled: false } }) });

    expect(job.context[CRON_NAME_KEY]).toBe("repo-health");
    expect(job.context[CRON_GLOBALLY_ENABLED_KEY]).toBe(false);
    // Non-control keys from the YAML are untouched.
    expect(job.context.mode).toBe("report");
  });

  it("still lets a cron YAML pin its own context.repos (deliberate, must not regress)", () => {
    cronDef.context = { mode: "report", repos: ["acme/pinned"] };

    const [job] = getJobs({ webhooksEnabled: false, db: fakeDb() });

    expect(job.context.repos).toEqual(["acme/pinned"]);
  });

  it("a spoofed `_cronName` cannot borrow another cron's per-repo rules", async () => {
    // acme/out opts OUT of repo-health. The YAML claims to be a different cron,
    // which — if the spoof won — would mean that opt-out no longer matched.
    repoLayers.set("acme/out", { config: { crons: { disable: ["repo-health"] } } });
    cronDef.context = { mode: "report", [CRON_NAME_KEY]: "unrelated-cron" };

    const [job] = getJobs({ webhooksEnabled: false, db: fakeDb() });

    expect(await tick(job.context)).toEqual(["acme/in"]);
  });

  it("a spoofed `_cronGloballyEnabled` cannot resurrect a disabled cron", async () => {
    cronDef.context = { mode: "report", [CRON_GLOBALLY_ENABLED_KEY]: true };

    const [job] = getJobs({ webhooksEnabled: false, db: fakeDb({ "repo-health": { enabled: false } }) });

    // Globally off and nobody opted in — a no-op tick, not a fan-out to everyone.
    expect(await tick(job.context)).toEqual([]);
  });
});

describe("admin cron routes — control keys are not spoofable from cron YAML", () => {
  it("toggle-off rebuilds the context with the real name and enabled state", async () => {
    cronDef.context = { mode: "report", [CRON_NAME_KEY]: "some-other-cron", [CRON_GLOBALLY_ENABLED_KEY]: true };
    const { scheduler, jobs } = fakeScheduler();
    const app = makeApp({ cronScheduler: scheduler }, fakeDb());

    const res = await app.request("/crons/repo-health/toggle", { method: "POST" });
    expect(res.status).toBe(200);

    const ctx = jobs.get("repo-health")!.context as Record<string, unknown>;
    expect(ctx[CRON_NAME_KEY]).toBe("repo-health");
    expect(ctx[CRON_GLOBALLY_ENABLED_KEY]).toBe(false);
    expect(await tick(ctx)).toEqual([]);
  });

  it("'Run now' carries the real cron name so opt-outs are honoured", async () => {
    repoLayers.set("acme/out", { config: { crons: { disable: ["repo-health"] } } });
    cronDef.context = { mode: "report", [CRON_NAME_KEY]: "unrelated-cron" };
    const captured: Record<string, unknown>[] = [];
    const app = makeApp(
      {
        cronScheduler: fakeScheduler().scheduler,
        triggerCron: async (_wf: string, ctx: Record<string, unknown>) => {
          captured.push(ctx);
          return { success: true };
        },
      } as Partial<AdminConfig>,
      fakeDb(),
    );

    const res = await app.request("/crons/repo-health/trigger", { method: "POST" });
    expect(res.status).toBe(200);

    expect(captured[0][CRON_NAME_KEY]).toBe("repo-health");
    expect(await tick(captured[0])).toEqual(["acme/in"]);
  });

  it("'Run now' still fires a globally-disabled cron (absence of the flag is the signal)", async () => {
    // The YAML tries to force the flag in; stripping it is what keeps the button working.
    cronDef.context = { mode: "report", [CRON_GLOBALLY_ENABLED_KEY]: false };
    const captured: Record<string, unknown>[] = [];
    const app = makeApp(
      {
        cronScheduler: fakeScheduler().scheduler,
        triggerCron: async (_wf: string, ctx: Record<string, unknown>) => {
          captured.push(ctx);
          return { success: true };
        },
      } as Partial<AdminConfig>,
      fakeDb({ "repo-health": { enabled: false } }),
    );

    await app.request("/crons/repo-health/trigger", { method: "POST" });

    expect(captured[0]).not.toHaveProperty(CRON_GLOBALLY_ENABLED_KEY);
    expect(await tick(captured[0])).toEqual(["acme/in", "acme/out"]);
  });
});
