/**
 * Pins the `GET /admin/api/executions` wire format against a REAL StateDb.
 *
 * The dashboard is a separate package with a hand-mirrored `Execution` type
 * (`dashboard/src/api.ts`) and no import edge to the server, so nothing else
 * fails when this endpoint's shape drifts — the UI just quietly renders
 * nothing. Every other admin test drives a fake `StateDb`, which would happily
 * return whatever shape the fake was written with; this one goes through the
 * actual store so the assertions are about what Drizzle really produces.
 *
 * The load-bearing assertion is the TRI-STATE on `success`. It is nullable by
 * design — `null` means "still in flight" — and the single easiest way to break
 * the state layer is to declare that column `.notNull()` or default it to
 * `false`, after which every running execution reads as a failure and the
 * dashboard's outcome bars turn red for a perfectly healthy fleet.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { createAdminRoutes, type AdminConfig } from "#src/admin/routes.js";
import type { SessionSource } from "#src/admin/sessions.js";
import type { StateDb } from "#src/state/db.js";
import { makeTestDb } from "../helpers/state-db.js";

const noSessions = {
  listSessionIds: async () => [],
  exists: async () => false,
  getSessionMeta: async () => null,
  read: async () => [],
  getFilePath: async () => null,
  normalizeRawLine: () => [],
} as unknown as SessionSource;

const config: AdminConfig = {
  stateDir: "/tmp",
  sessionsDir: "/tmp/sessions",
  adminPassword: "",
  adminSecret: "test-secret",
};

interface WireExecution {
  id: string;
  triggerType: string;
  triggerId: string;
  skill: string;
  owner?: string;
  repo?: string;
  startedAt: string;
  finishedAt?: string | null;
  success?: boolean | null;
  durationMs?: number;
  extensionStatus?: unknown;
}

let db: StateDb;

async function fetchExecutions(): Promise<WireExecution[]> {
  const app = createAdminRoutes(db, noSessions, noSessions, config);
  const res = await app.fetch(new Request("http://localhost/executions"));
  expect(res.status).toBe(200);
  const body = (await res.json()) as { executions: WireExecution[] };
  return body.executions;
}

beforeEach(async () => {
  db = await makeTestDb();

  // One succeeded, one failed, one still running.
  await db.executions.recordStart({
    id: "exec-ok",
    triggerType: "webhook",
    triggerId: "acme/widgets#1",
    skill: "triage",
    owner: "acme",
    repo: "widgets",
    issueNumber: 1,
    startedAt: "2026-08-18T09:00:00.000Z",
  });
  await db.executions.recordFinish("exec-ok", {
    success: true,
    durationMs: 1234,
    extensionStatus: { github: { status: "active" } },
  });

  await db.executions.recordStart({
    id: "exec-bad",
    triggerType: "webhook",
    triggerId: "acme/widgets#2",
    skill: "triage",
    owner: "acme",
    repo: "widgets",
    issueNumber: 2,
    startedAt: "2026-08-18T09:01:00.000Z",
  });
  await db.executions.recordFinish("exec-bad", {
    success: false,
    error: "boom",
    durationMs: 99,
  });

  // Deliberately never finished.
  await db.executions.recordStart({
    id: "exec-running",
    triggerType: "cron",
    triggerId: "acme/widgets::health",
    skill: "repo-health",
    owner: "acme",
    repo: "widgets",
    startedAt: "2026-08-18T09:02:00.000Z",
  });
});

describe("GET /admin/api/executions wire format", () => {
  it("is camelCase, with no snake_case key leaking through", async () => {
    const rows = await fetchExecutions();
    const ok = rows.find((r) => r.id === "exec-ok")!;

    expect(ok).toMatchObject({
      triggerType: "webhook",
      triggerId: "acme/widgets#1",
      skill: "triage",
      owner: "acme",
      repo: "widgets",
      startedAt: "2026-08-18T09:00:00.000Z",
      durationMs: 1234,
      success: true,
    });

    // The endpoint used to `SELECT *` and cast raw rows, so it really did
    // serve snake_case (issue #285). Assert the whole key set, not just the
    // ones above — a single leaked `trigger_id` means the mapping was bypassed.
    const snakeKeys = Object.keys(ok).filter((k) => k.includes("_"));
    expect(snakeKeys).toEqual([]);
  });

  it("keeps `success` a TRI-STATE: true, false, and null while in flight", async () => {
    const rows = await fetchExecutions();
    const byId = new Map(rows.map((r) => [r.id, r]));

    // A real boolean, not 1/0 — the dashboard types it `success?: boolean`.
    expect(byId.get("exec-ok")!.success).toBe(true);
    // Proves the boolean did not invert. `=== 0` used to be how the code
    // recognised a failure; under boolean mode that is never true again.
    expect(byId.get("exec-bad")!.success).toBe(false);
    // And the third state survives: NOT false, NOT absent-as-false.
    const running = byId.get("exec-running")!;
    expect(running.success ?? null).toBeNull();
    expect(running.finishedAt ?? null).toBeNull();
  });

  it("returns the JSON status columns as objects, not strings", async () => {
    const rows = await fetchExecutions();
    const ok = rows.find((r) => r.id === "exec-ok")!;
    // Double-encoding here fails SILENTLY: the value round-trips as a quoted
    // string and the dashboard's parse helper swallows the throw and renders
    // nothing. So assert the shape, not just that the key exists.
    expect(typeof ok.extensionStatus).toBe("object");
    expect(ok.extensionStatus).toEqual({ github: { status: "active" } });
  });
});

describe("consecutiveFailures", () => {
  it("counts the failure streak — pinned against the boolean inversion", async () => {
    // `execution-store` used to test `row.success === 0`. Under boolean mode
    // that is never true, so this would return 0 forever and the cron failure
    // alert would go quiet with nothing red anywhere.
    const seed = async (id: string, success: boolean, startedAt: string) => {
      await db.executions.recordStart({
        id,
        triggerType: "cron",
        triggerId: "acme/widgets::health",
        skill: "cron-health",
        startedAt,
      });
      await db.executions.recordFinish(id, { success, durationMs: 1 });
    };

    await seed("c1", true, "2026-08-18T10:00:00.000Z");
    await seed("c2", false, "2026-08-18T10:01:00.000Z");
    await seed("c3", false, "2026-08-18T10:02:00.000Z");

    expect(await db.executions.consecutiveFailures("cron-health")).toBe(2);

    // A success at the head resets the streak to zero.
    await seed("c4", true, "2026-08-18T10:03:00.000Z");
    expect(await db.executions.consecutiveFailures("cron-health")).toBe(0);
  });
});
