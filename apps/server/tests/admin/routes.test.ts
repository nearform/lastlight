import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { createAdminRoutes, type AdminConfig } from "#src/admin/routes.js";
import { mountAdmin } from "#src/admin/index.js";
import { BuildAssetStore } from "#src/state/build-assets.js";
import type { StateDb } from "#src/state/db.js";
import type { SessionReader } from "#src/admin/sessions.js";

// Mock docker so tests don't need a running daemon
vi.mock("#src/admin/docker.js", () => ({
  listRunningContainers: vi.fn(async () => []),
  killContainer: vi.fn(async () => {}),
  getContainerStats: vi.fn(async () => []),
  getHostStats: vi.fn(async () => null),
}));

// Pin the cron definitions the /crons routes resolve against, so the trigger
// tests don't depend on the bundled workflows/cron-*.yaml fixture set. Other
// loader exports (getWorkflow, listAgentWorkflows, …) pass through unchanged.
vi.mock("#src/workflows/loader.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("#src/workflows/loader.js")>();
  return {
    ...actual,
    getCronWorkflows: vi.fn(() => [
      { name: "test-cron", workflow: "repo-health", schedule: "0 9 * * 1", context: { foo: "bar" } },
    ]),
  };
});

// Mock arctic so we control OAuth flow without hitting Slack or GitHub
vi.mock("arctic", () => {
  class Slack {
    createAuthorizationURL(_state: string, _scopes: string[]) {
      return new URL("https://slack.com/openid/connect/authorize?mocked=1");
    }
    async validateAuthorizationCode(_code: string) {
      return { accessToken: () => "mock-slack-access-token" };
    }
  }
  class GitHub {
    createAuthorizationURL(_state: string, _scopes: string[]) {
      return new URL("https://github.com/login/oauth/authorize?mocked=1");
    }
    async validateAuthorizationCode(_code: string) {
      return { accessToken: () => "mock-github-access-token" };
    }
  }
  return { Slack, GitHub };
});

// Minimal mocks
const mockDb = {
  executions: {
    executionStats: vi.fn(() => ({ total: 0, running: 0, success: 0, failed: 0 })),
    dailyStats: vi.fn(() => []),
    hourlyStats: vi.fn(() => []),
    allExecutions: vi.fn(() => []),
    runningExecutions: vi.fn(() => []),
  },
  runs: {
    list: vi.fn(() => ({ runs: [], total: 0 })),
    distinctNames: vi.fn(() => []),
    distinctRepos: vi.fn(() => []),
    getRun: vi.fn(() => null),
  },
  approvals: {
    listPending: vi.fn(() => []),
    listByArtifact: vi.fn(() => []),
  },
} as unknown as StateDb;

const mockSessions = {
  listSessionIds: vi.fn(() => []),
  getSessionMeta: vi.fn(async () => null),
  exists: vi.fn(() => false),
  read: vi.fn(async () => []),
  getFilePath: vi.fn(() => null),
  normalizeRawLine: vi.fn((raw: Record<string, unknown>) => [raw]),
} as unknown as SessionReader;

function makeConfig(overrides: Partial<AdminConfig> = {}): AdminConfig {
  return {
    stateDir: "/tmp",
    sessionsDir: "/tmp/sessions",
    adminPassword: "test-password",
    adminSecret: "test-secret",
    ...overrides,
  };
}

async function request(app: ReturnType<typeof createAdminRoutes>, path: string, opts: RequestInit = {}) {
  const req = new Request(`http://localhost${path}`, opts);
  return app.fetch(req);
}

describe("GET /auth-required", () => {
  it("returns slackOAuth: false when not configured", async () => {
    const app = createAdminRoutes(mockDb, mockSessions, mockSessions, makeConfig());
    const res = await request(app, "/auth-required");
    const body = await res.json() as { required: boolean; slackOAuth: boolean };
    expect(res.status).toBe(200);
    expect(body.slackOAuth).toBe(false);
    expect(body.required).toBe(true);
  });

  it("returns slackOAuth: true when client ID and secret are configured", async () => {
    const app = createAdminRoutes(mockDb, mockSessions, mockSessions, makeConfig({
      slackOAuthClientId: "C123",
      slackOAuthClientSecret: "secret",
    }));
    const res = await request(app, "/auth-required");
    const body = await res.json() as { required: boolean; slackOAuth: boolean };
    expect(res.status).toBe(200);
    expect(body.slackOAuth).toBe(true);
  });

  it("returns slackOAuth: false when only clientId is set (secret missing)", async () => {
    const app = createAdminRoutes(mockDb, mockSessions, mockSessions, makeConfig({
      slackOAuthClientId: "C123",
    }));
    const res = await request(app, "/auth-required");
    const body = await res.json() as { slackOAuth: boolean };
    expect(body.slackOAuth).toBe(false);
  });
});

describe("GET /oauth/slack/authorize", () => {
  it("returns 404 when Slack OAuth not configured", async () => {
    const app = createAdminRoutes(mockDb, mockSessions, mockSessions, makeConfig());
    const res = await request(app, "/oauth/slack/authorize");
    expect(res.status).toBe(404);
  });

  it("redirects to Slack when configured", async () => {
    const app = createAdminRoutes(mockDb, mockSessions, mockSessions, makeConfig({
      slackOAuthClientId: "C123",
      slackOAuthClientSecret: "secret",
      slackOAuthRedirectUri: "http://localhost/callback",
    }));
    const res = await request(app, "/oauth/slack/authorize");
    expect(res.status).toBe(302);
    const location = res.headers.get("location") ?? "";
    expect(location).toContain("slack.com");
  });
});

describe("GET /oauth/slack/callback", () => {
  it("returns 404 when Slack OAuth not configured", async () => {
    const app = createAdminRoutes(mockDb, mockSessions, mockSessions, makeConfig());
    const res = await request(app, "/oauth/slack/callback?code=abc&state=xyz");
    expect(res.status).toBe(404);
  });

  it("returns 400 when state is missing or mismatched", async () => {
    const app = createAdminRoutes(mockDb, mockSessions, mockSessions, makeConfig({
      slackOAuthClientId: "C123",
      slackOAuthClientSecret: "secret",
      slackOAuthRedirectUri: "http://localhost/callback",
    }));
    // No cookie set → state mismatch
    const res = await request(app, "/oauth/slack/callback?code=abc&state=bad-state");
    expect(res.status).toBe(400);
  });

  it("returns 403 when workspace does not match", async () => {
    // Mock fetch to return a different team
    const originalFetch = global.fetch;
    global.fetch = mockSlackFetch({
      sub: "U99999",
      "https://slack.com/team_id": "T99999",
      "https://slack.com/team_domain": "other-team",
    });

    const app = createAdminRoutes(mockDb, mockSessions, mockSessions, makeConfig({
      slackOAuthClientId: "C123",
      slackOAuthClientSecret: "secret",
      slackOAuthRedirectUri: "http://localhost/callback",
      slackAllowedWorkspace: "T00001",
    }));

    // Simulate request with matching state cookie
    const state = "teststate123";
    const req = new Request(`http://localhost/oauth/slack/callback?code=abc&state=${state}`, {
      headers: { Cookie: `slack_oauth_state=${state}` },
    });
    const res = await app.fetch(req);
    expect(res.status).toBe(403);

    global.fetch = originalFetch;
  });

  it("redirects with token when workspace matches by team_id", async () => {
    const originalFetch = global.fetch;
    global.fetch = mockSlackFetch({
      sub: "U00001",
      "https://slack.com/team_id": "T00001",
      "https://slack.com/team_domain": "my-team",
    });

    const app = createAdminRoutes(mockDb, mockSessions, mockSessions, makeConfig({
      slackOAuthClientId: "C123",
      slackOAuthClientSecret: "secret",
      slackOAuthRedirectUri: "http://localhost/callback",
      slackAllowedWorkspace: "T00001",
    }));

    const state = "teststate456";
    const req = new Request(`http://localhost/oauth/slack/callback?code=abc&state=${state}`, {
      headers: { Cookie: `slack_oauth_state=${state}` },
    });
    const res = await app.fetch(req);
    expect(res.status).toBe(302);
    const location = res.headers.get("location") ?? "";
    expect(location).toContain("/admin/?token=");

    global.fetch = originalFetch;
  });

  it("redirects with token when no workspace restriction set", async () => {
    const originalFetch = global.fetch;
    global.fetch = mockSlackFetch({
      sub: "UANY",
      "https://slack.com/team_id": "TANY",
      "https://slack.com/team_domain": "any-team",
    });

    const app = createAdminRoutes(mockDb, mockSessions, mockSessions, makeConfig({
      slackOAuthClientId: "C123",
      slackOAuthClientSecret: "secret",
      slackOAuthRedirectUri: "http://localhost/callback",
    }));

    const state = "teststate789";
    const req = new Request(`http://localhost/oauth/slack/callback?code=abc&state=${state}`, {
      headers: { Cookie: `slack_oauth_state=${state}` },
    });
    const res = await app.fetch(req);
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toContain("/admin/?token=");

    global.fetch = originalFetch;
  });
});

