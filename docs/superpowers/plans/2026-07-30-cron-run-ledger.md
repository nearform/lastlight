# Cron-run Ledger Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make every cron fire (scheduled or manual) a first-class, persisted record so a zero-discovery backstop fire shows as a green "ran, scanned N, found 0" event on the dashboard instead of silence.

**Architecture:** Add a `cron_runs` peer ledger table + `CronRunStore` (same pattern as `executions`/`workflow_runs`). Extract the inline `cronRunner` closure from `index.ts` into a testable `makeCronRunner` factory that records a `cron_runs` row around the discovery/fan-out body and emits an OTel span + counter. Point `GET /crons` at the new store and surface the counts in the dashboard.

**Tech Stack:** TypeScript (ESM, Node 22), better-sqlite3, Hono (admin API), Vitest, React (dashboard), OpenTelemetry.

## Global Constraints

- Node 22 LTS, ESM only (`"type": "module"`) — relative imports use `.js` extensions.
- Absolute-import rule does not apply here; this package uses relative imports with `.js` (follow the files being edited).
- Migrations are idempotent: additive `CREATE TABLE IF NOT EXISTS` / `CREATE INDEX IF NOT EXISTS` in `src/state/migrate.ts`.
- `WorkflowRunner` signature stays `(workflow: string, context: Record<string, unknown>) => Promise<void>` — do NOT change it.
- OTel calls must be no-ops when telemetry is disabled (use the existing `withSpan` / a `recordCronFire` helper that guards on `enabled`).
- Status vocabulary is exactly `running` | `ok` | `partial` | `failed`. A no-op fire (0 discovered, 0 dispatched) is `ok`.
- Run tests from `apps/server`: `npx vitest run <path>`. Full gate from repo root: `pnpm turbo run typecheck test build`.
- Commit after each task. Branch: `worktree-feat+cron-run-ledger` (push to remote `feat/cron-run-ledger` at PR time).

---

## Task 0: Environment baseline

**Files:** none (setup only)

- [ ] **Step 1: Install workspace deps in the worktree**

Run (from repo root): `pnpm install`
Expected: completes; `apps/server/node_modules` present.

- [ ] **Step 2: Establish green baseline**

Run (from repo root): `pnpm --filter lastlight-core test`
Expected: PASS (docker ITs self-skip). If anything fails, STOP and report — do not build on a red baseline.

---

## Task 1: `cron_runs` table + `CronRunStore`

**Files:**
- Modify: `apps/server/src/state/migrate.ts` (add table + index inside the `db.exec()` block, after the `cron_overrides` table)
- Create: `apps/server/src/state/cron-run-store.ts`
- Modify: `apps/server/src/state/db.ts` (export type + store, add `readonly cronRuns`, construct it)
- Test: `apps/server/tests/state/cron-run-store.test.ts`

**Interfaces:**
- Produces:
  - `interface CronRunRecord { id: string; cronName: string; workflow: string; source: "schedule" | "manual"; actor: string | null; startedAt: string; finishedAt: string | null; status: "running" | "ok" | "partial" | "failed"; reposScanned: number | null; discovered: number | null; dispatched: number | null; failures: number | null; error: string | null; }`
  - `class CronRunStore` with:
    - `start(meta: { cronName: string; workflow: string; source: "schedule" | "manual"; actor: string | null }): string` (returns id)
    - `finish(id: string, result: { status: "ok" | "partial" | "failed"; reposScanned: number | null; discovered: number | null; dispatched: number | null; failures: number | null; error?: string }): void`
    - `latestByCron(): Map<string, CronRunRecord>`
    - `recentFailures(cronName: string): number`
  - `StateDb` gains `readonly cronRuns: CronRunStore`.

- [ ] **Step 1: Write the failing test**

