import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { StateDb } from "#src/state/db.js";
import type { SessionReader } from "#src/admin/session-reader.js";
import type { AdminConfig } from "#src/admin/routes.js";

/**
 * `GET /crons` answers from ONE ledger (issues #341/#327).
 *
 * It used to branch on the kind of cron: a workflow cron's `lastRun` came from
 * whichever of its dispatched `workflow_runs` happened to sort first in
 * `listRecent(50)` — an arbitrary child, not the tick — and a handler cron's
 * from `lastHandlerTick`. Both now read `cron_runs`, keyed on the cron name, so
 * the branch is gone and the counts a fire recorded are actually surfaced.
 */

vi.mock("#src/logging/logger.js", () => {
  const noopLogger = {
    debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), fatal: vi.fn(),
    child: () => noopLogger,
  };
  return { logger: () => noopLogger };
});

vi.mock("#src/workflows/loader.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("#src/workflows/loader.js")>();
  return {
    ...actual,
    getCronWorkflows: () => [
      { name: "merge-green-dependency-prs", workflow: "dependabot-pr-merge", schedule: "0 * * * *" },
      { name: "repo-digest", handler: "repo-digest", schedule: "0 9 * * 1" },
    ],
  };
});

vi.mock("#src/admin/docker.js", () => ({
  listRunningContainers: vi.fn(async () => []),
  killContainer: vi.fn(async () => {}),
  getContainerStats: vi.fn(async () => []),
  getHostStats: vi.fn(async () => null),
}));
vi.mock("#src/sandbox/k8s/client.js", () => ({ makeK8sApis: vi.fn(() => ({}) as unknown) }));

const { createAdminRoutes } = await import("#src/admin/routes.js");
const { StateDb } = await import("#src/state/db.js");

interface CronRow {
  name: string;
  workflow: string | null;
  handler: string | null;
  lastRun: string | null;
  lastStatus: string | null;
  recentFailures: number;
  reposEligible: number | null;
  reposScanned: number | null;
  discovered: number | null;
  dispatched: number | null;
}

let db: InstanceType<typeof StateDb>;

beforeEach(() => {
  db = new StateDb(":memory:");
});

afterEach(() => {
  db.close();
});

function makeApp() {
  return createAdminRoutes(db as unknown as StateDb, {} as unknown as SessionReader, {} as unknown as SessionReader, {
    stateDir: "/tmp",
    sessionsDir: "/tmp/sessions",
    adminPassword: "",
    adminSecret: "test-secret",
  } as AdminConfig);
}

async function listCrons(): Promise<CronRow[]> {
  const app = makeApp();
  const res = await app.fetch(new Request("http://localhost/crons"));
  expect(res.status).toBe(200);
  const body = (await res.json()) as { crons: CronRow[] };
  return body.crons;
}

describe("GET /crons — derived from the cron_runs ledger", () => {
  it("surfaces a workflow cron's fire, counts included", async () => {
    const id = db.cronRuns.start({
      cronName: "merge-green-dependency-prs",
      workflow: "dependabot-pr-merge",
      source: "schedule",
      actor: null,
    });
    db.cronRuns.finish(id, {
      status: "ok",
      reposEligible: 19,
      reposScanned: 14,
      discovered: 0,
      dispatched: 0,
      failures: 0,
    });

    const row = (await listCrons()).find((c) => c.name === "merge-green-dependency-prs")!;

    // The case the feature exists for: scanned 14, found 0 — a green event
    // rather than the silence a zero-discovery fire used to leave.
    expect(row.lastStatus).toBe("ok");
    expect(row.lastRun).not.toBeNull();
    expect(row.reposEligible).toBe(19);
    expect(row.reposScanned).toBe(14);
    expect(row.discovered).toBe(0);
    expect(row.dispatched).toBe(0);
  });

  it("still surfaces a HANDLER cron's tick — the #333 regression guard", async () => {
    const id = db.cronRuns.start({
      cronName: "repo-digest",
      handler: "repo-digest",
      source: "schedule",
      actor: null,
    });
    db.cronRuns.finish(id, { status: "ok" });

    const row = (await listCrons()).find((c) => c.name === "repo-digest")!;

    // Before #333 this reported a hardcoded 0/null, so a weekly cron could fail
    // for a month behind a healthy-looking dashboard. Unifying the read path
    // must not put it back.
    expect(row.lastStatus).toBe("ok");
    expect(row.lastRun).not.toBeNull();
    expect(row.handler).toBe("repo-digest");
    expect(row.workflow).toBeNull();
  });

  it("reports a partial fire as partial, not as success", async () => {
    const id = db.cronRuns.start({
      cronName: "merge-green-dependency-prs",
      workflow: "dependabot-pr-merge",
      source: "schedule",
      actor: null,
    });
    db.cronRuns.finish(id, { status: "partial", dispatched: 14, failures: 3 });

    const row = (await listCrons()).find((c) => c.name === "merge-green-dependency-prs")!;

    // `executions.success` is a boolean, so this fire used to be indistinguishable
    // from a clean one.
    expect(row.lastStatus).toBe("partial");
    expect(row.dispatched).toBe(14);
  });

  it("counts consecutive failures per cron, not per workflow", async () => {
    for (let i = 0; i < 2; i++) {
      const id = db.cronRuns.start({
        cronName: "merge-green-dependency-prs",
        workflow: "dependabot-pr-merge",
        source: "schedule",
        actor: null,
      });
      db.cronRuns.finish(id, { status: "failed", error: "boom" });
    }

    const rows = await listCrons();
    expect(rows.find((c) => c.name === "merge-green-dependency-prs")!.recentFailures).toBe(2);
    // A different cron is unaffected, even on the same workflow.
    expect(rows.find((c) => c.name === "repo-digest")!.recentFailures).toBe(0);
  });

  it("reports nulls for a cron that has never fired", async () => {
    const row = (await listCrons()).find((c) => c.name === "repo-digest")!;
    expect(row.lastRun).toBeNull();
    expect(row.lastStatus).toBeNull();
    expect(row.recentFailures).toBe(0);
    expect(row.reposScanned).toBeNull();
  });
});