describe("GET /auth-required (GitHub OAuth)", () => {
  it("returns githubOAuth: false when not configured", async () => {
    const app = createAdminRoutes(mockDb, mockSessions, mockSessions, makeConfig());
    const res = await request(app, "/auth-required");
    const body = await res.json() as { required: boolean; slackOAuth: boolean; githubOAuth: boolean };
    expect(res.status).toBe(200);
    expect(body.githubOAuth).toBe(false);
  });

  it("returns githubOAuth: true when client ID, secret, and allowed org are configured", async () => {
    const app = createAdminRoutes(mockDb, mockSessions, mockSessions, makeConfig({
      githubOAuthClientId: "GH_CLIENT",
      githubOAuthClientSecret: "GH_SECRET",
      githubAllowedOrg: "acme",
    }));
    const res = await request(app, "/auth-required");
    const body = await res.json() as { githubOAuth: boolean };
    expect(res.status).toBe(200);
    expect(body.githubOAuth).toBe(true);
  });

  it("returns githubOAuth: true when allowed org is \"*\" (allow any user)", async () => {
    const app = createAdminRoutes(mockDb, mockSessions, mockSessions, makeConfig({
      githubOAuthClientId: "GH_CLIENT",
      githubOAuthClientSecret: "GH_SECRET",
      githubAllowedOrg: "*",
    }));
    const res = await request(app, "/auth-required");
    const body = await res.json() as { githubOAuth: boolean };
    expect(body.githubOAuth).toBe(true);
  });

  it("returns githubOAuth: false when only clientId is set (secret missing)", async () => {
    const app = createAdminRoutes(mockDb, mockSessions, mockSessions, makeConfig({
      githubOAuthClientId: "GH_CLIENT",
    }));
    const res = await request(app, "/auth-required");
    const body = await res.json() as { githubOAuth: boolean };
    expect(body.githubOAuth).toBe(false);
  });

  it("returns githubOAuth: false when id+secret set but allowed org is missing", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const app = createAdminRoutes(mockDb, mockSessions, mockSessions, makeConfig({
      githubOAuthClientId: "GH_CLIENT",
      githubOAuthClientSecret: "GH_SECRET",
    }));
    const res = await request(app, "/auth-required");
    const body = await res.json() as { githubOAuth: boolean };
    expect(body.githubOAuth).toBe(false);
    expect(errSpy).toHaveBeenCalled();
    errSpy.mockRestore();
  });
});

describe("GET /oauth/github/authorize", () => {
  it("returns 404 when GitHub OAuth not configured", async () => {
    const app = createAdminRoutes(mockDb, mockSessions, mockSessions, makeConfig());
    const res = await request(app, "/oauth/github/authorize");
    expect(res.status).toBe(404);
  });

  it("returns 404 when id+secret set but allowed org is missing", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const app = createAdminRoutes(mockDb, mockSessions, mockSessions, makeConfig({
      githubOAuthClientId: "GH_CLIENT",
      githubOAuthClientSecret: "GH_SECRET",
    }));
    const res = await request(app, "/oauth/github/authorize");
    expect(res.status).toBe(404);
    errSpy.mockRestore();
  });

  it("redirects to GitHub when configured with an allowed org", async () => {
    const app = createAdminRoutes(mockDb, mockSessions, mockSessions, makeConfig({
      githubOAuthClientId: "GH_CLIENT",
      githubOAuthClientSecret: "GH_SECRET",
      githubOAuthRedirectUri: "http://localhost/callback",
      githubAllowedOrg: "acme",
    }));
    const res = await request(app, "/oauth/github/authorize");
    expect(res.status).toBe(302);
    const location = res.headers.get("location") ?? "";
    expect(location).toContain("github.com");
  });

  it("sets github_oauth_state cookie when configured", async () => {
    const app = createAdminRoutes(mockDb, mockSessions, mockSessions, makeConfig({
      githubOAuthClientId: "GH_CLIENT",
      githubOAuthClientSecret: "GH_SECRET",
      githubOAuthRedirectUri: "http://localhost/callback",
      githubAllowedOrg: "acme",
    }));
    const res = await request(app, "/oauth/github/authorize");
    const setCookie = res.headers.get("set-cookie") ?? "";
    expect(setCookie).toContain("github_oauth_state=");
    expect(setCookie).toContain("HttpOnly");
    expect(setCookie).toContain("SameSite=Lax");
    expect(setCookie).toContain("Path=/");
  });
});

/** Helper: mock global.fetch routing the token exchange, /user and /orgs/... to different responses */
function mockGithubFetch({ userLogin, orgStatus }: { userLogin: string; orgStatus?: number }) {
  return vi.fn(async (url: string | URL | Request) => {
    const urlStr = typeof url === "string" ? url : url instanceof URL ? url.href : url.url;
    // The confidential-client token exchange (exchangeOAuth2Code) POSTs here.
    if (urlStr.includes("login/oauth/access_token")) {
      return new Response(
        JSON.stringify({ access_token: "gho_test_token" }),
        { headers: { "Content-Type": "application/json" } },
      );
    }
    if (urlStr.includes("/orgs/")) {
      return new Response(null, { status: orgStatus ?? 204 });
    }
    // Default: /user
    return new Response(
      JSON.stringify({ login: userLogin }),
      { headers: { "Content-Type": "application/json" } },
    );
  });
}

/** Helper: mock global.fetch routing the Slack token exchange vs the userInfo endpoint. */
function mockSlackFetch(userInfo: Record<string, unknown>) {
  return vi.fn(async (url: string | URL | Request) => {
    const urlStr = typeof url === "string" ? url : url instanceof URL ? url.href : url.url;
    // The confidential-client token exchange (exchangeOAuth2Code) POSTs here.
    if (urlStr.includes("openid.connect.token")) {
      return new Response(
        JSON.stringify({ ok: true, access_token: "xoxp_test_token" }),
        { headers: { "Content-Type": "application/json" } },
      );
    }
    // openid.connect.userInfo
    return new Response(JSON.stringify(userInfo), { headers: { "Content-Type": "application/json" } });
  }) as unknown as typeof fetch;
}

