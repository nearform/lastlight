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

describe("POST /me/repos/resync", () => {
  it("rejects a session with no GitHub identity and no explicit login", async () => {
    build({ adminPassword: "hunter2" });
    const token = createToken(SECRET, "password");
    const res = await app.fetch(
      new Request("http://localhost/me/repos/resync", {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
      }),
    );
    expect(res.status).toBe(400);
  });
});
