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
 * Admin cron routes vs per-repo participation (issue #180).
 *
 * Under the new model a globally-off cron KEEPS its tick: repos may opt back in
 * from their `.lastlight/lastlight.yml`, and that is resolved at tick time. So
 * the dashboard's off switch must re-register the job with
 * `_cronGloballyEnabled: false` rather than unregister it — unregistering makes
 * an opt-in silently do nothing until the next restart re-registers from
 * `jobs.ts`, at which point it starts working, which is the worst possible
 * failure shape to debug.
 *
 * Each test takes the context the route actually handed the scheduler and runs
 * it through the real fan-out, so what is asserted is "does the tick run the
 * right repos", not "was a flag copied".
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

vi.mock("#src/workflows/loader.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("#src/workflows/loader.js")>();
  return {
    ...actual,
    getCronWorkflows: vi.fn(() => [
      { name: "repo-health", workflow: "repo-health", schedule: "0 9 * * 1", context: { mode: "report" } },
    ]),
  };
});

// Neither the docker nor the k8s client is reachable in a unit test, and the
// cron routes don't need them.
vi.mock("#src/admin/docker.js", () => ({
  listRunningContainers: vi.fn(async () => []),
  killContainer: vi.fn(async () => {}),
  getContainerStats: vi.fn(async () => []),
  getHostStats: vi.fn(async () => null),
}));
vi.mock("#src/sandbox/k8s/client.js", () => ({ makeK8sApis: vi.fn(() => ({}) as unknown) }));

// Values are imported dynamically (after the mock factories' captured state is
// initialized); the types come in statically, where they are erased anyway.
const { createAdminRoutes } = await import("#src/admin/routes.js");
const { setRuntimeConfig, resetRuntimeConfigForTests } = await import("#src/config/config.js");
const { dispatchCronWorkflow } = await import("#src/cron/fanout.js");

/** A scheduler that records what it was asked to do instead of arming timers. */
function fakeScheduler() {
  const jobs = new Map<string, CronJob>();
  const calls: string[] = [];
  const scheduler = {
    has: (name: string) => jobs.has(name),
    list: () => [...jobs.values()],
    register(job: CronJob) {
      calls.push(`register:${job.name}`);
      jobs.set(job.name, job);
    },
    update(job: CronJob) {
      calls.push(`update:${job.name}`);
      jobs.set(job.name, job);
    },
    unregister(name: string) {
      calls.push(`unregister:${name}`);
      jobs.delete(name);
    },
  };
  return { scheduler: scheduler as unknown as CronScheduler, jobs, calls };
}