describe("GET /oauth/github/callback", () => {
  it("returns 404 when GitHub OAuth not configured", async () => {
    const app = createAdminRoutes(mockDb, mockSessions, mockSessions, makeConfig());
    const res = await request(app, "/oauth/github/callback?code=abc&state=xyz");
    expect(res.status).toBe(404);
  });

  it("returns 400 when state is missing or mismatched", async () => {
    const app = createAdminRoutes(mockDb, mockSessions, mockSessions, makeConfig({
      githubOAuthClientId: "GH_CLIENT",
      githubOAuthClientSecret: "GH_SECRET",
      githubOAuthRedirectUri: "http://localhost/callback",
      githubAllowedOrg: "acme",
    }));
    // No cookie set → state mismatch
    const res = await request(app, "/oauth/github/callback?code=abc&state=bad-state");
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/admin/?error=oauth_state");
  });

  it("redirects to /admin/?error=oauth_code when code is missing", async () => {
    const app = createAdminRoutes(mockDb, mockSessions, mockSessions, makeConfig({
      githubOAuthClientId: "GH_CLIENT",
      githubOAuthClientSecret: "GH_SECRET",
      githubAllowedOrg: "acme",
    }));
    const state = "teststate000";
    const req = new Request(`http://localhost/oauth/github/callback?state=${state}`, {
      headers: { Cookie: `github_oauth_state=${state}` },
    });
    const res = await app.fetch(req);
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/admin/?error=oauth_code");
  });

  it("redirects with token and skips org fetch when allowlist is \"*\"", async () => {
    const originalFetch = global.fetch;
    const fetchMock = mockGithubFetch({ userLogin: "alice" });
    global.fetch = fetchMock;

    const app = createAdminRoutes(mockDb, mockSessions, mockSessions, makeConfig({
      githubOAuthClientId: "GH_CLIENT",
      githubOAuthClientSecret: "GH_SECRET",
      githubOAuthRedirectUri: "http://localhost/callback",
      githubAllowedOrg: "*",
    }));

    const state = "teststate111";
    const req = new Request(`http://localhost/oauth/github/callback?code=abc&state=${state}`, {
      headers: { Cookie: `github_oauth_state=${state}` },
    });
    const res = await app.fetch(req);
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toContain("/admin/?token=");
    // Must not have called the /orgs/ membership endpoint under "*"
    const calls = fetchMock.mock.calls.map((c) => {
      const u = c[0];
      return typeof u === "string" ? u : u instanceof URL ? u.href : u.url;
    });
    expect(calls.some((u) => u.includes("/orgs/"))).toBe(false);

    global.fetch = originalFetch;
  });

  it("redirects with token when org membership returns 204", async () => {
    const originalFetch = global.fetch;
    global.fetch = mockGithubFetch({ userLogin: "alice", orgStatus: 204 });

    const app = createAdminRoutes(mockDb, mockSessions, mockSessions, makeConfig({
      githubOAuthClientId: "GH_CLIENT",
      githubOAuthClientSecret: "GH_SECRET",
      githubOAuthRedirectUri: "http://localhost/callback",
      githubAllowedOrg: "acme",
    }));

    const state = "teststate222";
    const req = new Request(`http://localhost/oauth/github/callback?code=abc&state=${state}`, {
      headers: { Cookie: `github_oauth_state=${state}` },
    });
    const res = await app.fetch(req);
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toContain("/admin/?token=");

    global.fetch = originalFetch;
  });

  it("redirects to /admin/?error=github_org when membership returns 404 (not a member)", async () => {
    const originalFetch = global.fetch;
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    global.fetch = mockGithubFetch({ userLogin: "alice", orgStatus: 404 });

    const app = createAdminRoutes(mockDb, mockSessions, mockSessions, makeConfig({
      githubOAuthClientId: "GH_CLIENT",
      githubOAuthClientSecret: "GH_SECRET",
      githubOAuthRedirectUri: "http://localhost/callback",
      githubAllowedOrg: "acme",
    }));

    const state = "teststate333";
    const req = new Request(`http://localhost/oauth/github/callback?code=abc&state=${state}`, {
      headers: { Cookie: `github_oauth_state=${state}` },
    });
    const res = await app.fetch(req);
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/admin/?error=github_org");

    global.fetch = originalFetch;
    warnSpy.mockRestore();
  });

  it("redirects to /admin/?error=github_org when membership returns 302 (insufficient visibility)", async () => {
    const originalFetch = global.fetch;
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    global.fetch = mockGithubFetch({ userLogin: "alice", orgStatus: 302 });

    const app = createAdminRoutes(mockDb, mockSessions, mockSessions, makeConfig({
      githubOAuthClientId: "GH_CLIENT",
      githubOAuthClientSecret: "GH_SECRET",
      githubOAuthRedirectUri: "http://localhost/callback",
      githubAllowedOrg: "acme",
    }));

    const state = "teststate444";
    const req = new Request(`http://localhost/oauth/github/callback?code=abc&state=${state}`, {
      headers: { Cookie: `github_oauth_state=${state}` },
    });
    const res = await app.fetch(req);
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/admin/?error=github_org");

    global.fetch = originalFetch;
    warnSpy.mockRestore();
  });
});

describe("POST /login (password)", () => {
  it("still works with correct password", async () => {
    const app = createAdminRoutes(mockDb, mockSessions, mockSessions, makeConfig({
      adminPassword: "correct",
    }));
    const res = await request(app, "/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password: "correct" }),
    });
    expect(res.status).toBe(200);
    const body = await res.json() as { token: string };
    expect(typeof body.token).toBe("string");
  });

  it("rejects wrong password", async () => {
    const app = createAdminRoutes(mockDb, mockSessions, mockSessions, makeConfig({
      adminPassword: "correct",
    }));
    const res = await request(app, "/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password: "wrong" }),
    });
    expect(res.status).toBe(401);
  });
});