Create `apps/server/tests/state/cron-run-store.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { StateDb } from "#src/state/db.js";

describe("CronRunStore", () => {
  let db: StateDb;
  beforeEach(() => { db = new StateDb(":memory:"); });
  afterEach(() => { db.close(); });

  it("start() inserts a running row; finish() stamps the terminal fields", () => {
    const id = db.cronRuns.start({
      cronName: "merge-green-dependency-prs",
      workflow: "dependabot-pr-merge",
      source: "manual",
      actor: "robinbowes",
    });
    let latest = db.cronRuns.latestByCron().get("merge-green-dependency-prs")!;
    expect(latest.status).toBe("running");
    expect(latest.finishedAt).toBeNull();
    expect(latest.actor).toBe("robinbowes");

    db.cronRuns.finish(id, {
      status: "ok", reposScanned: 14, discovered: 0, dispatched: 0, failures: 0,
    });
    latest = db.cronRuns.latestByCron().get("merge-green-dependency-prs")!;
    expect(latest.status).toBe("ok");
    expect(latest.finishedAt).not.toBeNull();
    expect(latest.reposScanned).toBe(14);
    expect(latest.discovered).toBe(0);
  });

  it("latestByCron() returns the newest row per cron name", () => {
    const a = db.cronRuns.start({ cronName: "c1", workflow: "w", source: "schedule", actor: null });
    db.cronRuns.finish(a, { status: "ok", reposScanned: 1, discovered: null, dispatched: 1, failures: 0 });
    const b = db.cronRuns.start({ cronName: "c1", workflow: "w", source: "schedule", actor: null });
    db.cronRuns.finish(b, { status: "partial", reposScanned: 2, discovered: null, dispatched: 2, failures: 1 });
    expect(db.cronRuns.latestByCron().get("c1")!.status).toBe("partial");
  });

  it("recentFailures() counts consecutive non-ok terminal rows newest-first, reset by an ok", () => {
    const fin = (status: "ok" | "partial" | "failed") => {
      const id = db.cronRuns.start({ cronName: "c2", workflow: "w", source: "schedule", actor: null });
      db.cronRuns.finish(id, { status, reposScanned: 0, discovered: 0, dispatched: 0, failures: status === "ok" ? 0 : 1 });
    };
    fin("ok"); fin("failed"); fin("partial");
    expect(db.cronRuns.recentFailures("c2")).toBe(2);
    fin("ok");
    expect(db.cronRuns.recentFailures("c2")).toBe(0);
  });

  it("recentFailures() ignores a still-running row", () => {
    const done = db.cronRuns.start({ cronName: "c3", workflow: "w", source: "schedule", actor: null });
    db.cronRuns.finish(done, { status: "failed", reposScanned: 0, discovered: 0, dispatched: 0, failures: 1 });
    db.cronRuns.start({ cronName: "c3", workflow: "w", source: "schedule", actor: null }); // running, unfinished
    expect(db.cronRuns.recentFailures("c3")).toBe(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/state/cron-run-store.test.ts` (from `apps/server`)
Expected: FAIL — `db.cronRuns` is undefined / table missing.

- [ ] **Step 3: Add the table to `migrate.ts`**

In `apps/server/src/state/migrate.ts`, inside the `db.exec(\`…\`)` template, immediately after the `cron_overrides` table block, add:

```sql
    CREATE TABLE IF NOT EXISTS cron_runs (
      id TEXT PRIMARY KEY,
      cron_name TEXT NOT NULL,
      workflow TEXT NOT NULL,
      source TEXT NOT NULL,
      actor TEXT,
      started_at TEXT NOT NULL,
      finished_at TEXT,
      status TEXT NOT NULL DEFAULT 'running',
      repos_scanned INTEGER,
      discovered INTEGER,
      dispatched INTEGER,
      failures INTEGER,
      error TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_cron_runs_name_started ON cron_runs(cron_name, started_at DESC);
```

- [ ] **Step 4: Create `CronRunStore`**

Create `apps/server/src/state/cron-run-store.ts`:

