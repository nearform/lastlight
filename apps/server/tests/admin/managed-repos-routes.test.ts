/**
 * Config → Managed repos write side: the approval fields on GET /managed-repos
 * and the approve / remove / require-approval routes (rules in
 * src/managed-repo-approvals.ts, covered in tests/managed-repo-approvals.test.ts).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

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

// The routes module pulls in the docker helpers at import time.
vi.mock("#src/admin/docker.js", () => ({
  listRunningContainers: vi.fn(async () => []),
  killContainer: vi.fn(async () => {}),
  getContainerStats: vi.fn(async () => []),
  getHostStats: vi.fn(async () => null),
}));

import { createAdminRoutes, type AdminConfig } from "#src/admin/routes.js";
import { createToken } from "#src/admin/auth.js";
import type { StateDb } from "#src/state/db.js";
import type { SessionSource } from "#src/admin/sessions.js";
import {
  setRuntimeConfig,
  resetRuntimeConfigForTests,
  type LastLightConfig,
} from "#src/config/config.js";
import { makeTestDb } from "../helpers/state-db.js";

const SECRET = "test-secret";
/** A GitHub-OAuth session for `octocat` — carries a verified login. */
const GITHUB_TOKEN = createToken(SECRET, "github", "octocat");

let db: StateDb;
let app: ReturnType<typeof createAdminRoutes>;

const emptySessions = {
  listSessionIds: () => [],
  exists: () => false,
  getSessionMeta: async () => null,
  read: async () => [],
  getFilePath: () => null,
  normalizeRawLine: () => [],
} as unknown as SessionSource;

function build(config: Partial<AdminConfig> = {}) {
  app = createAdminRoutes(db, emptySessions, emptySessions, {
    stateDir: "/tmp",
    sessionsDir: "/tmp/sessions",
    adminSecret: SECRET,
    adminPassword: "hunter2",
    ...config,
  } as AdminConfig);
}

async function send(
  method: string,
  path: string,
  opts: { token?: string; body?: unknown } = {},
): Promise<{ status: number; body: any }> {
  const headers: Record<string, string> = {};
  if (opts.token) headers.Authorization = `Bearer ${opts.token}`;
  if (opts.body !== undefined) headers["Content-Type"] = "application/json";
  const res = await app.fetch(
    new Request(`http://localhost${path}`, {
      method,
      headers,
      ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
    }),
  );
  return { status: res.status, body: await res.json().catch(() => null) };
}

import { setInstallationRepos, resetInstallationReposForTests, REPO_APPROVAL_SETTING_KEY } from "#src/managed-repos.js";

function yaml(managedRepos: string[], requireRepoApproval = false): void {
  setRuntimeConfig({ botName: "last-light", managedRepos, requireRepoApproval } as unknown as LastLightConfig);
}

beforeEach(async () => {
  db = await makeTestDb();
  yaml([]);
  build();
});

afterEach(() => {
  resetRuntimeConfigForTests();
  resetInstallationReposForTests();
  vi.restoreAllMocks();
});

describe("GET /managed-repos — approval fields", () => {
  it("default: no row, empty YAML follows the grant and hides the lists", async () => {
    setInstallationRepos("1", ["a/one", "a/two"]);
    const { status, body } = await send("GET", "/managed-repos", { token: GITHUB_TOKEN });
    expect(status).toBe(200);
    expect(body).toMatchObject({
      approved: [],
      requireApproval: false,
      stored: false,
      showApprovalLists: false,
      yamlDiffers: false,
      effective: ["a/one", "a/two"],
    });
  });

  it("YAML subset with a wider grant shows the gap", async () => {
    yaml(["a/one"]);
    setInstallationRepos("1", ["a/one", "a/two"]);
    const { body } = await send("GET", "/managed-repos", { token: GITHUB_TOKEN });
    expect(body).toMatchObject({ approved: ["a/one"], gap: ["a/two"], showApprovalLists: true, approvedNoAccess: [] });
  });

  it("gap is null before installation discovery", async () => {
    yaml(["a/one"]);
    const { body } = await send("GET", "/managed-repos", { token: GITHUB_TOKEN });
    expect(body.gap).toBeNull();
    expect(body.approvedNoAccess).toEqual([]);
    expect(body.showApprovalLists).toBe(true);
  });

  it("flags approved repos the App cannot see, case-insensitively", async () => {
    yaml(["A/One", "a/gone"]);
    setInstallationRepos("1", ["a/one"]);
    const { body } = await send("GET", "/managed-repos", { token: GITHUB_TOKEN });
    expect(body.gap).toEqual([]);
    expect(body.approvedNoAccess).toEqual(["a/gone"]);
    expect(body.showApprovalLists).toBe(true);
  });

  it("flag on with an empty list shows the lists", async () => {
    yaml([], true);
    setInstallationRepos("1", ["a/one"]);
    const { body } = await send("GET", "/managed-repos", { token: GITHUB_TOKEN });
    expect(body).toMatchObject({ requireApproval: true, showApprovalLists: true, effective: [], gap: ["a/one"] });
  });

  it("yamlDiffers when the stored row disagrees with YAML", async () => {
    yaml(["a/one"]);
    setInstallationRepos("1", ["a/one", "a/two"]);
    await send("POST", "/managed-repos/approve", { token: GITHUB_TOKEN, body: { repos: ["a/two"] } });
    const { body } = await send("GET", "/managed-repos", { token: GITHUB_TOKEN });
    expect(body).toMatchObject({ stored: true, yamlDiffers: true, approved: ["a/one", "a/two"] });
  });
});