describe("POST /workflow-runs/:id/cancel", () => {
  // Helper to make a cancel-test db that returns a single run and
  // records calls to the mutating methods we care about.
  function makeCancelDb(opts: {
    run: {
      id: string;
      status: "running" | "paused" | "succeeded" | "failed" | "cancelled";
      triggerId: string;
      taskId?: string;
    };
    runningExecutions?: Array<{ id: string; workflowRunId?: string; triggerId: string }>;
  }) {
    const finishes: Array<{ id: string; error?: string }> = [];
    const cancels: string[] = [];
    const db = {
      ...((mockDb as unknown) as Record<string, unknown>),
      runs: {
        ...((mockDb as unknown as { runs: Record<string, unknown> }).runs),
        getRun: vi.fn(() => opts.run.status === "cancelled" ? null : {
          id: opts.run.id,
          workflowName: "pr-review",
          triggerId: opts.run.triggerId,
          currentPhase: "review",
          phaseHistory: [],
          status: opts.run.status,
          context: opts.run.taskId ? { taskId: opts.run.taskId } : {},
          startedAt: "",
          updatedAt: "",
        }),
        cancelRun: vi.fn((id: string) => { cancels.push(id); }),
      },
      executions: {
        ...((mockDb as unknown as { executions: Record<string, unknown> }).executions),
        runningExecutions: vi.fn(() => opts.runningExecutions ?? []),
        recordFinish: vi.fn((id: string, res: { error?: string }) => { finishes.push({ id, error: res.error }); }),
      },
    } as unknown as StateDb;
    return { db, finishes, cancels };
  }

  it("returns 404 when run not found", async () => {
    const db = {
      ...((mockDb as unknown) as Record<string, unknown>),
      runs: {
        ...((mockDb as unknown as { runs: Record<string, unknown> }).runs),
        getRun: vi.fn(() => null),
      },
    } as unknown as StateDb;
    const app = createAdminRoutes(db, mockSessions, mockSessions, makeConfig({ adminPassword: "" }));
    const res = await request(app, "/workflow-runs/run-abc/cancel", { method: "POST" });
    expect(res.status).toBe(404);
  });

  it("returns 400 when run already in a terminal state", async () => {
    const { db } = makeCancelDb({ run: { id: "r1", status: "succeeded", triggerId: "t1" } });
    const app = createAdminRoutes(db, mockSessions, mockSessions, makeConfig({ adminPassword: "" }));
    const res = await request(app, "/workflow-runs/r1/cancel", { method: "POST" });
    expect(res.status).toBe(400);
  });

  it("cancels and kills containers matching the run's taskId prefix", async () => {
    const dockerMod = await import("#src/admin/docker.js");
    const listMock = vi.mocked(dockerMod.listRunningContainers);
    const killMock = vi.mocked(dockerMod.killContainer);
    listMock.mockResolvedValueOnce([
      { id: "c1", name: "lastlight-sandbox-task-xyz-aaaaaaaa", taskId: "task-xyz", status: "running", created: "", image: "" },
      { id: "c2", name: "lastlight-sandbox-task-xyz-review-bbbbbbbb", taskId: "task-xyz-review", status: "running", created: "", image: "" },
      { id: "c3", name: "lastlight-sandbox-other-cccccccc", taskId: "other", status: "running", created: "", image: "" },
    ]);

    const { db, finishes, cancels } = makeCancelDb({
      run: { id: "r1", status: "running", triggerId: "t1", taskId: "task-xyz" },
      runningExecutions: [
        { id: "e1", workflowRunId: "r1", triggerId: "t1" },
        { id: "e2", workflowRunId: "r1", triggerId: "t1" },
      ],
    });
    const app = createAdminRoutes(db, mockSessions, mockSessions, makeConfig({ adminPassword: "" }));
    const res = await request(app, "/workflow-runs/r1/cancel", { method: "POST" });
    expect(res.status).toBe(200);
    expect(cancels).toEqual(["r1"]);
    expect(killMock).toHaveBeenCalledTimes(2);
    expect(killMock).toHaveBeenCalledWith("lastlight-sandbox-task-xyz-aaaaaaaa");
    expect(killMock).toHaveBeenCalledWith("lastlight-sandbox-task-xyz-review-bbbbbbbb");
    expect(killMock).not.toHaveBeenCalledWith("lastlight-sandbox-other-cccccccc");
    expect(finishes.map((f) => f.id).sort()).toEqual(["e1", "e2"]);
    expect(finishes.every((f) => f.error === "cancelled via admin dashboard")).toBe(true);
  });

  it("does NOT mark sibling-run executions as failed when cancelling a run with a shared triggerId", async () => {
    // Regression for the PR #38 review: matching by triggerId clobbered
    // execution rows belonging to a concurrent run on the same trigger.
    // Matching by workflowRunId must only finish rows for THIS run.
    const dockerMod = await import("#src/admin/docker.js");
    vi.mocked(dockerMod.listRunningContainers).mockResolvedValueOnce([]);

    const { db, finishes } = makeCancelDb({
      run: { id: "r1", status: "running", triggerId: "shared-trigger", taskId: "task-r1" },
      runningExecutions: [
        { id: "e1", workflowRunId: "r1", triggerId: "shared-trigger" },
        { id: "e2", workflowRunId: "r2", triggerId: "shared-trigger" },
        { id: "e3", workflowRunId: undefined, triggerId: "shared-trigger" },
      ],
    });
    const app = createAdminRoutes(db, mockSessions, mockSessions, makeConfig({ adminPassword: "" }));
    const res = await request(app, "/workflow-runs/r1/cancel", { method: "POST" });
    expect(res.status).toBe(200);
    expect(finishes.map((f) => f.id)).toEqual(["e1"]);
  });
});

describe("POST /workflow-runs/:id/retry", () => {
  function makeRetryDb(run: { id: string; status: string } | null) {
    return {
      ...((mockDb as unknown) as Record<string, unknown>),
      runs: {
        ...((mockDb as unknown as { runs: Record<string, unknown> }).runs),
        getRun: vi.fn(() =>
          run
            ? {
                id: run.id,
                workflowName: "explore",
                triggerId: "slack:t:c:th",
                currentPhase: "read_context",
                phaseHistory: [],
                status: run.status,
                context: {},
                startedAt: "",
                updatedAt: "",
              }
            : null,
        ),
      },
    } as unknown as StateDb;
  }

  it("returns 404 when the run is not found", async () => {
    const db = makeRetryDb(null);
    const retryWorkflow = vi.fn(async () => {});
    const app = createAdminRoutes(db, mockSessions, mockSessions, makeConfig({ adminPassword: "", retryWorkflow }));
    const res = await request(app, "/workflow-runs/missing/retry", { method: "POST" });
    expect(res.status).toBe(404);
    expect(retryWorkflow).not.toHaveBeenCalled();
  });

  it("returns 400 for a non-failed run and does not dispatch", async () => {
    const db = makeRetryDb({ id: "r1", status: "running" });
    const retryWorkflow = vi.fn(async () => {});
    const app = createAdminRoutes(db, mockSessions, mockSessions, makeConfig({ adminPassword: "", retryWorkflow }));
    const res = await request(app, "/workflow-runs/r1/retry", { method: "POST" });
    expect(res.status).toBe(400);
    expect(retryWorkflow).not.toHaveBeenCalled();
  });

  it("returns 503 when no retry callback is wired", async () => {
    const db = makeRetryDb({ id: "r1", status: "failed" });
    const app = createAdminRoutes(db, mockSessions, mockSessions, makeConfig({ adminPassword: "" }));
    const res = await request(app, "/workflow-runs/r1/retry", { method: "POST" });
    expect(res.status).toBe(503);
  });

  it("dispatches the retry callback for a failed run and returns 200", async () => {
    const db = makeRetryDb({ id: "r1", status: "failed" });
    const retryWorkflow = vi.fn(async (_run: unknown, _sender: string) => {});
    const app = createAdminRoutes(db, mockSessions, mockSessions, makeConfig({ adminPassword: "", retryWorkflow }));
    const res = await request(app, "/workflow-runs/r1/retry", { method: "POST" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ retrying: "r1" });
    expect(retryWorkflow).toHaveBeenCalledTimes(1);
    expect(retryWorkflow.mock.calls[0][1]).toBe("admin");
  });
});

