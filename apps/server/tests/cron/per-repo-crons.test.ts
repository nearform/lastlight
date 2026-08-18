import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

// src/cron/repo-crons.ts + src/cron/fanout.ts now log per-repo participation
// diagnostics via the pino LoggerPort instead of console — mock the logger
// module so the suite's stderr stays free of real pino JSON (this suite
// deliberately fails a repo-layer fetch to prove one repo's bad day doesn't
// sink the tick; no assertions here depend on the logged content).
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

import type { CronDispatcher } from "#src/cron/fanout.js";

/**
 * Per-repo cron participation (issue #180) — the `crons: {enable, disable}`
 * block at the operator and repo layers, and the tick-time fan-out it drives.
 *
 * The repo layer is stubbed at the `repo-config` seam: these tests are about
 * WHO a tick fans out to, not about fetching/unpacking `.lastlight/` (that is
 * `tests/config/repo-config.test.ts`).
 */

interface StubEntry {
  /** Parsed `lastlight.yml` for this repo (absent = repo has no `.lastlight/`). */
  config?: Record<string, unknown>;
  /** Whether the layer is already in the in-memory cache (the non-blocking path). */
  cached?: boolean;
  /** Make the fetch blow up, to prove one repo's failure can't sink the tick. */
  fail?: string;
}

const repoLayers = new Map<string, StubEntry>();
let policy = {
  enabled: true,
  allowKeys: ["models", "variants", "crons", "disabled.workflows", "disabled.crons", "approval"],
  allowedModels: null as string[] | null,
  allowAssets: true,
};
const fetchSpy = vi.fn();

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
  { name: "repo-health", workflow: "repo-health", schedule: "0 9 * * 1", context: { mode: "report" } },
]);
vi.mock("#src/workflows/loader.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("#src/workflows/loader.js")>();
  return { ...actual, getCronWorkflows: () => cronDefs() };
});

const managedRepos = vi.fn(() => ["acme/a", "acme/b"]);
vi.mock("#src/managed-repos.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("#src/managed-repos.js")>();
  return { ...actual, getAccessibleManagedRepos: () => managedRepos() };
});

const { getJobs } = await import("#src/cron/jobs.js");
const { dispatchCronWorkflow } = await import("#src/cron/fanout.js");
const { resolveCronRepos, repoCronPrefs, cronVote } = await import("#src/cron/repo-crons.js");
const { loadConfig, resetRuntimeConfigForTests } = await import("#src/config/config.js");

function db(overrides: Record<string, { enabled: boolean; schedule?: string }> = {}) {
  return {
    getAllCronOverrides: () => new Map(Object.entries(overrides)),
  } as unknown as import("#src/state/db.js").StateDb;
}

/** Run one tick the way the scheduler does: runner(job.workflow, job.context). */
async function tick(
  // A `CronJob` — `workflow` is optional on the type because a `handler:` cron
  // has none, but every job these tests build is a workflow cron.
  job: { workflow?: string; context: Record<string, unknown> },
  dispatch: CronDispatcher,
) {
  return dispatchCronWorkflow(job.workflow!, job.context, dispatch);
}

beforeEach(() => {
  repoLayers.clear();
  fetchSpy.mockClear();
  policy = {
    enabled: true,
    allowKeys: ["models", "variants", "crons", "disabled.workflows", "disabled.crons", "approval"],
    allowedModels: null,
    allowAssets: true,
  };
});

