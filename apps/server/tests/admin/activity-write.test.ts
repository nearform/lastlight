/**
 * The activity log's WRITE side (issue #206).
 *
 * Four properties, in rough order of how much they'd hurt to lose:
 *
 * 1. **Exactly one row per action** — #206's acceptance criterion, asserted as a
 *    count rather than a "contains", because a double-write is exactly as wrong
 *    as a missing one and only a count catches it.
 * 2. **A store failure never fails the action.** The whole reason the swallow
 *    lives in `recordActivity` and not in `ActivityStore.record`.
 * 3. **The actor is the authenticated user**, on the three routes that used to
 *    hardcode `"admin"`.
 * 4. **Every mutating route is either logged or explicitly exempt** — the pin
 *    that replaces the coverage a middleware would have given.
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

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createAdminRoutes, type AdminConfig } from "#src/admin/routes.js";
import { createToken } from "#src/admin/auth.js";
import { StateDb } from "#src/state/db.js";
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
/** A password session — authenticated, but carries NO login. */
const PASSWORD_TOKEN = createToken(SECRET, "password");

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

beforeEach(async () => {
  db = await makeTestDb();
  setRuntimeConfig({ botName: "last-light" } as LastLightConfig);
  build();
});

afterEach(() => {
  resetRuntimeConfigForTests();
  vi.restoreAllMocks();
});