describe("GET /workflow-runs/:id/approvals", () => {
  function makeApprovalsDb(run: unknown, approvals: unknown[]) {
    const listForWorkflow = vi.fn(() => approvals);
    const db = {
      ...((mockDb as unknown) as Record<string, unknown>),
      runs: {
        ...((mockDb as unknown as { runs: Record<string, unknown> }).runs),
        getRun: vi.fn(() => run),
      },
      approvals: {
        ...((mockDb as unknown as { approvals: Record<string, unknown> }).approvals),
        listForWorkflow,
      },
    } as unknown as StateDb;
    return { db, listForWorkflow };
  }

  it("returns 404 when the run is not found", async () => {
    const { db } = makeApprovalsDb(null, []);
    const app = createAdminRoutes(db, mockSessions, mockSessions, makeConfig({ adminPassword: "" }));
    const res = await request(app, "/workflow-runs/missing/approvals");
    expect(res.status).toBe(404);
  });

  it("returns every approval (all statuses) for the run, looked up by run id", async () => {
    const run = { id: "run-1", triggerId: "t1", workflowName: "build" };
    const approvals = [
      { id: "a1", workflowRunId: "run-1", gate: "post_architect", status: "approved", respondedBy: "alice", createdAt: "2026-01-01T00:00:00Z" },
      { id: "a2", workflowRunId: "run-1", gate: "pre_fix", status: "pending", createdAt: "2026-01-01T01:00:00Z" },
    ];
    const { db, listForWorkflow } = makeApprovalsDb(run, approvals);
    const app = createAdminRoutes(db, mockSessions, mockSessions, makeConfig({ adminPassword: "" }));
    const res = await request(app, "/workflow-runs/run-1/approvals");
    expect(res.status).toBe(200);
    const body = await res.json() as { approvals: unknown[] };
    expect(body.approvals).toEqual(approvals);
    expect(listForWorkflow).toHaveBeenCalledWith("run-1");
  });
});

describe("GET /sessions — content filter + liveness", () => {
  const now = Date.now() / 1000;
  const meta = (over: Record<string, unknown>) => ({
    id: "x", source: "agent", sessionType: "agent", model: "m",
    started_at: now, last_message_at: now, message_count: 5,
    tool_call_count: 0, conversation_message_count: 5,
    last_assistant_content: null, agentIds: [], ...over,
  });

  function appWith(metas: Array<Record<string, unknown>>) {
    const sessions = {
      ...mockSessions,
      listSessionIds: vi.fn(() => metas.map((m) => m.id as string)),
      getSessionMeta: vi.fn(async (id: string) => metas.find((m) => m.id === id) ?? null),
    } as unknown as SessionReader;
    return createAdminRoutes(mockDb, sessions, mockSessions, makeConfig({ adminPassword: "" }));
  }

  it("omits zero-message sessions (empty/aborted runs left behind)", async () => {
    const dockerMod = await import("#src/admin/docker.js");
    vi.mocked(dockerMod.listRunningContainers).mockResolvedValueOnce([]);
    const app = appWith([
      meta({ id: "real", message_count: 3 }),
      meta({ id: "exec-drizzle-553-pr-review-e34282db", message_count: 0 }),
    ]);
    const res = await request(app, "/sessions");
    const body = await res.json() as { sessions: Array<{ id: string }> };
    expect(body.sessions.map((s) => s.id)).toEqual(["real"]);
  });

  it("marks an exec-<taskId> session live only when its container is running", async () => {
    const dockerMod = await import("#src/admin/docker.js");
    vi.mocked(dockerMod.listRunningContainers).mockResolvedValueOnce([
      { id: "c1", name: "lastlight-sandbox-task-xyz-aaaaaaaa", taskId: "task-xyz", status: "running", created: "", image: "" },
    ]);
    const app = appWith([
      meta({ id: "exec-task-xyz", message_count: 2 }),       // matches running container
      meta({ id: "exec-task-other", message_count: 2 }),     // no matching container
    ]);
    const res = await request(app, "/sessions");
    const body = await res.json() as { sessions: Array<{ id: string; live: boolean }> };
    const byId = Object.fromEntries(body.sessions.map((s) => [s.id, s.live]));
    expect(byId["exec-task-xyz"]).toBe(true);
    expect(byId["exec-task-other"]).toBe(false);
  });
});