```ts
import type Database from "better-sqlite3";
import { randomUUID } from "node:crypto";

export interface CronRunRecord {
  id: string;
  cronName: string;
  workflow: string;
  source: "schedule" | "manual";
  actor: string | null;
  startedAt: string;
  finishedAt: string | null;
  status: "running" | "ok" | "partial" | "failed";
  reposScanned: number | null;
  discovered: number | null;
  dispatched: number | null;
  failures: number | null;
  error: string | null;
}

/**
 * Owns the `cron_runs` ledger — one row per cron *fire* (scheduled or manual),
 * distinct from the `workflow_runs` a fire may (or may not) dispatch. A
 * zero-discovery fire writes no workflow_run, so this is the only record that a
 * backstop cron ran at all. Peer of {@link ExecutionStore}; constructed on the
 * shared `Database` connection.
 */
export class CronRunStore {
  constructor(private db: Database.Database) {}

  start(meta: { cronName: string; workflow: string; source: "schedule" | "manual"; actor: string | null }): string {
    const id = randomUUID();
    this.db
      .prepare(
        `INSERT INTO cron_runs (id, cron_name, workflow, source, actor, started_at, status)
         VALUES (?, ?, ?, ?, ?, ?, 'running')`,
      )
      .run(id, meta.cronName, meta.workflow, meta.source, meta.actor, new Date().toISOString());
    return id;
  }

  finish(
    id: string,
    result: {
      status: "ok" | "partial" | "failed";
      reposScanned: number | null;
      discovered: number | null;
      dispatched: number | null;
      failures: number | null;
      error?: string;
    },
  ): void {
    this.db
      .prepare(
        `UPDATE cron_runs
         SET finished_at = ?, status = ?, repos_scanned = ?, discovered = ?, dispatched = ?, failures = ?, error = ?
         WHERE id = ?`,
      )
      .run(
        new Date().toISOString(),
        result.status,
        result.reposScanned,
        result.discovered,
        result.dispatched,
        result.failures,
        result.error ?? null,
        id,
      );
  }

  /** Most recent row per cron name (by started_at). */
  latestByCron(): Map<string, CronRunRecord> {
    const rows = this.db
      .prepare(
        `SELECT cr.* FROM cron_runs cr
         JOIN (SELECT cron_name, MAX(started_at) AS m FROM cron_runs GROUP BY cron_name) latest
           ON cr.cron_name = latest.cron_name AND cr.started_at = latest.m`,
      )
      .all() as Record<string, unknown>[];
    const map = new Map<string, CronRunRecord>();
    for (const row of rows) {
      const rec = this.deserialize(row);
      map.set(rec.cronName, rec);
    }
    return map;
  }

  /** Consecutive non-`ok` *terminal* fires, newest first (running rows ignored). */
  recentFailures(cronName: string): number {
    const rows = this.db
      .prepare(
        `SELECT status FROM cron_runs
         WHERE cron_name = ? AND finished_at IS NOT NULL
         ORDER BY started_at DESC
         LIMIT 10`,
      )
      .all(cronName) as { status: string }[];
    let count = 0;
    for (const row of rows) {
      if (row.status !== "ok") count++;
      else break;
    }
    return count;
  }

  private deserialize(row: Record<string, unknown>): CronRunRecord {
    return {
      id: row.id as string,
      cronName: row.cron_name as string,
      workflow: row.workflow as string,
      source: row.source as CronRunRecord["source"],
      actor: (row.actor as string | null) ?? null,
      startedAt: row.started_at as string,
      finishedAt: (row.finished_at as string | null) ?? null,
      status: row.status as CronRunRecord["status"],
      reposScanned: (row.repos_scanned as number | null) ?? null,
      discovered: (row.discovered as number | null) ?? null,
      dispatched: (row.dispatched as number | null) ?? null,
      failures: (row.failures as number | null) ?? null,
      error: (row.error as string | null) ?? null,
    };
  }
}
```

- [ ] **Step 5: Wire into `StateDb`**

In `apps/server/src/state/db.ts`:
- Add import: `import { CronRunStore } from "./cron-run-store.js";`
- Add re-exports next to the others: `export type { CronRunRecord } from "./cron-run-store.js";` and `export { CronRunStore } from "./cron-run-store.js";`
- Declare the field next to `readonly users`: `\n  /** Owns the \`cron_runs\` ledger — one row per cron fire. */\n  readonly cronRuns: CronRunStore;`
- Construct it in the constructor after `this.users = ...`: `this.cronRuns = new CronRunStore(this.db);`

- [ ] **Step 6: Run test to verify it passes**

Run: `npx vitest run tests/state/cron-run-store.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 7: Commit**

```bash
git add apps/server/src/state/migrate.ts apps/server/src/state/cron-run-store.ts apps/server/src/state/db.ts apps/server/tests/state/cron-run-store.test.ts
git commit -m "feat(state): add cron_runs ledger table + CronRunStore"
```

---

## Task 2: `makeCronRunner` factory (ledger + OTel), extracted from index.ts

**Files:**
- Modify: `apps/server/src/telemetry/index.ts` (add `recordCronFire` helper)
- Create: `apps/server/src/cron/runner.ts` (the factory + a `runFire` helper)
- Test: `apps/server/tests/cron/runner.test.ts`

**Interfaces:**
- Consumes: `CronRunStore` (Task 1); `fanOutContexts` / `dispatchCronWorkflow` / `CronDispatcher` (`./fanout.js`); `DependencyPr` (`./dependabot-discovery.js`); `withSpan` (`../telemetry/index.js`).
- Produces:
  - `type CronDiscoverer = (repos: string[], gh: GitHubClient, opts: { log?: (m: string) => void }) => Promise<DependencyPr[]>`
  - `interface CronRunnerDeps { db: StateDb; github: GitHubClient | null; discoverers: Record<string, CronDiscoverer>; dispatch: CronDispatcher; log?: (m: string) => void; }`
  - `function makeCronRunner(deps: CronRunnerDeps): WorkflowRunner`
  - telemetry: `function recordCronFire(attrs?: TelemetryAttributes): void`

- [ ] **Step 1: Write the failing test**

Create `apps/server/tests/cron/runner.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { StateDb } from "#src/state/db.js";
import { makeCronRunner, type CronDiscoverer } from "#src/cron/runner.js";
import type { GitHubClient } from "#src/engine/github/github.js";

const fakeGh = {} as unknown as GitHubClient;

