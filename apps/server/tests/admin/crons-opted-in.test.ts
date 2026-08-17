import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { AdminConfig } from "#src/admin/routes.js";
import type { LastLightConfig, RepoConfigPolicy } from "#src/config/config.js";
import type { StateDb } from "#src/state/db.js";
import type { SessionReader } from "#src/admin/sessions.js";

/**
 * `GET /crons` → `optedInRepos` (issue #180).
 *
 * A globally-off cron keeps its scheduler tick, because a managed repo can opt
 * itself back in from its `.lastlight/lastlight.yml` and that is resolved at
 * TICK time. So the list endpoint reports `registered: true` + a real `nextRun`
 * for a cron whose toggle is off, and the dashboard needs to know WHO that tick
 * is for before it can render the timestamp honestly.
 *
 * Two properties matter here and are asserted separately:
 *   1. the list is correct (opt-in listed, opt-out never listed), and
 *   2. computing it costs nothing — cached layers only, and zero lookups at all
 *      when the operator's policy means no repo can vote.
 */

const cachedLayers = new Map<string, { config?: Record<string, unknown> }>();

const getCachedRepoLayer = vi.fn((repo: string) => {
  const entry = cachedLayers.get(repo);
  return entry ? { repo, config: entry.config } : undefined;
});
/** Must never be called by a list endpoint — one page load would become N GETs. */
const fetchRepoLayer = vi.fn(async () => undefined);

const DEFAULT_ALLOW_KEYS = [
  "models",
  "variants",
  "crons",
  "disabled.workflows",
  "disabled.crons",
  "approval",
];

let policy: RepoConfigPolicy = {
  enabled: true,
  allowKeys: [...DEFAULT_ALLOW_KEYS],
  allowedModels: null,
  allowAssets: true,
};

vi.mock("#src/config/repo-config.js", () => ({
  repoConfigPolicy: () => policy,
  getCachedRepoLayer: (repo: string) => getCachedRepoLayer(repo),
  fetchRepoLayer: () => fetchRepoLayer(),
}));

vi.mock("#src/workflows/loader.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("#src/workflows/loader.js")>();
  return {
    ...actual,
    getCronWorkflows: vi.fn(() => [
      { name: "repo-health", workflow: "repo-health", schedule: "0 9 * * 1", context: {} },
    ]),
  };
});

// Neither client is reachable in a unit test, and the cron list doesn't need them.
vi.mock("#src/admin/docker.js", () => ({
  listRunningContainers: vi.fn(async () => []),
  killContainer: vi.fn(async () => {}),
  getContainerStats: vi.fn(async () => []),
  getHostStats: vi.fn(async () => null),
}));
vi.mock("#src/sandbox/k8s/client.js", () => ({ makeK8sApis: vi.fn(() => ({}) as unknown) }));

const { createAdminRoutes } = await import("#src/admin/routes.js");
const { setRuntimeConfig, resetRuntimeConfigForTests } = await import("#src/config/config.js");

interface CronRow {
  name: string;
  enabled: boolean;
  registered: boolean;
  nextRun: string | null;
  optedInRepos: string[];
}

function fakeDb(overrides: Record<string, { enabled: boolean; schedule?: string }> = {}) {
  const rows = new Map(Object.entries(overrides));
  return {
    getAllCronOverrides: () => rows,
    getCronOverride: (name: string) => rows.get(name),
    // `GET /crons` reads one ledger for every cron (issues #341/#327). These
    // tests are about participation, not fire outcomes, so an empty ledger is
    // the honest fixture — and it cannot agree with a bug the way the old
    // `consecutiveFailures: () => 0` stub did, since that returned exactly what
    // the broken implementation always returned.
    cronRuns: { latestByCron: () => new Map(), recentFailures: () => 0 },
  } as unknown as StateDb;
}

/** A scheduler holding the globally-off cron's still-live job (the whole point). */
function schedulerWith(nextRun: Date | null) {
  return {
    has: () => true,
    list: () => [{ name: "repo-health", schedule: "0 9 * * 1", workflow: "repo-health", nextRun }],
    register: vi.fn(),
    update: vi.fn(),
    unregister: vi.fn(),
  } as unknown as NonNullable<AdminConfig["cronScheduler"]>;
}

function makeApp(over: Partial<AdminConfig> = {}, db: StateDb = fakeDb({ "repo-health": { enabled: false } })) {
  return createAdminRoutes(db, {} as unknown as SessionReader, {} as unknown as SessionReader, {
    stateDir: "/tmp",
    sessionsDir: "/tmp/sessions",
    adminPassword: "",
    adminSecret: "test-secret",
    cronScheduler: schedulerWith(new Date("2099-01-01T09:00:00.000Z")),
    ...over,
  } as AdminConfig);
}