describe("POST /approvals/:id/respond", () => {
  // Build a db whose approval/run sub-stores record the lifecycle mutations
  // the approval route can issue, so a test can assert which ones fired.
  function makeApprovalDb(over: { approval?: any; run?: any; respondChanges?: number } = {}) {
    const calls = {
      respond: [] as any[],
      resolveGateAndResume: [] as any[],
      resolveGateAndFail: [] as any[],
    };
    const approval = "approval" in over ? over.approval : { id: "appr-1", status: "pending", workflowRunId: "run-1" };
    const run = "run" in over ? over.run : { id: "run-1", workflowName: "build", triggerId: "o/r#3", issueNumber: 3 };
    // respond() returns the compare-and-set row count; default 1 (won the CAS).
    const respondChanges = over.respondChanges ?? 1;
    const db = {
      ...((mockDb as unknown) as Record<string, unknown>),
      approvals: {
        ...((mockDb as unknown as { approvals: Record<string, unknown> }).approvals),
        getById: vi.fn(() => approval),
        respond: vi.fn((...args: any[]) => { calls.respond.push(args); return respondChanges; }),
      },
      runs: {
        ...((mockDb as unknown as { runs: Record<string, unknown> }).runs),
        getRun: vi.fn(() => run),
        resolveGateAndResume: vi.fn((...args: any[]) => { calls.resolveGateAndResume.push(args); return run; }),
        resolveGateAndFail: vi.fn((...args: any[]) => { calls.resolveGateAndFail.push(args); return run; }),
      },
    } as unknown as StateDb;
    return { db, calls };
  }

  async function respond(db: StateDb, id: string, payload: object, cfg: Partial<AdminConfig> = {}) {
    const app = createAdminRoutes(db, mockSessions, mockSessions, makeConfig({ adminPassword: "", ...cfg }));
    return request(app, `/approvals/${id}/respond`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
  }

  it("404s when the approval is missing", async () => {
    const { db } = makeApprovalDb({ approval: null });
    const res = await respond(db, "nope", { decision: "approved" });
    expect(res.status).toBe(404);
  });

  it("400s when the approval is already resolved", async () => {
    const { db } = makeApprovalDb({ approval: { id: "appr-1", status: "approved", workflowRunId: "run-1" } });
    const res = await respond(db, "appr-1", { decision: "approved" });
    expect(res.status).toBe(400);
  });

  it("approves and dispatches a resume when resumeWorkflow is wired", async () => {
    const { db, calls } = makeApprovalDb();
    const resumeWorkflow = vi.fn(async () => {});
    const res = await respond(db, "appr-1", { decision: "approved" }, { resumeWorkflow });
    expect(res.status).toBe(200);
    // The approval is recorded and the resume helper is handed the run...
    expect(calls.respond).toEqual([["appr-1", "approved", "admin", undefined]]);
    expect(resumeWorkflow).toHaveBeenCalledWith(
      expect.objectContaining({ id: "run-1" }),
      "admin",
    );
    // ...and the route does NOT pre-flip the run to running via the atomic op —
    // resumeWorkflow owns the status flip so it only happens with a dispatch.
    expect(calls.resolveGateAndResume).toEqual([]);
  });

  it("records the approval WITHOUT flipping the run to running when no resume can be dispatched", async () => {
    // Regression (PR #105 review): the atomic approve+resume flipped the run to
    // `running` even when no worker would be dispatched (no resumeWorkflow
    // wired, App down, or a non-issue trigger), orphaning the row. The approval
    // must be recorded, but the run must NOT become `running`.
    const { db, calls } = makeApprovalDb();
    const res = await respond(db, "appr-1", { decision: "approved" }); // no resumeWorkflow
    expect(res.status).toBe(200);
    expect(calls.respond).toEqual([["appr-1", "approved", "admin", undefined]]);
    expect(calls.resolveGateAndResume).toEqual([]);
  });

  it("409s and does NOT resume when the approval CAS loses a race", async () => {
    // The status check above is a TOCTOU read; if a concurrent responder wins,
    // respond() changes 0 rows. The loser must 409 and never hand the run to
    // resumeWorkflow for a second dispatch.
    const { db, calls } = makeApprovalDb({ respondChanges: 0 });
    const resumeWorkflow = vi.fn(async () => {});
    const res = await respond(db, "appr-1", { decision: "approved" }, { resumeWorkflow });
    expect(res.status).toBe(409);
    expect(resumeWorkflow).not.toHaveBeenCalled();
    expect(calls.resolveGateAndResume).toEqual([]);
  });

  it("rejects by failing the run atomically", async () => {
    const { db, calls } = makeApprovalDb();
    const res = await respond(db, "appr-1", { decision: "rejected", reason: "too risky" });
    expect(res.status).toBe(200);
    expect(calls.resolveGateAndFail).toEqual([["appr-1", "admin", "too risky"]]);
    expect(calls.respond).toEqual([]);
  });
});

describe("GET /approvals/:id (focused approval enrichment)", () => {
  function makeDb(approval: any, run: any) {
    return {
      ...((mockDb as unknown) as Record<string, unknown>),
      approvals: {
        ...((mockDb as unknown as { approvals: Record<string, unknown> }).approvals),
        getById: vi.fn(() => approval),
      },
      runs: {
        ...((mockDb as unknown as { runs: Record<string, unknown> }).runs),
        getRun: vi.fn(() => run),
      },
    } as unknown as StateDb;
  }

  async function getApproval(db: StateDb, id: string, cfg: Partial<AdminConfig> = {}) {
    const app = createAdminRoutes(db, mockSessions, mockSessions, makeConfig({ adminPassword: "", ...cfg }));
    return request(app, `/approvals/${id}`);
  }

  // Production shape: workflow_runs.repo is the BARE name; owner lives in
  // context (matching src/workflows/simple.ts). The Slack-invoked build flow
  // uses the same createRun path, so this also covers it.
  const run = {
    id: "run-1",
    workflowName: "build",
    triggerId: "acme/widget#3",
    repo: "widget",
    issueNumber: 3,
    context: { owner: "acme", branch: "lastlight/issue-3", issueDir: ".lastlight/issue-3" },
  };

  it("404s when the approval is missing", async () => {
    const res = await getApproval(makeDb(null, run), "nope");
    expect(res.status).toBe(404);
  });

  it("returns a server-mode artifactRef (editable store doc)", async () => {
    const approval = { id: "a1", status: "pending", workflowRunId: "run-1", artifact: "architect-plan.md" };
    const res = await getApproval(makeDb(approval, run), "a1", { buildAssets: "server" });
    const body = await res.json() as { artifactRef: any };
    expect(res.status).toBe(200);
    expect(body.artifactRef).toMatchObject({
      mode: "server",
      owner: "acme",
      repo: "widget",
      issueKey: "issue-3",
      doc: "architect-plan.md",
    });
    expect(body.artifactRef.githubUrl).toBeUndefined();
  });

  it("returns a repo-mode artifactRef with a GitHub blob URL", async () => {
    const approval = { id: "a1", status: "pending", workflowRunId: "run-1", artifact: "architect-plan.md" };
    const res = await getApproval(makeDb(approval, run), "a1", { buildAssets: "repo" });
    const body = await res.json() as { artifactRef: any };
    expect(res.status).toBe(200);
    expect(body.artifactRef.mode).toBe("repo");
    expect(body.artifactRef.githubUrl).toBe(
      "https://github.com/acme/widget/blob/lastlight%2Fissue-3/.lastlight/issue-3/architect-plan.md",
    );
  });

  it("returns artifactRef: null when the gate carries no artifact", async () => {
    const approval = { id: "a1", status: "pending", workflowRunId: "run-1" };
    const res = await getApproval(makeDb(approval, run), "a1", { buildAssets: "server" });
    const body = await res.json() as { artifactRef: any };
    expect(res.status).toBe(200);
    expect(body.artifactRef).toBeNull();
  });
});

describe("artifacts endpoints (server-mode build assets)", () => {
  let dir: string;

  type ApprovalRow = {
    id: string;
    workflowRunId: string;
    gate?: string;
    summary?: string;
    status: "pending" | "approved" | "rejected";
    artifact?: string;
    createdAt: string;
    respondedBy?: string;
    respondedAt?: string;
  };

  const baseRun = {
    id: "run-1",
    workflowName: "build",
    triggerId: "acme/widget#149",
    repo: "widget",
    issueNumber: 149,
    context: { owner: "acme", issueDir: ".lastlight/issue-149" },
  };

  function appWithArtifacts(opts: {
    approvalsByArtifact?: Record<string, ApprovalRow[]>;
    runs?: Record<string, unknown>;
    config?: Partial<AdminConfig>;
  } = {}) {
    const approvalsByArtifact = opts.approvalsByArtifact ?? {};
    const runsById = opts.runs ?? { [baseRun.id]: baseRun };
    const db = {
      ...((mockDb as unknown) as Record<string, unknown>),
      approvals: {
        ...((mockDb as unknown as { approvals: Record<string, unknown> }).approvals),
        listPending: vi.fn(() =>
          Object.values(approvalsByArtifact).flat().filter((row) => row.status === "pending"),
        ),
        listByArtifact: vi.fn((artifact: string) => approvalsByArtifact[artifact] ?? []),
      },
      runs: {
        ...((mockDb as unknown as { runs: Record<string, unknown> }).runs),
        getRun: vi.fn((id: string) => runsById[id] ?? null),
      },
    } as unknown as StateDb;

    const app = createAdminRoutes(db, mockSessions, mockSessions, makeConfig({
      adminPassword: "",
      buildAssetsDir: dir,
      ...opts.config,
    }));

    return { app, db };
  }

  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "ll-routes-assets-")); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it("allows editing artifacts with no approvals", async () => {
    const { app } = appWithArtifacts();

    const meta = await request(app, "/artifacts/acme/widget/issue-149/status.md/metadata");
    expect(meta.status).toBe(200);
    expect(await meta.json()).toEqual({ editable: true, lock: null });

    const put = await request(app, "/artifacts/acme/widget/issue-149/status.md", {
      method: "PUT",
      headers: { "Content-Type": "text/plain" },
      body: "# Status\n",
    });
    expect(put.status).toBe(200);
    expect(await put.json()).toEqual({ ok: true });

    const doc = await request(app, "/artifacts/acme/widget/issue-149/status.md");
    expect(doc.status).toBe(200);
    expect(await doc.text()).toBe("# Status\n");
  });

  it("PUT succeeds when a matching pending approval exists", async () => {
    const approvals: ApprovalRow[] = [
      {
        id: "a-pending",
        workflowRunId: baseRun.id,
        status: "pending",
        artifact: "architect-plan.md",
        createdAt: "2026-01-01T01:00:00Z",
        gate: "post_architect",
        summary: "Review the architect plan",
      },
      {
        id: "a-old",
        workflowRunId: baseRun.id,
        status: "approved",
        artifact: "architect-plan.md",
        createdAt: "2026-01-01T00:00:00Z",
        respondedBy: "alice",
        respondedAt: "2026-01-01T00:30:00Z",
      },
    ];
    const { app } = appWithArtifacts({ approvalsByArtifact: { "architect-plan.md": approvals } });

    const put = await request(app, "/artifacts/acme/widget/issue-149/architect-plan.md", {
      method: "PUT",
      headers: { "Content-Type": "text/plain" },
      body: "# Plan\n",
    });
    expect(put.status).toBe(200);
    expect(await put.json()).toEqual({ ok: true });

    const doc = await request(app, "/artifacts/acme/widget/issue-149/architect-plan.md");
    expect(doc.status).toBe(200);
    expect(await doc.text()).toBe("# Plan\n");
  });

  it("403s on PUT when no pending approval matches the artifact", async () => {
    const approvals: ApprovalRow[] = [
      {
        id: "a-approved",
        workflowRunId: baseRun.id,
        status: "approved",
        artifact: "architect-plan.md",
        createdAt: "2026-01-02T00:00:00Z",
        respondedBy: "reviewer",
        respondedAt: "2026-01-02T00:10:00Z",
      },
    ];
    const { app } = appWithArtifacts({ approvalsByArtifact: { "architect-plan.md": approvals } });

    const put = await request(app, "/artifacts/acme/widget/issue-149/architect-plan.md", {
      method: "PUT",
      headers: { "Content-Type": "text/plain" },
      body: "# New Plan\n",
    });
    expect(put.status).toBe(403);
    const body = await put.json() as { error: string; lock: { reason: string; approval: { id: string; status: string } } };
    expect(body.error).toBe("artifact_locked");
    expect(body.lock.approval.id).toBe("a-approved");
    expect(body.lock.approval.status).toBe("approved");
  });

  it("metadata reports editable:true when a pending approval matches", async () => {
    const approvals: ApprovalRow[] = [
      {
        id: "a-pending",
        workflowRunId: baseRun.id,
        status: "pending",
        artifact: "architect-plan.md",
        createdAt: "2026-01-03T00:00:00Z",
        gate: "post_architect",
        summary: "Review the architect plan",
      },
    ];
    const { app } = appWithArtifacts({ approvalsByArtifact: { "architect-plan.md": approvals } });

    const res = await request(app, "/artifacts/acme/widget/issue-149/architect-plan.md/metadata");
    expect(res.status).toBe(200);
    const body = await res.json() as { editable: boolean; lock: unknown };
    expect(body).toEqual({ editable: true, lock: null });
  });

  it("metadata reports editable:false with lock details when the latest approval is resolved", async () => {
    const approvals: ApprovalRow[] = [
      {
        id: "a-approved",
        workflowRunId: baseRun.id,
        status: "approved",
        artifact: "architect-plan.md",
        createdAt: "2026-01-04T00:00:00Z",
        respondedBy: "alice",
        respondedAt: "2026-01-04T00:05:00Z",
        gate: "post_architect",
        summary: "Review the architect plan",
      },
      {
        id: "a-old",
        workflowRunId: baseRun.id,
        status: "pending",
        artifact: "architect-plan.md",
        createdAt: "2026-01-03T00:00:00Z",
      },
    ];
    const { app } = appWithArtifacts({ approvalsByArtifact: { "architect-plan.md": approvals } });

    const res = await request(app, "/artifacts/acme/widget/issue-149/architect-plan.md/metadata");
    expect(res.status).toBe(200);
    const body = await res.json() as {
      editable: boolean;
      lock: { reason: string; approval: { id: string; status: string; respondedBy?: string; respondedAt?: string } } | null;
    };
    expect(body.editable).toBe(false);
    expect(body.lock?.reason).toBe("approval_resolved");
    expect(body.lock?.approval.id).toBe("a-approved");
    expect(body.lock?.approval.respondedBy).toBe("alice");
  });

  it("400s on a traversal attempt in the doc name", async () => {
    const { app } = appWithArtifacts();
    const res = await request(app, "/artifacts/acme/widget/issue-149/..%2f..%2fsecret", {
      method: "PUT",
      body: "x",
    });
    expect(res.status).toBe(400);
  });

  it("404 on an unknown doc; empty lists for an unknown repo", async () => {
    const { app } = appWithArtifacts();
    const missing = await request(app, "/artifacts/acme/widget/issue-1/nope.md");
    expect(missing.status).toBe(404);
    const keys = await request(app, "/artifacts?repo=nobody/nothing");
    expect(await keys.json()).toEqual({ keys: [], total: 0 });
  });

  it("reports empty when no store dir is configured", async () => {
    const approvals: ApprovalRow[] = [
      {
        id: "a-pending",
        workflowRunId: baseRun.id,
        status: "pending",
        artifact: "architect-plan.md",
        createdAt: "2026-01-03T00:00:00Z",
      },
    ];
    const db = {
      ...((mockDb as unknown) as Record<string, unknown>),
      approvals: {
        ...((mockDb as unknown as { approvals: Record<string, unknown> }).approvals),
        listPending: vi.fn(() => approvals.filter((row) => row.status === "pending")),
        listByArtifact: vi.fn(() => approvals),
      },
      runs: {
        ...((mockDb as unknown as { runs: Record<string, unknown> }).runs),
        getRun: vi.fn(() => baseRun),
      },
    } as unknown as StateDb;
    const a = createAdminRoutes(db, mockSessions, mockSessions, makeConfig({ adminPassword: "" }));
    const keys = await request(a, "/artifacts?repo=acme/widget");
    expect(await keys.json()).toEqual({ keys: [], total: 0 });
  });
});