describe("makeCronRunner", () => {
  let db: StateDb;
  beforeEach(() => { db = new StateDb(":memory:"); });
  afterEach(() => { db.close(); });

  it("records an ok row with discovered:0 dispatched:0 for an empty discovery", async () => {
    const discoverers: Record<string, CronDiscoverer> = { "green-dependency-prs": async () => [] };
    const dispatch = vi.fn(async () => ({ success: true }));
    const runner = makeCronRunner({ db, github: fakeGh, discoverers, dispatch });
    await runner("dependabot-pr-merge", {
      discover: "green-dependency-prs",
      repos: ["o/a", "o/b"],
      _cronName: "merge-green-dependency-prs",
    });
    const row = db.cronRuns.latestByCron().get("merge-green-dependency-prs")!;
    expect(row.status).toBe("ok");
    expect(row.reposScanned).toBe(2);
    expect(row.discovered).toBe(0);
    expect(row.dispatched).toBe(0);
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("records a partial row when a dispatch fails", async () => {
    const discoverers: Record<string, CronDiscoverer> = {
      "green-dependency-prs": async () => [
        { repo: "o/a", prNumber: 1, title: "bump a" },
        { repo: "o/b", prNumber: 2, title: "bump b" },
      ],
    };
    const dispatch = vi
      .fn()
      .mockResolvedValueOnce({ success: true })
      .mockResolvedValueOnce({ success: false, error: "boom" });
    const runner = makeCronRunner({ db, github: fakeGh, discoverers, dispatch });
    await runner("dependabot-pr-merge", { discover: "green-dependency-prs", repos: ["o/a"], _cronName: "c" });
    const row = db.cronRuns.latestByCron().get("c")!;
    expect(row.status).toBe("partial");
    expect(row.discovered).toBe(2);
    expect(row.dispatched).toBe(2);
    expect(row.failures).toBe(1);
  });

  it("records a failed row (and rethrows) when discovery throws", async () => {
    const discoverers: Record<string, CronDiscoverer> = {
      "green-dependency-prs": async () => { throw new Error("gh down"); },
    };
    const runner = makeCronRunner({ db, github: fakeGh, discoverers, dispatch: vi.fn() });
    await expect(
      runner("dependabot-pr-merge", { discover: "green-dependency-prs", repos: ["o/a"], _cronName: "c" }),
    ).rejects.toThrow("gh down");
    const row = db.cronRuns.latestByCron().get("c")!;
    expect(row.status).toBe("failed");
    expect(row.error).toContain("gh down");
    expect(row.finishedAt).not.toBeNull();
  });

  it("non-discovery cron: fans out per repo, discovered stays null, source/actor recorded", async () => {
    const dispatch = vi.fn(async () => ({ success: true }));
    const runner = makeCronRunner({ db, github: fakeGh, discoverers: {}, dispatch });
    await runner("repo-health", {
      repos: ["o/a", "o/b"],
      _cronName: "repo-health-cron",
      _cronSource: "manual",
      _cronActor: "robinbowes",
    });
    const row = db.cronRuns.latestByCron().get("repo-health-cron")!;
    expect(row.status).toBe("ok");
    expect(row.discovered).toBeNull();
    expect(row.reposScanned).toBe(2);
    expect(row.dispatched).toBe(2);
    expect(row.source).toBe("manual");
    expect(row.actor).toBe("robinbowes");
    // _cron* markers are stripped from the dispatched per-repo contexts
    const ctx = dispatch.mock.calls[0][1] as Record<string, unknown>;
    expect(ctx._cronName).toBeUndefined();
    expect(ctx._cronSource).toBeUndefined();
    expect(ctx.repo).toBe("o/a");
  });

  it("empty discovery still occurs when github is null (discovered:0, ok)", async () => {
    const runner = makeCronRunner({
      db, github: null,
      discoverers: { "green-dependency-prs": async () => [{ repo: "o/a", prNumber: 1, title: "x" }] },
      dispatch: vi.fn(),
    });
    await runner("dependabot-pr-merge", { discover: "green-dependency-prs", repos: ["o/a"], _cronName: "c" });
    const row = db.cronRuns.latestByCron().get("c")!;
    expect(row.status).toBe("ok");
    expect(row.discovered).toBe(0); // github null → discoverer not called → 0
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/cron/runner.test.ts`
Expected: FAIL — `#src/cron/runner.js` has no export `makeCronRunner`.

- [ ] **Step 3: Add the `recordCronFire` telemetry helper**

In `apps/server/src/telemetry/index.ts`, after `recordWorkflowRunStart` (around line 238), add:

```ts
export function recordCronFire(attrs: TelemetryAttributes = {}): void {
  if (enabled) meter().createCounter("lastlight.cron.fire").add(1, safeMetricAttributes({ ...attrs, surface: "cron" }));
}
```

- [ ] **Step 4: Create the factory**

Create `apps/server/src/cron/runner.ts`:

```ts
import type { StateDb } from "../state/db.js";
import type { GitHubClient } from "../engine/github/github.js";
import type { WorkflowRunner } from "./scheduler.js";
import { fanOutContexts, dispatchCronWorkflow, type CronDispatcher } from "./fanout.js";
import type { DependencyPr } from "./dependabot-discovery.js";
import { withSpan, recordCronFire } from "../telemetry/index.js";

export type CronDiscoverer = (
  repos: string[],
  gh: GitHubClient,
  opts: { log?: (m: string) => void },
) => Promise<DependencyPr[]>;

export interface CronRunnerDeps {
  db: StateDb;
  github: GitHubClient | null;
  discoverers: Record<string, CronDiscoverer>;
  dispatch: CronDispatcher;
  log?: (m: string) => void;
}

interface FireOutcome {
  reposScanned: number | null;
  discovered: number | null;
  dispatched: number;
  failures: number;
}

const CRON_MARKERS = ["_cronName", "_cronSource", "_cronActor"] as const;

/**
 * The cron work loop, wrapped so every fire — scheduled or manual — writes one
 * `cron_runs` row (start → finish, with a derived status) and emits an OTel
 * `lastlight.cron.fire` span + counter. Both paths funnel through here, so this
 * is the single observability choke point. Returns a {@link WorkflowRunner}
 * (unchanged `Promise<void>` signature); it *writes* the outcome rather than
 * returning it.
 */
export function makeCronRunner(deps: CronRunnerDeps): WorkflowRunner {
  const { db, github, discoverers, dispatch } = deps;
  const log = deps.log ?? ((m: string) => console.log(m));

  return async (workflowName, context) => {
    const cronName = typeof context._cronName === "string" ? context._cronName : workflowName;
    const source = context._cronSource === "manual" ? "manual" : "schedule";
    const actor = typeof context._cronActor === "string" ? context._cronActor : null;

    const id = db.cronRuns.start({ cronName, workflow: workflowName, source, actor });
    // One fire → one span (→ Tempo), one counter increment (→ Prometheus), and
    // one logfmt completion line (→ Loki via the cluster's stdout log agent).
    // Everything lives inside the withSpan callback so `cron.status` lands on the
    // span for ALL outcomes (ok/partial/failed); withSpan adds the ERROR status
    // code + recorded exception on throw, then rethrows for the caller.
    await withSpan(
      "lastlight.cron.fire",
      { "cron.name": cronName, "cron.workflow": workflowName, "cron.source": source },
      async (span) => {
        try {
          const o = await runFire(workflowName, context, { github, discoverers, dispatch, log });
          const status = o.failures > 0 ? "partial" : "ok";
          span?.setAttribute("cron.repos_scanned", o.reposScanned ?? 0);
          if (o.discovered !== null) span?.setAttribute("cron.discovered", o.discovered);
          span?.setAttribute("cron.dispatched", o.dispatched);
          span?.setAttribute("cron.failures", o.failures);
          span?.setAttribute("cron.status", status);
          db.cronRuns.finish(id, { status, ...o });
          recordCronFire({ "cron.name": cronName, "cron.status": status });
          // logfmt key=value pairs so Loki's `| logfmt` parses the fields; the
          // `[cron]` prefix keeps grep parity with the other cron log lines.
          const line =
            `[cron] cron=${cronName} workflow=${workflowName} source=${source} status=${status} ` +
            `scanned=${o.reposScanned ?? 0} discovered=${o.discovered ?? "-"} ` +
            `dispatched=${o.dispatched} failures=${o.failures}`;
          if (status === "ok") console.log(line);
          else console.warn(line);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          span?.setAttribute("cron.status", "failed");
          db.cronRuns.finish(id, {
            status: "failed", reposScanned: null, discovered: null, dispatched: 0, failures: 0, error: message,
          });
          recordCronFire({ "cron.name": cronName, "cron.status": "failed" });
          console.error(
            `[cron] cron=${cronName} workflow=${workflowName} source=${source} status=failed error=${JSON.stringify(message)}`,
          );
          throw err; // withSpan records the exception + sets span status ERROR, then rethrows
        }
      },
    );
  };
}

/** Strip a plain object of the internal `_cron*` markers (never leak downstream). */
function stripCronMarkers(context: Record<string, unknown>): Record<string, unknown> {
  const clean: Record<string, unknown> = { ...context };
  for (const k of CRON_MARKERS) delete clean[k];
  return clean;
}

/** Run the discovery/fan-out body and report the counts. Extracted for the span wrap. */
async function runFire(
  workflowName: string,
  context: Record<string, unknown>,
  deps: { github: GitHubClient | null; discoverers: Record<string, CronDiscoverer>; dispatch: CronDispatcher; log: (m: string) => void },
): Promise<FireOutcome> {
  const { github, discoverers, dispatch, log } = deps;
  const discoverKey = typeof context.discover === "string" ? context.discover : undefined;
  const discoverer = discoverKey ? discoverers[discoverKey] : undefined;

  if (discoverer) {
    const repos = Array.isArray(context.repos)
      ? (context.repos as unknown[]).filter((r): r is string => typeof r === "string")
      : [];
    const prs = github ? await discoverer(repos, github, { log }) : [];
    log(`[cron] ${workflowName}: ${prs.length} ${discoverKey} across ${repos.length} repo(s)`);
    const contexts = prs.map((pr) => ({
      _triggerType: "cron",
      repo: pr.repo,
      prNumber: pr.prNumber,
      title: pr.title,
      ...(pr.branch ? { branch: pr.branch } : {}),
      ...(pr.reason ? { reason: pr.reason } : {}),
    }));
    const { dispatched, failures } = await fanOutContexts(workflowName, contexts, dispatch);
    return { reposScanned: repos.length, discovered: prs.length, dispatched, failures };
  }

  const reposScanned = Array.isArray(context.repos)
    ? (context.repos as unknown[]).filter((r) => typeof r === "string" && r.length > 0).length
    : null;
  const { dispatched, failures } = await dispatchCronWorkflow(
    workflowName,
    stripCronMarkers(context),
    dispatch,
  );
  return { reposScanned, discovered: null, dispatched, failures };
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run tests/cron/runner.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 6: Commit**

```bash
git add apps/server/src/telemetry/index.ts apps/server/src/cron/runner.ts apps/server/tests/cron/runner.test.ts
git commit -m "feat(cron): record every cron fire to the ledger + OTel span/counter + logfmt line via makeCronRunner"
```

---

## Task 3: Integrate the factory + thread cron-name/source/actor

**Files:**
- Modify: `apps/server/src/index.ts` (replace the inline `cronRunner` closure with `makeCronRunner(...)`)
- Modify: `apps/server/src/cron/jobs.ts` (add `_cronName` + `_cronSource: "schedule"` to each job context)
- Modify: `apps/server/src/admin/routes.ts` (trigger endpoint stamps `_cronName` + `_cronSource: "manual"` + `_cronActor`)
- Test: `apps/server/tests/admin/routes.test.ts` (extend the existing `POST /crons/:name/trigger` test)

**Interfaces:**
- Consumes: `makeCronRunner`, `CronDiscoverer` (Task 2); `PR_DISCOVERERS` + `dispatchWorkflow` (already in `index.ts`).
- Produces: cron contexts now carry `_cronName` (always), `_cronSource` (`schedule`|`manual`), `_cronActor` (manual only).

- [ ] **Step 1: Write the failing test (extend the trigger test)**

In `apps/server/tests/admin/routes.test.ts`, inside `describe("POST /crons/:name/trigger", …)`, add:

```ts
it("stamps _cronName, _cronSource=manual, and _cronActor on the fired context", async () => {
  const triggerCron = vi.fn(async () => {});
  const app = new Hono();
  createAdminRoutes(app, makeConfig({ adminPassword: "", triggerCron }));
  const res = await request(app, "/crons/test-cron/trigger", { method: "POST" });
  expect(res.status).toBe(200);
  const [, context] = triggerCron.mock.calls[0] as [string, Record<string, unknown>];
  expect(context._cronName).toBe("test-cron");
  expect(context._cronSource).toBe("manual");
  expect("_cronActor" in context).toBe(true); // null without auth, but present
});
```

(Follow the file's existing `makeConfig` / `request` helpers — mirror the adjacent trigger tests at `tests/admin/routes.test.ts:1765`.)

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/admin/routes.test.ts -t "stamps _cronName"`
Expected: FAIL — context has no `_cronName`.

- [ ] **Step 3: Stamp markers in the trigger endpoint**

In `apps/server/src/admin/routes.ts`, in the `app.post("/crons/:name/trigger", …)` handler, change the context construction from:

```ts
const context = { repos: getManagedRepos(), sender: actorFromContext(c), ...def.context };
```

to:

```ts
const actor = actorFromContext(c);
const context = {
  repos: getManagedRepos(),
  sender: actor,
  _cronName: name,
  _cronSource: "manual",
  _cronActor: actor ?? null,
  ...def.context,
};
```

- [ ] **Step 4: Stamp `_cronName`/`_cronSource` on scheduled jobs**

In `apps/server/src/cron/jobs.ts`, change the pushed job's `context` from:

```ts
context: { repos: getAccessibleManagedRepos(), ...def.context },
```

to:

```ts
context: { repos: getAccessibleManagedRepos(), _cronName: def.name, _cronSource: "schedule", ...def.context },
```

- [ ] **Step 5: Replace the inline cronRunner with the factory**

In `apps/server/src/index.ts`, replace the entire `const cronRunner: WorkflowRunner = async (workflowName, context) => { … };` block (the one ending just before `const cron = new CronScheduler(db, cronRunner);`) with:

```ts
const cronRunner: WorkflowRunner = makeCronRunner({
  db,
  github,
  discoverers: PR_DISCOVERERS,
  dispatch: dispatchWorkflow,
});
```

Add the import near the other cron imports: `import { makeCronRunner } from "./cron/runner.js";`. Remove the now-unused `fanOutContexts` / `dispatchCronWorkflow` imports from `index.ts` **only if** no other code in the file uses them (grep first: `rg -n "fanOutContexts|dispatchCronWorkflow" src/index.ts`). Ensure `PR_DISCOVERERS`'s value type is assignable to `Record<string, CronDiscoverer>` (it already matches: `(repos, gh, opts) => Promise<DependencyPr[]>`).

- [ ] **Step 6: Run tests + typecheck**

Run: `npx vitest run tests/admin/routes.test.ts tests/cron/` (from `apps/server`)
Expected: PASS.
Run: `pnpm --filter lastlight-core typecheck`
Expected: no errors (and no unused-import complaints from the removed imports).

- [ ] **Step 7: Commit**

```bash
git add apps/server/src/index.ts apps/server/src/cron/jobs.ts apps/server/src/admin/routes.ts apps/server/tests/admin/routes.test.ts
git commit -m "feat(cron): wire makeCronRunner + thread cron-name/source/actor through both fire paths"
```

---

## Task 4: Surface cron-run counts on the dashboard

**Files:**
- Modify: `apps/server/src/admin/routes.ts` (`GET /crons` reads from `db.cronRuns`, adds count fields)
- Modify: `apps/server/dashboard/src/api.ts` (extend `CronInfo`)
- Modify: `apps/server/dashboard/src/components/CronsList.tsx` (render counts)
- Test: `apps/server/tests/admin/routes.test.ts` (add a `GET /crons` ledger-fields test)

**Interfaces:**
- Consumes: `db.cronRuns.latestByCron()` / `recentFailures()` (Task 1).
- Produces: `CronInfo` gains `discovered: number | null`, `dispatched: number | null`, `reposScanned: number | null`; `GET /crons` returns them and sources `lastRun`/`lastStatus`/`recentFailures` from `cron_runs`.

- [ ] **Step 1: Write the failing test**

In `apps/server/tests/admin/routes.test.ts`, add a `describe("GET /crons", …)` (or extend an existing crons block). Seed a cron-run row via the test's `StateDb` (the test harness constructs one — reuse it; mirror how other tests obtain `db`) and assert:

```ts
it("derives lastRun/lastStatus/discovered from the cron_runs ledger", async () => {
  // `db` here is the same StateDb the AdminConfig is built from (see makeConfig).
  const id = db.cronRuns.start({ cronName: "test-cron", workflow: "repo-health", source: "schedule", actor: null });
  db.cronRuns.finish(id, { status: "ok", reposScanned: 14, discovered: 0, dispatched: 0, failures: 0 });
  const app = new Hono();
  createAdminRoutes(app, makeConfig({ adminPassword: "" }));
  const res = await request(app, "/crons");
  expect(res.status).toBe(200);
  const body = await res.json() as { crons: Array<Record<string, unknown>> };
  const row = body.crons.find((c) => c.name === "test-cron")!;
  expect(row.lastStatus).toBe("ok");
  expect(row.discovered).toBe(0);
  expect(row.reposScanned).toBe(14);
  expect(row.lastRun).not.toBeNull();
});
```

If the existing harness does not already expose the `StateDb` to the test body, follow the pattern the other `db.*`-seeding tests in this file use to get a handle (the file constructs a `StateDb` for the config — reuse that reference).

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/admin/routes.test.ts -t "cron_runs ledger"`
Expected: FAIL — `discovered`/`reposScanned` absent; `lastStatus` still sourced from workflow_runs (null).

- [ ] **Step 3: Rewire `GET /crons`**

In `apps/server/src/admin/routes.ts`, in `app.get("/crons", …)`, replace the per-def derivation of `recentFailures` / `recent` / `lastRun` / `lastStatus` with cron-ledger reads. Before the `defs.map(...)`, add:

```ts
const latestCronRuns = db.cronRuns.latestByCron();
```

Then inside the map, replace:

```ts
const recentFailures = db.executions.consecutiveFailures(def.workflow);
const recent = db.runs.listRecent(50).find((r) => r.workflowName === def.workflow);
```

and the returned `lastRun` / `lastStatus` fields, with:

```ts
const lastCronRun = latestCronRuns.get(def.name) ?? null;
const recentFailures = db.cronRuns.recentFailures(def.name);
```

and in the returned object:

```ts
lastRun: lastCronRun?.startedAt ?? null,
lastStatus: lastCronRun?.status ?? null,
recentFailures,
discovered: lastCronRun?.discovered ?? null,
dispatched: lastCronRun?.dispatched ?? null,
reposScanned: lastCronRun?.reposScanned ?? null,
```

(Remove the now-unused `recent` variable.)

- [ ] **Step 4: Extend `CronInfo`**

In `apps/server/dashboard/src/api.ts`, add to the `CronInfo` interface:

```ts
  discovered: number | null;
  dispatched: number | null;
  reposScanned: number | null;
```

- [ ] **Step 5: Render the counts**

In `apps/server/dashboard/src/components/CronsList.tsx`, in the "Last run" `<td>` (the cell rendering `formatRel(cron.lastRun)` + the status badge), add below the existing button a compact counts line shown when a fire has been recorded:

```tsx
{cron.reposScanned !== null && (
  <div className="text-2xs text-base-content/40">
    scanned {cron.reposScanned}
    {cron.discovered !== null && ` · found ${cron.discovered}`}
    {cron.dispatched !== null && ` · dispatched ${cron.dispatched}`}
  </div>
)}
```

- [ ] **Step 6: Run tests + dashboard typecheck**

Run: `npx vitest run tests/admin/routes.test.ts` (from `apps/server`)
Expected: PASS.
Run: `pnpm --filter @lastlight/dashboard typecheck`
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add apps/server/src/admin/routes.ts apps/server/dashboard/src/api.ts apps/server/dashboard/src/components/CronsList.tsx apps/server/tests/admin/routes.test.ts
git commit -m "feat(dashboard): surface cron-run status + discovered/dispatched counts from the ledger"
```

---

## Task 5: Full gate + docs

**Files:**
- Modify (maybe): `apps/server/CLAUDE.md` — one line noting the `cron_runs` table under the State directory / DB section (only if the DB tables are enumerated there).

- [ ] **Step 1: Run the full CI gate**

Run (from repo root): `pnpm turbo run typecheck test build`
Expected: all green. Fix anything red before proceeding.

- [ ] **Step 2: Note the new table in the dev guide (if tables are listed)**

`rg -n "workflow_approvals|cron_overrides" apps/server/CLAUDE.md`. If the DB tables are enumerated there (e.g. the `state/db.ts` / State directory section), add `cron_runs` to the list with a one-line description ("one row per cron fire — scheduled or manual"). If they are not enumerated, skip.

- [ ] **Step 3: Commit (if docs changed)**

```bash
git add apps/server/CLAUDE.md
git commit -m "docs: note cron_runs table in the dev guide"
```

---

## Self-review notes (author)

- **Spec coverage:** table (Task 1) · CronRunStore + start/finish/latest/recentFailures (Task 1) · choke-point write with status semantics (Task 2) · source/actor + cronName plumbing (Task 3) · dashboard rewiring + counts (Task 4) · OTel span (with `cron.status` on ALL outcomes) + counter (Task 2, `recordCronFire` + `withSpan`) · logfmt completion line → Loki (Task 2) · non-goals respected (no unified log, no `WorkflowRunner` signature change, no downstream span parentage, no history view, no synchronous toast, no OTLP logs signal).
- **Three-signal routing (Robin's LGTM stack):** span `lastlight.cron.fire` → Tempo; counter `lastlight.cron.fire` → Prometheus; logfmt line → Loki (via stdout log agent, not OTLP). All keyed by `cron.name`/`cron.status` for cross-signal correlation. `cron.status` is set on the span for `ok`/`partial`/`failed` (failed also carries span status ERROR + recorded exception via `withSpan`).
- **Status derivation** is identical everywhere: threw → `failed`; `failures > 0` → `partial`; else `ok`. `finish()` only accepts terminal statuses; `start()` writes `running`.
- **Type consistency:** `CronRunStore.finish` result shape matches `FireOutcome` spread (`reposScanned`/`discovered`/`dispatched`/`failures`) + `status` + optional `error`; `makeCronRunner` spreads `...outcome` into `finish`. `CronDiscoverer` matches `PR_DISCOVERERS`'s value type.
- **Edges covered:** empty discovery (`ok`, 0/0), github null (discoverer skipped → discovered 0), dispatch failure (`partial`), discovery throw (`failed` + rethrow, so the scheduler's existing `catch` still logs), non-discovery cron (`discovered` null), running-row exclusion from `recentFailures`, `_cron*` markers stripped from dispatched contexts.