async function listCrons(app: ReturnType<typeof makeApp>): Promise<CronRow[]> {
  const res = await app.fetch(new Request("http://localhost/crons"));
  expect(res.status).toBe(200);
  return ((await res.json()) as { crons: CronRow[] }).crons;
}

beforeEach(() => {
  cachedLayers.clear();
  getCachedRepoLayer.mockClear();
  fetchRepoLayer.mockClear();
  policy = { enabled: true, allowKeys: [...DEFAULT_ALLOW_KEYS], allowedModels: null, allowAssets: true };
  setRuntimeConfig({
    stateDir: "/tmp",
    managedRepos: ["acme/in", "acme/out", "acme/quiet"],
    models: {},
    variants: {},
    disabled: { workflows: [], crons: [], prompts: [], skills: [], agentContext: [] },
    crons: { enable: [], disable: [] },
    repoConfig: policy,
  } as unknown as LastLightConfig);
});

afterEach(() => resetRuntimeConfigForTests());

describe("GET /crons → optedInRepos", () => {
  it("is empty for a disabled cron nobody opted into — the tick is a no-op", async () => {
    const [cron] = await listCrons(makeApp());

    expect(cron.enabled).toBe(false);
    // The surprising part, and exactly why the field exists: the job is STILL
    // registered with a real next run, so the UI can't infer "does nothing" from
    // the scheduler alone.
    expect(cron.registered).toBe(true);
    expect(cron.nextRun).not.toBeNull();
    expect(cron.optedInRepos).toEqual([]);
  });

  it("lists exactly the repo that opted in via its cached layer", async () => {
    cachedLayers.set("acme/in", { config: { crons: { enable: ["repo-health"] } } });
    cachedLayers.set("acme/quiet", { config: { crons: { enable: ["some-other-cron"] } } });

    const [cron] = await listCrons(makeApp());

    expect(cron.optedInRepos).toEqual(["acme/in"]);
  });

  it("never lists a repo that opted out — including one that says both (disable wins)", async () => {
    cachedLayers.set("acme/out", { config: { crons: { disable: ["repo-health"] } } });
    cachedLayers.set("acme/quiet", {
      config: { crons: { enable: ["repo-health"], disable: ["repo-health"] } },
    });

    const [cron] = await listCrons(makeApp());

    expect(cron.optedInRepos).toEqual([]);
  });

  it("also reports opt-ins for an ENABLED cron, where they're merely redundant", async () => {
    cachedLayers.set("acme/in", { config: { crons: { enable: ["repo-health"] } } });

    const [cron] = await listCrons(makeApp({}, fakeDb()));

    expect(cron.enabled).toBe(true);
    expect(cron.optedInRepos).toEqual(["acme/in"]);
  });

  it("reads cached layers only — a list endpoint must never fetch", async () => {
    // `acme/in` has a layer in cache; the other two do not. A cache miss must
    // stay a miss rather than falling through to the network the way a tick does.
    cachedLayers.set("acme/in", { config: { crons: { enable: ["repo-health"] } } });

    const [cron] = await listCrons(makeApp());

    expect(cron.optedInRepos).toEqual(["acme/in"]);
    expect(getCachedRepoLayer).toHaveBeenCalledTimes(3);
    expect(fetchRepoLayer).not.toHaveBeenCalled();
  });

  it("short-circuits with zero lookups when the repo-config feature is off", async () => {
    cachedLayers.set("acme/in", { config: { crons: { enable: ["repo-health"] } } });
    policy = { ...policy, enabled: false };

    const [cron] = await listCrons(makeApp());

    expect(cron.optedInRepos).toEqual([]);
    expect(getCachedRepoLayer).not.toHaveBeenCalled();
    expect(fetchRepoLayer).not.toHaveBeenCalled();
  });

  it("short-circuits with zero lookups when `crons` is outside allowKeys", async () => {
    cachedLayers.set("acme/in", { config: { crons: { enable: ["repo-health"] } } });
    // The operator's documented kill switch: drop every cron key from the
    // allow-list and no repo gets a vote, so nothing is worth looking up.
    policy = { ...policy, allowKeys: ["models", "variants"] };

    const [cron] = await listCrons(makeApp());

    expect(cron.optedInRepos).toEqual([]);
    expect(getCachedRepoLayer).not.toHaveBeenCalled();
    expect(fetchRepoLayer).not.toHaveBeenCalled();
  });
});