describe("getJobs — global cron enablement", () => {
  it("registers an enabled cron with the repos context, as before", async () => {
    const jobs = await getJobs({ crons: { enable: [], disable: [] } });
    expect(jobs).toHaveLength(1);
    expect(jobs[0]!.schedule).toBe("0 9 * * 1");
    expect(jobs[0]!.context).toMatchObject({ repos: ["acme/a", "acme/b"], mode: "report" });
  });

  it("still registers a tick for a cron disabled by crons.disable, marked globally off", async () => {
    const jobs = await getJobs({ crons: { enable: [], disable: ["repo-health"] } });
    // Registered (not `continue`d) so a repo can still opt in at tick time.
    expect(jobs).toHaveLength(1);
    expect(jobs[0]!.context._cronGloballyEnabled).toBe(false);
    expect(jobs[0]!.context._cronName).toBe("repo-health");
  });

  it("still registers a tick for a cron disabled by a cron_overrides row", async () => {
    const jobs = await getJobs({ db: db({ "repo-health": { enabled: false } }), crons: { enable: [], disable: [] } });
    expect(jobs).toHaveLength(1);
    expect(jobs[0]!.context._cronGloballyEnabled).toBe(false);
  });

  it("keeps the cron_overrides schedule override", async () => {
    const jobs = await getJobs({ db: db({ "repo-health": { enabled: true, schedule: "*/5 * * * *" } }) });
    expect(jobs[0]!.schedule).toBe("*/5 * * * *");
    expect(jobs[0]!.context._cronGloballyEnabled).toBe(true);
  });

  it("keeps the webhooksEnabled condition filter", async () => {
    cronDefs.mockReturnValueOnce([
      {
        name: "issue-poll",
        workflow: "issue-triage",
        schedule: "*/10 * * * *",
        context: {},
        condition: { unless: "webhooksEnabled" },
      } as never,
    ]);
    expect(await getJobs({ webhooksEnabled: true })).toHaveLength(0);
  });

  it("operator crons.enable is a no-op re-affirmation, never an error", async () => {
    const jobs = await getJobs({ crons: { enable: ["repo-health"], disable: [] } });
    expect(jobs[0]!.context._cronGloballyEnabled).toBe(true);
  });

  it("disable wins over enable at the operator layer too", async () => {
    const jobs = await getJobs({ crons: { enable: ["repo-health"], disable: ["repo-health"] } });
    expect(jobs[0]!.context._cronGloballyEnabled).toBe(false);
  });
});

