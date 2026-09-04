/**
 * The activity log's READ side (issue #206): the admin endpoint, and the
 * dashboard's hand-mirrored copy of its wire type.
 *
 * The mirror pin is the same technique `dashboard-config-mirror.test.ts` uses,
 * and exists for the same reason: `apps/server/dashboard/` has no import edge
 * to core, so `ActivityRecord` is hand-typed there. That copy drifted once
 * before — for the repo config — and hid three blocks for a release, because
 * nothing failed when it stopped matching. Read as TEXT, because the SPA is
 * not part of the server's TS program and the point is a source-level fact.
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

vi.mock("#src/admin/docker.js", () => ({
  listRunningContainers: vi.fn(async () => []),
  killContainer: vi.fn(async () => {}),
  getContainerStats: vi.fn(async () => []),
  getHostStats: vi.fn(async () => null),
}));

import { readFileSync } from "fs";
import { join } from "path";
import { createAdminRoutes, type AdminConfig } from "#src/admin/routes.js";
import { StateDb } from "#src/state/db.js";
import { ACTIVITY_ACTIONS, ACTIVITY_OUTCOMES } from "#src/state/db.js";
import type { SessionSource } from "#src/admin/sessions.js";
import {
  setRuntimeConfig,
  resetRuntimeConfigForTests,
  type LastLightConfig,
} from "#src/config/config.js";
import { makeTestDb } from "../helpers/state-db.js";

const DASHBOARD = join(import.meta.dirname, "../../dashboard/src");

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

async function get(path: string): Promise<{ status: number; body: any }> {
  const res = await app.fetch(new Request(`http://localhost${path}`));
  return { status: res.status, body: await res.json().catch(() => null) };
}

beforeEach(async () => {
  db = await makeTestDb();
  setRuntimeConfig({ botName: "last-light" } as LastLightConfig);
  app = createAdminRoutes(db, emptySessions, emptySessions, {
    stateDir: "/tmp",
    sessionsDir: "/tmp/sessions",
    adminPassword: "", // no password + no OAuth → auth open, no token plumbing
    adminSecret: "test-secret",
  } as AdminConfig);
});

afterEach(() => resetRuntimeConfigForTests());

describe("GET /admin/api/activity", () => {
  it("returns the house envelope, newest first", async () => {
    await db.activity.record({ action: "login", actorType: "admin" });
    await db.activity.record({
      action: "cron.toggle",
      actorLogin: "octocat",
      actorType: "github",
      targetType: "cron",
      targetId: "cron-review",
      detail: { enabled: false },
    });

    const res = await get("/activity");
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(2);
    expect(res.body.activity).toHaveLength(2);
    expect(res.body.activity[0].action).toBe("cron.toggle");
    expect(res.body.activity[0].detail).toEqual({ enabled: false });
  });

  it("clamps limit and offset the same way the other list endpoints do", async () => {
    for (let i = 0; i < 5; i++) await db.activity.record({ action: "login" });

    // A falsy limit — `0`, or unparseable — falls back to the DEFAULT rather
    // than clamping to 1, because `parseInt(...) || 50` short-circuits. That is
    // the behaviour of `/feedback/signals` and `/workflow-runs` verbatim, and
    // consistency across the list endpoints beats a marginally tidier rule here.
    expect((await get("/activity?limit=0")).body.activity).toHaveLength(5);
    expect((await get("/activity?limit=abc")).body.activity).toHaveLength(5);
    // A real value above the ceiling is clamped to 200 (only 5 rows exist).
    expect((await get("/activity?limit=99999")).body.activity).toHaveLength(5);
    expect((await get("/activity?limit=2")).body.activity).toHaveLength(2);
    // A negative offset floors at 0 rather than throwing.
    expect((await get("/activity?offset=-5")).body.activity).toHaveLength(5);
    expect((await get("/activity?offset=3")).body.activity).toHaveLength(2);
  });

  it("filters by actor, action and since", async () => {
    await db.activity.record({ action: "login", actorLogin: "alice" });
    await db.activity.record({ action: "cron.fire", actorLogin: "bob" });

    expect((await get("/activity?actor=alice")).body.total).toBe(1);
    expect((await get("/activity?action=cron.fire")).body.total).toBe(1);
    expect((await get("/activity?since=2999-01-01T00:00:00.000Z")).body.total).toBe(0);
  });

  it("splits ?target= on the FIRST colon, so an id containing one survives", async () => {
    await db.activity.record({
      action: "container.kill",
      targetType: "container",
      targetId: "lastlight-sandbox-a:b",
    });

    const res = await get("/activity?target=container:lastlight-sandbox-a:b");
    expect(res.body.total).toBe(1);
    expect(res.body.activity[0].targetId).toBe("lastlight-sandbox-a:b");
  });

  it("serves the per-run strip through the same target filter", async () => {
    await db.activity.record({
      action: "workflow.cancel",
      targetType: "workflow_run",
      targetId: "run-1",
    });
    await db.activity.record({
      action: "workflow.cancel",
      targetType: "workflow_run",
      targetId: "run-2",
    });

    const res = await get("/activity?target=workflow_run:run-1");
    expect(res.body.total).toBe(1);
    expect(res.body.activity[0].targetId).toBe("run-1");
  });

  it("enriches actors from the users table, once per distinct login", async () => {
    await db.users.getOrCreateUserByGithub({
      githubId: 1,
      login: "octocat",
      name: "Mona Lisa",
      avatarUrl: "https://example.test/mona.png",
    });
    await db.activity.record({ action: "login", actorLogin: "octocat", actorType: "github" });
    await db.activity.record({ action: "cron.fire", actorLogin: "octocat", actorType: "github" });
    // An actor with no `users` row must not break the page.
    await db.activity.record({ action: "login", actorLogin: "ghost" });

    const res = await get("/activity");
    expect(res.body.users.octocat).toMatchObject({
      login: "octocat",
      name: "Mona Lisa",
      avatarUrl: "https://example.test/mona.png",
    });
    expect(res.body.users.ghost).toBeUndefined();
  });

  it("exposes the distinct verbs present", async () => {
    await db.activity.record({ action: "login" });
    await db.activity.record({ action: "cron.fire" });
    await db.activity.record({ action: "cron.fire" });

    const res = await get("/activity/actions");
    expect(res.body.actions).toEqual(["cron.fire", "login"]);
  });
});

describe("the dashboard's hand-mirrored ActivityRecord", () => {
  const apiSource = readFileSync(join(DASHBOARD, "api.ts"), "utf8");

  it("declares every outcome the server can write", () => {
    const block = apiSource.slice(apiSource.indexOf("export interface ActivityRecord"));
    for (const outcome of ACTIVITY_OUTCOMES) {
      expect(block, `dashboard ActivityRecord is missing outcome "${outcome}"`).toContain(
        `"${outcome}"`,
      );
    }
  });

  it("offers every verb in the CLI's help text", () => {
    // The CLI lists the vocabulary so `lastlight activity help` is a real
    // reference rather than a shrug. Pin it: a verb added to the union and not
    // to the help is a verb nobody can discover.
    const cliSource = readFileSync(
      join(import.meta.dirname, "../../../../packages/cli/src/cli.ts"),
      "utf8",
    );
    const helpBlock = cliSource.slice(
      cliSource.indexOf("${chalk.bold(\"Activity\")}"),
      cliSource.indexOf("${chalk.bold(\"Logs\")}"),
    );
    expect(helpBlock.length).toBeGreaterThan(0);
    for (const action of ACTIVITY_ACTIONS) {
      // The help groups verbs by prefix (`workflow.trigger|retry|cancel`), so
      // match on the noun and the bare verb rather than the whole string.
      const [noun, verb] = action.split(".");
      expect(helpBlock, `\`lastlight activity help\` does not mention "${action}"`).toContain(noun!);
      if (verb) expect(helpBlock).toContain(verb);
    }
  });
});