describe("activity log — the write side", () => {
  describe("exactly one row per action", () => {
    it("writes one row for a workflow toggle, attributed to the authenticated user", async () => {
      // `getWorkflow` validates the name, so use one the packaged set defines.
      const res = await send("POST", "/workflows/pr-review/toggle", { token: GITHUB_TOKEN });
      expect(res.status).toBe(200);

      const { activity, total } = await db.activity.list();
      expect(total).toBe(1);
      expect(activity[0]).toMatchObject({
        action: "workflow.toggle",
        actorLogin: "octocat",
        actorType: "github",
        targetType: "workflow",
        targetId: "pr-review",
        outcome: "ok",
      });
      expect(activity[0].detail).toEqual({ enabled: false });
    });

    it("writes one row per toggle, not one per request handled", async () => {
      await send("POST", "/workflows/pr-review/toggle", { token: GITHUB_TOKEN });
      await send("POST", "/workflows/pr-review/toggle", { token: GITHUB_TOKEN });
      const { total } = await db.activity.list();
      expect(total).toBe(2);
    });

    it("writes nothing when the action never happened", async () => {
      const res = await send("POST", "/workflows/no-such-workflow/toggle", {
        token: GITHUB_TOKEN,
      });
      expect(res.status).toBe(404);
      expect((await db.activity.list()).total).toBe(0);
    });
  });

  describe("the actor", () => {
    it("records the login on the routes that used to hardcode admin", async () => {
      await send("POST", "/workflows/pr-review/toggle", { token: GITHUB_TOKEN });

      // Both the activity row AND the override column now name the person.
      const { activity } = await db.activity.list();
      expect(activity[0].actorLogin).toBe("octocat");
      const overrides = await db.getAllWorkflowOverrides();
      expect(overrides.get("pr-review")?.updatedBy).toBe("octocat");
    });

    it("leaves actor_login null for a password session, but still records how", async () => {
      await send("POST", "/workflows/pr-review/toggle", { token: PASSWORD_TOKEN });

      const { activity } = await db.activity.list();
      // Deliberately NOT "admin": in an audit stream that reads as a person.
      expect(activity[0].actorLogin).toBeUndefined();
      // …but the row is not anonymous about HOW it happened.
      expect(activity[0].actorType).toBe("admin");

      // The override column keeps its literal fallback — an existing wire
      // contract the dashboard renders, deliberately not changed here.
      const overrides = await db.getAllWorkflowOverrides();
      expect(overrides.get("pr-review")?.updatedBy).toBe("admin");
    });
  });

  describe("outcome", () => {
    it("records a denied login on a bad password, and an ok one on a good password", async () => {
      await send("POST", "/login", { body: { password: "wrong" } });
      await send("POST", "/login", { body: { password: "hunter2" } });

      const { activity, total } = await db.activity.list();
      expect(total).toBe(2);
      // Newest first.
      expect(activity[0]).toMatchObject({ action: "login", outcome: "ok", actorType: "admin" });
      expect(activity[1]).toMatchObject({ action: "login", outcome: "denied" });
      // Password login never learns a login, by construction.
      expect(activity[1].actorLogin).toBeUndefined();
    });
  });

  describe("best-effort: the log never fails the action", () => {
    it("still performs the action when the store throws", async () => {
      const boom = vi
        .spyOn(db.activity, "record")
        .mockRejectedValue(new Error("disk on fire"));

      const res = await send("POST", "/workflows/pr-review/toggle", { token: GITHUB_TOKEN });

      // The request succeeded…
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ name: "pr-review", enabled: false });
      // …the underlying state change landed…
      const overrides = await db.getAllWorkflowOverrides();
      expect(overrides.get("pr-review")?.enabled).toBe(false);
      // …and the write was genuinely attempted, not skipped.
      expect(boom).toHaveBeenCalledOnce();
    });

    it("the store itself still rejects — the swallow lives one level up", async () => {
      // If `record` swallowed internally this would resolve, and the test above
      // would be vacuous: it would pass whether or not the helper caught.
      const closed = await makeTestDb();
      await closed.close();
      await expect(closed.activity.record({ action: "login" })).rejects.toThrow();
    });
  });

  /**
   * The pin that replaces middleware's coverage guarantee.
   *
   * Every mutating route must be either in the verb map or explicitly exempt
   * with a reason. A new route added without a log line fails here rather than
   * silently going unaudited — which is the one thing the explicit-call
   * approach cannot get for free.
   */
  describe("route coverage", () => {
    const LOGGED = new Set([
      "POST /login",
      "DELETE /containers/:name",
      "POST /workflow-runs/:id/cancel",
      "POST /workflow-runs/:id/retry",
      "POST /workflows/:name/toggle",
      "PUT /artifacts/:owner/:repo/:key/:doc",
      "POST /approvals/:id/respond",
      "POST /crons/:name/toggle",
      "POST /crons/:name/schedule",
      "DELETE /crons/:name/override",
      "POST /crons/:name/trigger",
      "POST /prs/:owner/:repo/:number/retry",
    ]);

    /** Deliberately unlogged, with the reason. */
    const NOT_LOGGED = new Map([
      ["POST /me/repos/resync", "a self-service cache refresh, not an action on the system"],
      ["POST /token/refresh", "a session slide on a timer, not an action; would drown the logins"],
      ["POST /route-test", "a hermetic router dry-run with no side effects"],
    ]);

    it("every mutating route is either logged or explicitly exempt", () => {
      const source = readFileSync(
        fileURLToPath(new URL("../../src/admin/routes.ts", import.meta.url)),
        "utf8",
      );
      const found = [...source.matchAll(/app\.(post|put|delete|patch)\("([^"]+)"/g)].map(
        (m) => `${m[1]!.toUpperCase()} ${m[2]}`,
      );

      expect(found.length).toBeGreaterThan(0);
      const unaccounted = found.filter((r) => !LOGGED.has(r) && !NOT_LOGGED.has(r));
      expect(
        unaccounted,
        "a mutating route that neither writes an activity row nor declares why not — " +
          "add a recordActivityFor(...) call, or add it to NOT_LOGGED with a reason",
      ).toEqual([]);
    });

    it("the exempt list has not gone stale", () => {
      const source = readFileSync(
        fileURLToPath(new URL("../../src/admin/routes.ts", import.meta.url)),
        "utf8",
      );
      const found = new Set(
        [...source.matchAll(/app\.(post|put|delete|patch)\("([^"]+)"/g)].map(
          (m) => `${m[1]!.toUpperCase()} ${m[2]}`,
        ),
      );
      // A route that was removed should not linger in either list.
      for (const route of [...LOGGED, ...NOT_LOGGED.keys()]) {
        expect(found.has(route), `${route} is listed but no longer exists`).toBe(true);
      }
    });
  });
});