describe("public artifact image route (mountAdmin carve-out)", () => {
  let dir: string;
  // Auth ENABLED — the public image route must still be reachable without a
  // token (it's registered on the parent app, before the auth-guarded
  // /admin/api sub-app), while the auth-gated route is not.
  const mount = (buildAssetsDir?: string) => {
    const app = new Hono();
    mountAdmin(app, mockDb, makeConfig({ adminPassword: "secret", buildAssetsDir }));
    return app;
  };
  const get = (app: Hono, path: string) => app.fetch(new Request(`http://localhost${path}`));

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "ll-public-assets-"));
    new BuildAssetStore(dir).write({ owner: "acme", repo: "widget", issueKey: "issue-1" }, "home.png", "PNG-BYTES");
    new BuildAssetStore(dir).write({ owner: "acme", repo: "widget", issueKey: "issue-1" }, "plan.md", "# secret plan\n");
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("serves a PNG as image/png with NO auth token", async () => {
    const res = await get(mount(dir), "/admin/api/public/artifacts/acme/widget/issue-1/home.png");
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("image/png");
    expect(await res.text()).toBe("PNG-BYTES");
  });

  it("serves an mp4 as video/mp4 with Range support and NO auth token", async () => {
    new BuildAssetStore(dir).write(
      { owner: "acme", repo: "widget", issueKey: "issue-1" },
      "demo.mp4",
      "MP4-BYTES-0123456789", // 20 bytes
    );
    const app = mount(dir);
    const full = await get(app, "/admin/api/public/artifacts/acme/widget/issue-1/demo.mp4");
    expect(full.status).toBe(200);
    expect(full.headers.get("Content-Type")).toBe("video/mp4");
    expect(full.headers.get("Accept-Ranges")).toBe("bytes");

    // A Range request (what a <video> element / GitHub player sends) must
    // return 206 Partial Content with a Content-Range so seeking works.
    const ranged = await app.fetch(
      new Request("http://localhost/admin/api/public/artifacts/acme/widget/issue-1/demo.mp4", {
        headers: { Range: "bytes=0-3" },
      }),
    );
    expect(ranged.status).toBe(206);
    expect(ranged.headers.get("Content-Range")).toBe("bytes 0-3/20");
    expect(await ranged.text()).toBe("MP4-");
  });

  it("404s on a non-media doc (media-only gate keeps text docs private)", async () => {
    const res = await get(mount(dir), "/admin/api/public/artifacts/acme/widget/issue-1/plan.md");
    expect(res.status).toBe(404);
  });

  it("404s for a missing image", async () => {
    const res = await get(mount(dir), "/admin/api/public/artifacts/acme/widget/issue-1/nope.png");
    expect(res.status).toBe(404);
  });

  it("404s when the build-assets store is not configured", async () => {
    const res = await get(mount(undefined), "/admin/api/public/artifacts/acme/widget/issue-1/home.png");
    expect(res.status).toBe(404);
  });

  it("the auth-gated artifacts route still requires a token (contrast)", async () => {
    const res = await get(mount(dir), "/admin/api/artifacts/acme/widget/issue-1/plan.md");
    expect(res.status).toBe(401);
  });
});

