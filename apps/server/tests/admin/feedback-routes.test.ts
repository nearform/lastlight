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
import type { SessionReader } from "#src/admin/sessions.js";
import {
  setRuntimeConfig,
  resetRuntimeConfigForTests,
  type LastLightConfig,
} from "#src/config/config.js";
import { makeTestDb } from "../helpers/state-db.js";

let db: StateDb;
let app: ReturnType<typeof createAdminRoutes>;

function makeConfig(): AdminConfig {
  return {
    stateDir: "/tmp",
    sessionsDir: "/tmp/sessions",
    adminPassword: "", // no password + no OAuth → auth open, so no token plumbing
    adminSecret: "test-secret",
  } as AdminConfig;
}

async function get(path: string): Promise<{ status: number; body: any }> {
  const res = await app.fetch(new Request(`http://localhost${path}`));
  return { status: res.status, body: await res.json().catch(() => null) };
}

async function seed(over: { workflowName?: string; runId?: string; emoji?: string; score?: number } = {}) {
  const anchor = await db.feedback.upsertAnchor({
    source: "github",
    kind: "issue_comment",
    externalId: `c-${Math.random()}`,
    nodeId: null,
    channel: null,
    owner: "nearform",
    repo: "lastlight",
    issueNumber: 255,
    workflowRunId: over.runId ?? null,
    workflowName: over.workflowName ?? "pr-review",
    messagingSessionId: null,
  });
  return db.feedback.recordSignal({
    anchor,
    emoji: over.emoji ?? "+1",
    score: over.score ?? 1,
    sentiment: (over.score ?? 1) > 0 ? "good" : "bad",
    reactor: `u-${Math.random()}`,
  });
}

beforeEach(async () => {
  db = await makeTestDb();
  setRuntimeConfig({ botName: "last-light" } as LastLightConfig);
  app = createAdminRoutes(db, {} as unknown as SessionReader, undefined as never, makeConfig());
});
afterEach(() => {
  resetRuntimeConfigForTests();
});

describe("GET /feedback/signals", () => {
  it("returns the live feed with a total", async () => {
    await seed();
    await seed({ emoji: "-1", score: -1 });
    const { status, body } = await get("/feedback/signals");
    expect(status).toBe(200);
    expect(body.total).toBe(2);
    expect(body.signals).toHaveLength(2);
  });

  it("filters by workflow and source", async () => {
    await seed({ workflowName: "pr-review" });
    await seed({ workflowName: "issue-triage" });
    expect((await get("/feedback/signals?workflow=pr-review")).body.total).toBe(1);
    expect((await get("/feedback/signals?source=github")).body.total).toBe(2);
    expect((await get("/feedback/signals?source=slack")).body.total).toBe(0);
    // An unrecognised source is ignored rather than 400ing an analytics read.
    expect((await get("/feedback/signals?source=carrier-pigeon")).body.total).toBe(2);
  });

  it("clamps limit and offset, falling back to the default on a junk value", async () => {
    for (let i = 0; i < 3; i++) await seed();
    expect((await get("/feedback/signals?limit=1")).body.signals).toHaveLength(1);
    expect((await get("/feedback/signals?limit=99999")).body.signals).toHaveLength(3);
    // `parseInt(x) || default` — the house idiom (see /stats/daily): 0 and
    // unparseable values are both falsy, so they take the default rather than
    // returning an empty page.
    expect((await get("/feedback/signals?limit=0")).body.signals).toHaveLength(3);
    expect((await get("/feedback/signals?limit=nonsense")).body.signals).toHaveLength(3);
    expect((await get("/feedback/signals?offset=-5")).body.signals).toHaveLength(3);
    expect((await get("/feedback/signals?offset=99")).body.signals).toHaveLength(0);
  });

  it("hides retracted signals unless asked", async () => {
    const signal = (await seed())!;
    await db.feedback.removeSignal(signal.anchorId, signal.reactor, signal.emoji);
    expect((await get("/feedback/signals")).body.total).toBe(0);
    expect((await get("/feedback/signals?includeRemoved=1")).body.total).toBe(1);
  });
});

describe("GET /feedback/summary", () => {
  it("groups by workflow and echoes the window", async () => {
    await seed({ workflowName: "pr-review" });
    await seed({ workflowName: "pr-review", emoji: "-1", score: -1 });
    await seed({ workflowName: "issue-triage" });

    const { body } = await get("/feedback/summary?days=7");
    expect(body.days).toBe(7);
    const review = body.summary.find((r: any) => r.workflowName === "pr-review");
    expect(review).toMatchObject({ total: 2, positive: 1, negative: 1, averageScore: 0 });
  });

  it("clamps days at the top and defaults a junk value", async () => {
    expect((await get("/feedback/summary?days=9999")).body.days).toBe(365);
    expect((await get("/feedback/summary?days=0")).body.days).toBe(30);
    expect((await get("/feedback/summary?days=lots")).body.days).toBe(30);
    expect((await get("/feedback/summary?days=-3")).body.days).toBe(1);
  });
});

describe("GET /feedback/daily", () => {
  it("returns a zero-filled series of the requested length", async () => {
    await seed();
    const { body } = await get("/feedback/daily?days=5");
    expect(body.daily).toHaveLength(5);
    expect(body.daily.at(-1)).toMatchObject({ total: 1, positive: 1 });
  });

  it("filters by workflow", async () => {
    await seed({ workflowName: "pr-review" });
    const { body } = await get("/feedback/daily?days=2&workflow=issue-triage");
    expect(body.daily.every((d: any) => d.total === 0)).toBe(true);
  });
});

describe("GET /workflow-runs/:id/feedback", () => {
  it("returns everything said about one run", async () => {
    await db.runs.createRun({
      id: "run-42",
      workflowName: "pr-review",
      triggerId: "nearform/lastlight#255",
      currentPhase: "start",
      status: "succeeded",
      startedAt: new Date().toISOString(),
    });
    await seed({ runId: "run-42" });

    const { status, body } = await get("/workflow-runs/run-42/feedback");
    expect(status).toBe(200);
    expect(body.signals).toHaveLength(1);
    expect(body.signals[0].workflowRunId).toBe("run-42");
  });

  it("404s an unknown run", async () => {
    const { status, body } = await get("/workflow-runs/nope/feedback");
    expect(status).toBe(404);
    expect(body.error).toContain("not found");
  });
});