describe("cron tick fan-out — per-repo participation", () => {
  it("a repo with no .lastlight/ behaves exactly as today", async () => {
    const dispatch = vi.fn<CronDispatcher>().mockResolvedValue({ success: true });
    const [job] = await getJobs({ crons: { enable: [], disable: [] } });
    const res = await tick(job!, dispatch);
    expect(res).toEqual({ dispatched: 2, failures: 0 });
    const dispatched = dispatch.mock.calls.map((c) => (c[1] as Record<string, unknown>).repo);
    expect(dispatched.sort()).toEqual(["acme/a", "acme/b"]);
  });

  it("strips the cron control keys from the dispatched context", async () => {
    const dispatch = vi.fn<CronDispatcher>().mockResolvedValue({ success: true });
    const [job] = await getJobs();
    await tick(job!, dispatch);
    const ctx = dispatch.mock.calls[0]![1] as Record<string, unknown>;
    expect(ctx._cronName).toBeUndefined();
    expect(ctx._cronGloballyEnabled).toBeUndefined();
    expect(ctx.repos).toBeUndefined();
    expect(ctx).toMatchObject({ repo: "acme/a", mode: "report", _triggerType: "cron" });
  });

  it("drops a repo that disabled the cron in its own crons.disable", async () => {
    repoLayers.set("acme/a", { cached: true, config: { crons: { disable: ["repo-health"] } } });
    const dispatch = vi.fn<CronDispatcher>().mockResolvedValue({ success: true });
    const [job] = await getJobs();
    const res = await tick(job!, dispatch);
    expect(res).toEqual({ dispatched: 1, failures: 0 });
    expect((dispatch.mock.calls[0]![1] as Record<string, unknown>).repo).toBe("acme/b");
  });

  it("repo A opts out and repo B opts in to a globally-off cron — one run, for B", async () => {
    repoLayers.set("acme/a", { cached: true, config: { crons: { disable: ["repo-health"] } } });
    repoLayers.set("acme/b", { cached: true, config: { crons: { enable: ["repo-health"] } } });
    const dispatch = vi.fn<CronDispatcher>().mockResolvedValue({ success: true });
    const [job] = await getJobs({ crons: { enable: [], disable: ["repo-health"] } });
    const res = await tick(job!, dispatch);
    expect(res).toEqual({ dispatched: 1, failures: 0 });
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect((dispatch.mock.calls[0]![1] as Record<string, unknown>).repo).toBe("acme/b");
  });

  it("a repo listing the cron in BOTH enable and disable does not run (disable wins)", async () => {
    repoLayers.set("acme/a", {
      cached: true,
      config: { crons: { enable: ["repo-health"], disable: ["repo-health"] } },
    });
    repoLayers.set("acme/b", { cached: true, config: { crons: { enable: ["repo-health"] } } });
    const dispatch = vi.fn<CronDispatcher>().mockResolvedValue({ success: true });
    const [job] = await getJobs({ crons: { enable: [], disable: ["repo-health"] } });
    await tick(job!, dispatch);
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect((dispatch.mock.calls[0]![1] as Record<string, unknown>).repo).toBe("acme/b");
  });

  it("an empty resolved repo list is a clean no-op tick", async () => {
    const dispatch = vi.fn<CronDispatcher>().mockResolvedValue({ success: true });
    const [job] = await getJobs({ crons: { enable: [], disable: ["repo-health"] } });
    const res = await tick(job!, dispatch);
    expect(dispatch).not.toHaveBeenCalled();
    expect(res).toEqual({ dispatched: 0, failures: 0 });
  });

  it("one repo's config-fetch failure doesn't abort the tick for the others", async () => {
    repoLayers.set("acme/a", { fail: "GitHub 503" });
    repoLayers.set("acme/b", { cached: true, config: { crons: { disable: ["repo-health"] } } });
    const dispatch = vi.fn<CronDispatcher>().mockResolvedValue({ success: true });
    const [job] = await getJobs();
    const res = await tick(job!, dispatch);
    // a falls back to its inherited (global) behaviour; b's opt-out still holds.
    expect(res).toEqual({ dispatched: 1, failures: 0 });
    expect((dispatch.mock.calls[0]![1] as Record<string, unknown>).repo).toBe("acme/a");
  });

  it("honours a repo's legacy disabled.crons list as well", async () => {
    repoLayers.set("acme/a", { cached: true, config: { disabled: { crons: ["repo-health"] } } });
    const dispatch = vi.fn<CronDispatcher>().mockResolvedValue({ success: true });
    const [job] = await getJobs();
    const res = await tick(job!, dispatch);
    expect(res).toEqual({ dispatched: 1, failures: 0 });
    expect((dispatch.mock.calls[0]![1] as Record<string, unknown>).repo).toBe("acme/b");
  });

  it("uses the cached layer without fetching when one is warm", async () => {
    repoLayers.set("acme/a", { cached: true, config: {} });
    repoLayers.set("acme/b", { cached: true, config: {} });
    const dispatch = vi.fn<CronDispatcher>().mockResolvedValue({ success: true });
    await tick((await getJobs())[0]!, dispatch);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("dropping `crons` from allowKeys makes the operator's setting final — and costs nothing", async () => {
    policy.allowKeys = ["models", "variants", "approval"];
    repoLayers.set("acme/a", { cached: true, config: { crons: { enable: ["repo-health"] } } });
    const dispatch = vi.fn<CronDispatcher>().mockResolvedValue({ success: true });
    const [job] = await getJobs({ crons: { enable: [], disable: ["repo-health"] } });
    const res = await tick(job!, dispatch);
    expect(res).toEqual({ dispatched: 0, failures: 0 });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("repoConfig.enabled: false ignores every repo's opinion", async () => {
    policy.enabled = false;
    repoLayers.set("acme/a", { cached: true, config: { crons: { disable: ["repo-health"] } } });
    const dispatch = vi.fn<CronDispatcher>().mockResolvedValue({ success: true });
    const res = await tick((await getJobs())[0]!, dispatch);
    expect(res).toEqual({ dispatched: 2, failures: 0 });
  });

  it("a context without the cron name (manual 'Run now') fans out verbatim", async () => {
    repoLayers.set("acme/a", { cached: true, config: { crons: { disable: ["repo-health"] } } });
    const dispatch = vi.fn<CronDispatcher>().mockResolvedValue({ success: true });
    const res = await dispatchCronWorkflow("repo-health", { repos: ["acme/a", "acme/b"] }, dispatch);
    expect(res).toEqual({ dispatched: 2, failures: 0 });
  });
});

describe("resolveCronRepos / repoCronPrefs (pure)", () => {
  it("disable wins over enable", () => {
    expect(cronVote("x", { enable: ["x"], disable: ["x"] })).toBe("disable");
    expect(cronVote("x", { enable: ["x"], disable: [] })).toBe("enable");
    expect(cronVote("x", { enable: [], disable: [] })).toBeUndefined();
  });

  it("drops keys the operator's allowKeys doesn't admit", () => {
    const narrowed = { ...policy, allowKeys: ["crons.disable"] };
    const prefs = repoCronPrefs({ crons: { enable: ["x"], disable: ["y"] } }, narrowed);
    expect(prefs).toEqual({ enable: [], disable: ["y"] });
  });

  it("degrades leniently on a malformed crons block", () => {
    expect(repoCronPrefs({ crons: "off" }, policy)).toEqual({ enable: [], disable: [] });
    expect(repoCronPrefs({ crons: { disable: [1, "", "  x  "] } }, policy)).toEqual({ enable: [], disable: ["x"] });
    expect(repoCronPrefs(undefined, policy)).toEqual({ enable: [], disable: [] });
  });

  it("unions a repo's legacy disabled.crons into crons.disable, de-duplicated", () => {
    const prefs = repoCronPrefs({ crons: { disable: ["x"] }, disabled: { crons: ["x", "y"] } }, policy);
    expect(prefs).toEqual({ enable: [], disable: ["x", "y"] });
  });

  it("reports opted-in / opted-out repos for the tick log", async () => {
    repoLayers.set("acme/a", { cached: true, config: { crons: { enable: ["nightly"] } } });
    const res = await resolveCronRepos({
      cron: "nightly",
      repos: ["acme/a", "acme/b"],
      globallyEnabled: false,
      policy,
    });
    expect(res).toEqual({ repos: ["acme/a"], optedOut: [], optedIn: ["acme/a"] });
  });
});

describe("config — the crons block", () => {
  beforeEach(() => {
    vi.stubEnv("GITHUB_APP_ID", "");
    vi.stubEnv("SLACK_BOT_TOKEN", "");
    vi.stubEnv("LASTLIGHT_OVERLAY_DIR", "");
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    resetRuntimeConfigForTests();
  });

  function overlay(yaml: string): string {
    const dir = mkdtempSync(join(tmpdir(), "lastlight-crons-"));
    writeFileSync(join(dir, "config.yaml"), yaml);
    return dir;
  }

  it("defaults to empty enable/disable lists", () => {
    const cfg = loadConfig();
    expect(cfg.crons).toEqual({ enable: [], disable: [] });
  });

  it("reads crons.enable / crons.disable from an overlay", () => {
    vi.stubEnv("LASTLIGHT_OVERLAY_DIR", overlay("crons:\n  enable: [security-scan]\n  disable: [repo-health]\n"));
    const cfg = loadConfig();
    expect(cfg.crons).toEqual({ enable: ["security-scan"], disable: ["repo-health"] });
  });

  it("unions the legacy disabled.crons list into crons.disable, leaving it in place", () => {
    vi.stubEnv("LASTLIGHT_OVERLAY_DIR", overlay("disabled:\n  crons: [repo-health]\n"));
    const cfg = loadConfig();
    // Legacy list untouched — the asset loader still reads it.
    expect(cfg.disabled.crons).toEqual(["repo-health"]);
    expect(cfg.crons.disable).toEqual(["repo-health"]);
  });

  it("de-duplicates a cron named in both spellings", () => {
    vi.stubEnv(
      "LASTLIGHT_OVERLAY_DIR",
      overlay("crons:\n  disable: [repo-health, security-scan]\ndisabled:\n  crons: [repo-health]\n"),
    );
    expect(loadConfig().crons.disable).toEqual(["repo-health", "security-scan"]);
  });

  it("degrades leniently rather than throwing at boot", () => {
    vi.stubEnv("LASTLIGHT_OVERLAY_DIR", overlay("crons: off\n"));
    expect(loadConfig().crons).toEqual({ enable: [], disable: [] });
  });
});
