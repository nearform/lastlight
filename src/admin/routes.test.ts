import { describe, it, expect, vi, beforeEach } from "vitest";
import { createAdminRoutes, type AdminConfig } from "./routes.js";
import type { StateDb } from "../state/db.js";
import type { SessionReader } from "./sessions.js";

// Mock docker so tests don't need a running daemon
vi.mock("./docker.js", () => ({
  listRunningContainers: vi.fn(async () => []),
  killContainer: vi.fn(async () => {}),
  getContainerStats: vi.fn(async () => []),
}));

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
    getRun: vi.fn(() => null),
  },
  approvals: {
    listPending: vi.fn(() => []),
  },
} as unknown as StateDb;

const mockSessions = {
  listSessionIds: vi.fn(() => []),
  getSessionMeta: vi.fn(async () => null),
  exists: vi.fn(() => false),
  read: vi.fn(async () => []),
  getFilePath: vi.fn(() => null),
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
    global.fetch = vi.fn(async () => new Response(
      JSON.stringify({
        sub: "U99999",
        "https://slack.com/team_id": "T99999",
        "https://slack.com/team_domain": "other-team",
      }),
      { headers: { "Content-Type": "application/json" } },
    ));

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
    global.fetch = vi.fn(async () => new Response(
      JSON.stringify({
        sub: "U00001",
        "https://slack.com/team_id": "T00001",
        "https://slack.com/team_domain": "my-team",
      }),
      { headers: { "Content-Type": "application/json" } },
    ));

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
    global.fetch = vi.fn(async () => new Response(
      JSON.stringify({
        sub: "UANY",
        "https://slack.com/team_id": "TANY",
        "https://slack.com/team_domain": "any-team",
      }),
      { headers: { "Content-Type": "application/json" } },
    ));

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

/** Helper: mock global.fetch routing /user and /orgs/... to different responses */
function mockGithubFetch({ userLogin, orgStatus }: { userLogin: string; orgStatus?: number }) {
  return vi.fn(async (url: string | URL | Request) => {
    const urlStr = typeof url === "string" ? url : url instanceof URL ? url.href : url.url;
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
    const dockerMod = await import("./docker.js");
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
    const dockerMod = await import("./docker.js");
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
    const dockerMod = await import("./docker.js");
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
    const dockerMod = await import("./docker.js");
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