describe("GET /artifact-repos + paginated /artifacts", () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "ll-artifacts-routes-")); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  function app() {
    return createAdminRoutes(mockDb, mockSessions, mockSessions, makeConfig({ adminPassword: "", buildAssetsDir: dir }));
  }
  async function json<T>(path: string) {
    return (await (await request(app(), path)).json()) as T;
  }

  it("lists repos with artifacts, searchable", async () => {
    const store = new BuildAssetStore(dir);
    store.write({ owner: "acme", repo: "widget", issueKey: "issue-1" }, "status.md", "x");
    store.write({ owner: "acme", repo: "gadget", issueKey: "issue-2" }, "status.md", "x");

    const all = await json<{ repos: { slug: string; keyCount: number; updatedAt: string }[]; total: number }>("/artifact-repos");
    expect(all.total).toBe(2);
    expect(all.repos.map((r) => r.slug).sort()).toEqual(["acme/gadget", "acme/widget"]);
    expect(typeof all.repos[0].updatedAt).toBe("string");

    const filtered = await json<{ total: number }>("/artifact-repos?q=wid");
    expect(filtered.total).toBe(1);
  });

  it("returns an empty list when no store is configured", async () => {
    const noStore = createAdminRoutes(mockDb, mockSessions, mockSessions, makeConfig({ adminPassword: "" }));
    const res = await request(noStore, "/artifact-repos");
    expect(await res.json()).toEqual({ repos: [], total: 0 });
  });

  it("lists run keys with total and honours ?since / ?q", async () => {
    const store = new BuildAssetStore(dir);
    store.write({ owner: "acme", repo: "widget", issueKey: "issue-new" }, "status.md", "x");
    store.write({ owner: "acme", repo: "widget", issueKey: "issue-old" }, "status.md", "x");
    const old = new Date(Date.now() - 3 * 86400 * 1000);
    utimesSync(store.dirFor({ owner: "acme", repo: "widget", issueKey: "issue-old" }), old, old);

    const all = await json<{ keys: { key: string }[]; total: number }>("/artifacts?repo=acme/widget");
    expect(all.total).toBe(2);
    expect(all.keys.map((k) => k.key)).toEqual(["issue-new", "issue-old"]);

    const since = new Date(Date.now() - 86400 * 1000).toISOString();
    const recent = await json<{ keys: { key: string }[] }>(`/artifacts?repo=acme/widget&since=${encodeURIComponent(since)}`);
    expect(recent.keys.map((k) => k.key)).toEqual(["issue-new"]);

    const q = await json<{ keys: { key: string }[] }>("/artifacts?repo=acme/widget&q=old");
    expect(q.keys.map((k) => k.key)).toEqual(["issue-old"]);
  });

  it("400s on a missing/invalid ?repo=", async () => {
    const res = await request(app(), "/artifacts");
    expect(res.status).toBe(400);
  });
});

describe("GET /repos", () => {
  it("returns the union of managed + active repos, annotated + sorted newest-first", async () => {
    vi.mocked(mockDb.runs.distinctRepos).mockReturnValueOnce([
      { repo: "acme/web", runCount: 1, lastRunAt: "2026-01-01T00:00:00.000Z" },
      { repo: "acme/api", runCount: 3, lastRunAt: "2026-03-01T00:00:00.000Z" },
    ]);
    const app = createAdminRoutes(mockDb, mockSessions, mockSessions, makeConfig({ adminPassword: "" }));
    const res = await request(app, "/repos");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      repos: { repo: string; managed: boolean; runCount: number; lastRunAt: string | null }[];
    };
    // Newest activity first.
    expect(body.repos.map((r) => r.repo)).toEqual(["acme/api", "acme/web"]);
    const api = body.repos.find((r) => r.repo === "acme/api")!;
    expect(api.runCount).toBe(3);
    // No overlay managedRepos in tests → repos with activity are unmanaged.
    expect(api.managed).toBe(false);
  });
});

describe("GET /workflow-runs ?repo=", () => {
  it("threads the repo filter into runs.list", async () => {
    const app = createAdminRoutes(mockDb, mockSessions, mockSessions, makeConfig({ adminPassword: "" }));
    const res = await request(app, "/workflow-runs?repo=acme%2Fapi");
    expect(res.status).toBe(200);
    const lastCall = vi.mocked(mockDb.runs.list).mock.calls.at(-1)![0];
    expect(lastCall).toMatchObject({ repo: "acme/api" });
  });
});

describe("POST /crons/:name/trigger", () => {
  it("fires the runner with the cron's workflow + context and returns triggered", async () => {
    const triggerCron = vi.fn(async () => {});
    const app = createAdminRoutes(
      mockDb, mockSessions, mockSessions,
      makeConfig({ adminPassword: "", triggerCron }),
    );
    const res = await request(app, "/crons/test-cron/trigger", { method: "POST" });
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      name: "test-cron", workflow: "repo-health", triggered: true,
    });
    expect(triggerCron).toHaveBeenCalledTimes(1);
    const [workflow, context] = triggerCron.mock.calls[0];
    expect(workflow).toBe("repo-health");
    // Context merges the managed-repo list with the cron def's own context.
    expect(context).toMatchObject({ foo: "bar" });
    expect(context).toHaveProperty("repos");
  });

  it("returns 404 for an unknown cron", async () => {
    const triggerCron = vi.fn(async () => {});
    const app = createAdminRoutes(
      mockDb, mockSessions, mockSessions,
      makeConfig({ adminPassword: "", triggerCron }),
    );
    const res = await request(app, "/crons/nope/trigger", { method: "POST" });
    expect(res.status).toBe(404);
    expect(triggerCron).not.toHaveBeenCalled();
  });

  it("returns 503 when triggerCron is not wired", async () => {
    const app = createAdminRoutes(
      mockDb, mockSessions, mockSessions,
      makeConfig({ adminPassword: "" }),
    );
    const res = await request(app, "/crons/test-cron/trigger", { method: "POST" });
    expect(res.status).toBe(503);
  });
});