function fakeDb(overrides: Record<string, { enabled: boolean; schedule?: string }> = {}) {
  const rows = new Map(Object.entries(overrides));
  return {
    getAllCronOverrides: () => rows,
    getCronOverride: (name: string) => rows.get(name),
    setCronOverride: (name: string, patch: { enabled?: boolean; schedule?: string }) => {
      rows.set(name, { ...(rows.get(name) ?? { enabled: true }), ...patch });
    },
    clearCronOverride: (name: string) => rows.delete(name),
    executions: { consecutiveFailures: () => 0 },
    runs: { listRecent: () => [] },
  } as unknown as StateDb;
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

function makeApp(over: Partial<AdminConfig>, db: StateDb = fakeDb()) {
  return createAdminRoutes(db, {} as unknown as SessionReader, {} as unknown as SessionReader, {
    stateDir: "/tmp",
    sessionsDir: "/tmp/sessions",
    adminPassword: "",
    adminSecret: "test-secret",
    ...over,
  } as AdminConfig);
}

/** Run a recorded job the way the scheduler would: runner(job.workflow, job.context). */
async function tick(context: Record<string, unknown>) {
  const dispatch = vi.fn(async () => ({ success: true })) as unknown as CronDispatcher;
  const result = await dispatchCronWorkflow("repo-health", context, dispatch);
  const repos = vi.mocked(dispatch).mock.calls.map((c) => (c[1] as { repo: string }).repo);
  return { ...result, repos };
}

beforeEach(() => {
  repoLayers.clear();
  setRuntimeConfig(runtimeConfig());
});

afterEach(() => resetRuntimeConfigForTests());

describe("POST /crons/:name/toggle", () => {
  it("keeps the tick registered when a cron is switched off", async () => {
    const { scheduler, jobs, calls } = fakeScheduler();
    scheduler.register({ name: "repo-health", schedule: "0 9 * * 1", workflow: "repo-health", context: {} });
    const app = makeApp({ cronScheduler: scheduler });

    const res = await app.fetch(
      new Request("http://localhost/crons/repo-health/toggle", { method: "POST" }),
      undefined,
    );

    expect(await res.json()).toEqual({ name: "repo-health", enabled: false });
    expect(calls).not.toContain("unregister:repo-health");
    expect(jobs.has("repo-health")).toBe(true);
    expect(jobs.get("repo-health")!.context).toMatchObject({
      _cronName: "repo-health",
      _cronGloballyEnabled: false,
    });
  });

  it("…and that tick still runs a repo that opted in", async () => {
    repoLayers.set("acme/in", { config: { crons: { enable: ["repo-health"] } } });
    const { scheduler, jobs } = fakeScheduler();
    scheduler.register({ name: "repo-health", schedule: "0 9 * * 1", workflow: "repo-health", context: {} });
    const app = makeApp({ cronScheduler: scheduler });

    await app.fetch(new Request("http://localhost/crons/repo-health/toggle", { method: "POST" }));
    const ran = await tick(jobs.get("repo-health")!.context);

    // Exactly the repo that asked for it — the other managed repo is untouched.
    expect(ran.repos).toEqual(["acme/in"]);
  });

  it("switching back on runs everyone except the repos that opted out", async () => {
    repoLayers.set("acme/out", { config: { crons: { disable: ["repo-health"] } } });
    const { scheduler, jobs } = fakeScheduler();
    const app = makeApp({ cronScheduler: scheduler });

    // off, then on again
    await app.fetch(new Request("http://localhost/crons/repo-health/toggle", { method: "POST" }));
    await app.fetch(new Request("http://localhost/crons/repo-health/toggle", { method: "POST" }));

    expect(jobs.get("repo-health")!.context).toMatchObject({
      _cronName: "repo-health",
      _cronGloballyEnabled: true,
    });
    expect((await tick(jobs.get("repo-health")!.context)).repos).toEqual(["acme/in"]);
  });

  it("a globally-off tick nobody opted into dispatches nothing", async () => {
    const { scheduler, jobs } = fakeScheduler();
    const app = makeApp({ cronScheduler: scheduler });

    await app.fetch(new Request("http://localhost/crons/repo-health/toggle", { method: "POST" }));

    expect(await tick(jobs.get("repo-health")!.context)).toMatchObject({ dispatched: 0, failures: 0 });
  });
});

describe("the other routes that re-register a job", () => {
  it("PUT-ing a schedule keeps the participation keys on the context", async () => {
    repoLayers.set("acme/out", { config: { crons: { disable: ["repo-health"] } } });
    const { scheduler, jobs } = fakeScheduler();
    const app = makeApp({ cronScheduler: scheduler });

    await app.fetch(
      new Request("http://localhost/crons/repo-health/schedule", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ schedule: "30 8 * * *" }),
      }),
    );

    expect(jobs.get("repo-health")!.schedule).toBe("30 8 * * *");
    expect((await tick(jobs.get("repo-health")!.context)).repos).toEqual(["acme/in"]);
  });

  it("clearing the override re-registers a globally-ON tick", async () => {
    repoLayers.set("acme/out", { config: { crons: { disable: ["repo-health"] } } });
    const { scheduler, jobs } = fakeScheduler();
    const app = makeApp({ cronScheduler: scheduler });

    await app.fetch(new Request("http://localhost/crons/repo-health/override", { method: "DELETE" }));

    expect(jobs.get("repo-health")!.context).toMatchObject({ _cronGloballyEnabled: true });
    expect((await tick(jobs.get("repo-health")!.context)).repos).toEqual(["acme/in"]);
  });
});

describe('POST /crons/:name/trigger ("Run now")', () => {
  it("carries the cron name, so a manual fire honours per-repo opt-outs", async () => {
    repoLayers.set("acme/out", { config: { crons: { disable: ["repo-health"] } } });
    const triggered: Record<string, unknown>[] = [];
    const app = makeApp({
      triggerCron: async (_workflow, context) => {
        triggered.push(context);
      },
    });

    const res = await app.fetch(new Request("http://localhost/crons/repo-health/trigger", { method: "POST" }));

    expect(res.status).toBe(200);
    expect(triggered[0]).toMatchObject({ _cronName: "repo-health" });
    expect((await tick(triggered[0])).repos).toEqual(["acme/in"]);
  });

  it("still fires for a globally-disabled cron — that is what the button is for", async () => {
    const triggered: Record<string, unknown>[] = [];
    const app = makeApp({
      triggerCron: async (_workflow, context) => {
        triggered.push(context);
      },
    });

    await app.fetch(new Request("http://localhost/crons/repo-health/trigger", { method: "POST" }));

    // No `_cronGloballyEnabled` key at all: absent means "on" to the fan-out.
    expect(triggered[0]).not.toHaveProperty("_cronGloballyEnabled");
    expect((await tick(triggered[0])).repos).toEqual(["acme/in", "acme/out"]);
  });
});
