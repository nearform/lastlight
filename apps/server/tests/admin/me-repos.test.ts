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
import { StateDb } from "#src/state/db.js";
import type { SessionSource } from "#src/admin/sessions.js";
import { createToken } from "#src/admin/auth.js";
import { resetRuntimeConfigForTests } from "#src/config/config.js";

const SECRET = "test-secret";

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
    ...config,
  } as AdminConfig);
}

async function get(path: string, token?: string) {
  const headers: Record<string, string> = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await app.fetch(new Request(`http://localhost${path}`, { headers }));
  return { status: res.status, body: await res.json().catch(() => null) };
}

beforeEach(() => {
  db = new StateDb(":memory:");
});

afterEach(() => {
  db.close();
  resetRuntimeConfigForTests();
});

describe("GET /me/repos", () => {
  it("returns the fail-open sentinel when auth is off (no identity)", async () => {
    build({ adminPassword: "" });
    const { status, body } = await get("/me/repos");
    expect(status).toBe(200);
    // `repos: null` is the sentinel the dashboard reads as "no filter".
    expect(body.repos).toBeNull();
    expect(body.reason).toBe("no-identity");
  });

  it("returns the sentinel for a password login, which carries no GitHub login", async () => {
    build({ adminPassword: "hunter2" });
    const token = createToken(SECRET, "password");
    const { status, body } = await get("/me/repos", token);
    expect(status).toBe(200);
    expect(body.repos).toBeNull();
    expect(body.reason).toBe("no-identity");
  });

  it("returns the sentinel for a GitHub login while the feature is off", async () => {
    // `teamVisibility.enabled` defaults to false (it needs the App's org
    // `Members: read` re-consent), so an existing deployment sees exactly
    // today's behaviour until an operator turns it on.
    build({ adminPassword: "hunter2" });
    const token = createToken(SECRET, "github", "alice");
    const { status, body } = await get("/me/repos", token);
    expect(status).toBe(200);
    expect(body.repos).toBeNull();
    expect(body.reason).toBe("disabled");
  });

  it("is behind auth like every other admin route", async () => {
    build({ adminPassword: "hunter2" });
    const { status } = await get("/me/repos");
    expect(status).toBe(401);
  });
});

describe("GET /workflow-runs?repos= — the visibility scope as a query filter", () => {
  function seedRun(id: string, owner: string, repo: string) {
    db.runs.createRun({
      id,
      workflowName: "pr-review",
      triggerId: `${owner}/${repo}#1`,
      owner,
      repo,
      issueNumber: 1,
      currentPhase: "review",
      status: "running",
      startedAt: "2026-08-06T10:00:00.000Z",
      updatedAt: "2026-08-06T10:00:00.000Z",
    });
  }

  it("scopes to the named repos, with a matching total", async () => {
    build({ adminPassword: "" });
    seedRun("r1", "nearform", "lastlight");
    seedRun("r2", "nearform", "www");
    seedRun("r3", "nearform", "unrelated");

    const { body } = await get("/workflow-runs?repos=nearform/lastlight,nearform/www");
    expect(body.total).toBe(2);
    expect(body.workflowRuns.map((r: any) => r.repo).sort()).toEqual(["lastlight", "www"]);
  });

  it("returns global data when the param is omitted — it is a filter, not a gate", async () => {
    build({ adminPassword: "" });
    seedRun("r1", "nearform", "lastlight");
    seedRun("r2", "nearform", "unrelated");

    const { body } = await get("/workflow-runs");
    expect(body.total).toBe(2);
  });

  it("ignores an empty/blank param rather than matching nothing", async () => {
    build({ adminPassword: "" });
    seedRun("r1", "nearform", "lastlight");

    const { body } = await get("/workflow-runs?repos=");
    expect(body.total).toBe(1);
  });
});

describe("POST /me/repos/resync", () => {
  async function resync(token: string, qs = "") {
    return app.fetch(
      new Request(`http://localhost/me/repos/resync${qs}`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
      }),
    );
  }

  it("rejects a session with no GitHub identity", async () => {
    build({ adminPassword: "hunter2" });
    const res = await resync(createToken(SECRET, "password"));
    expect(res.status).toBe(400);
  });

  it("ignores ?login= — a session can only resync itself", async () => {
    // The response carries `teams`, naming the GitHub org teams a person
    // belongs to (including secret ones). A password-only session has no
    // identity to check an override against, so honouring the param would let
    // any authenticated caller enumerate anyone's membership.
    build({ adminPassword: "hunter2" });
    const res = await resync(createToken(SECRET, "password"), "?login=alice");
    expect(res.status).toBe(400);
  });

  it("resyncs the session's own login, not the query param's", async () => {
    build({ adminPassword: "hunter2" });
    const res = await resync(createToken(SECRET, "github", "bob"), "?login=alice");
    expect(res.status).toBe(200);
    // teamVisibility is off by default, so this is the fail-open sentinel —
    // the point is that it answered for the SESSION rather than for alice.
    const body = await res.json();
    expect(body.repos).toBeNull();
    expect(body.reason).toBe("disabled");
  });
});