describe("POST /managed-repos/*", () => {
  beforeEach(() => {
    yaml(["a/one"]);
    setInstallationRepos("1", ["a/one", "a/two"]);
  });

  it("approve returns the new view and writes one activity row", async () => {
    const res = await send("POST", "/managed-repos/approve", { token: GITHUB_TOKEN, body: { repos: ["a/two"] } });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ approved: ["a/one", "a/two"], gap: [], effective: ["a/one", "a/two"] });
    const { activity, total } = await db.activity.list();
    expect(total).toBe(1);
    expect(activity[0]).toMatchObject({
      action: "managed-repos.approve",
      actorLogin: "octocat",
      targetType: "managed-repos",
      outcome: "ok",
    });
    expect(activity[0].detail).toEqual({ repos: "a/two" });
    expect((await db.getSetting(REPO_APPROVAL_SETTING_KEY))?.updatedBy).toBe("octocat");
  });

  it("approve of a repo outside the grant is 400 and writes nothing", async () => {
    const res = await send("POST", "/managed-repos/approve", { token: GITHUB_TOKEN, body: { repos: ["b/x"] } });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain("b/x");
    expect(await db.getSetting(REPO_APPROVAL_SETTING_KEY)).toBeNull();
  });

  it("approve with a malformed body is 400", async () => {
    const res = await send("POST", "/managed-repos/approve", { token: GITHUB_TOKEN, body: { repos: "a/two" } });
    expect(res.status).toBe(400);
  });

  it("removing the last repo without whenEmpty is 409 would-empty", async () => {
    const res = await send("POST", "/managed-repos/remove", { token: GITHUB_TOKEN, body: { repos: ["a/one"] } });
    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: "would-empty", installationCount: 2 });
  });

  it("remove with whenEmpty require-approval turns the flag on", async () => {
    const res = await send("POST", "/managed-repos/remove", {
      token: GITHUB_TOKEN,
      body: { repos: ["a/one"], whenEmpty: "require-approval" },
    });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ approved: [], requireApproval: true, effective: [] });
    const { activity } = await db.activity.list();
    expect(activity[0]).toMatchObject({ action: "managed-repos.remove" });
    expect(activity[0].detail).toEqual({ repos: "a/one", whenEmpty: "require-approval" });
  });

  it("remove rejects an unknown whenEmpty", async () => {
    const res = await send("POST", "/managed-repos/remove", {
      token: GITHUB_TOKEN,
      body: { repos: ["a/one"], whenEmpty: "sure" },
    });
    expect(res.status).toBe(400);
  });

  it("require-approval toggles the flag", async () => {
    const res = await send("POST", "/managed-repos/require-approval", { token: GITHUB_TOKEN, body: { enabled: true } });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ requireApproval: true, approved: ["a/one"] });
    const { activity } = await db.activity.list();
    expect(activity[0]).toMatchObject({ action: "managed-repos.require-approval" });
    expect(activity[0].detail).toEqual({ enabled: true });
  });

  it("require-approval off with nothing approved is 409 unless confirmed", async () => {
    yaml([], true);
    const res = await send("POST", "/managed-repos/require-approval", { token: GITHUB_TOKEN, body: { enabled: false } });
    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: "would-follow-app", installationCount: 2 });
    const ok = await send("POST", "/managed-repos/require-approval", {
      token: GITHUB_TOKEN,
      body: { enabled: false, confirm: true },
    });
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ requireApproval: false, effective: ["a/one", "a/two"] });
  });

  it("keeps the lists visible after Approve all, so approved repos stay removable", async () => {
    const res = await send("POST", "/managed-repos/approve", { token: GITHUB_TOKEN, body: { repos: ["a/two"] } });
    expect(res.body).toMatchObject({ gap: [], showApprovalLists: true });
  });

  it("requires authentication", async () => {
    const res = await send("POST", "/managed-repos/require-approval", { body: { enabled: true } });
    expect(res.status).toBe(401);
  });
});
