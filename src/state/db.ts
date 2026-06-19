import Database from "better-sqlite3";
import { resolve } from "path";
import { migrate } from "./migrate.js";
import { ExecutionStore } from "./execution-store.js";
import { ApprovalStore } from "./approval-store.js";
import { WorkflowRunStore } from "./workflow-run-store.js";

// Re-export the types that moved out to the per-table stores so existing
// import sites (`import { WorkflowRun } from "../state/db.js"`, etc.) keep
// working unchanged. The carve-out (issue #97) splits the implementation
// across three stores but preserves db.ts as the single import surface for
// the shared vocabulary.
export type { ExecutionRecord } from "./execution-store.js";
export type { WorkflowApproval } from "./approval-store.js";
export type { WorkflowRun, PhaseHistoryEntry, PhaseMarker } from "./workflow-run-store.js";
export { ExecutionStore } from "./execution-store.js";
export { ApprovalStore } from "./approval-store.js";
export { WorkflowRunStore } from "./workflow-run-store.js";

const DEFAULT_DB_PATH = "lastlight.db";

export interface CronOverride {
  name: string;
  enabled: boolean;
  /** Cron expression overriding the YAML default; null means use the YAML value. */
  schedule: string | null;
  updatedAt: string;
  updatedBy: string | null;
}

/**
 * Per-workflow kill switch persisted to SQLite. When `enabled` is false,
 * `runSimpleWorkflow` short-circuits and does not create a `workflow_runs`
 * row — applies to every trigger source (cron, webhooks, mentions, Slack).
 * No row at all means "enabled" (default).
 */
export interface WorkflowOverride {
  name: string;
  enabled: boolean;
  updatedAt: string;
  updatedBy: string | null;
}

/**
 * Lightweight SQLite state for operational tracking.
 * NOT for conversation history — only execution logs and rate limits.
 *
 * Construction root for the three per-table stores (issue #97): it opens the
 * single `Database` connection, runs {@link migrate}, and builds
 * {@link ExecutionStore} / {@link ApprovalStore} / {@link WorkflowRunStore} on
 * top of it (all sharing the one connection so better-sqlite3 transactions
 * span every store). Callers reach the stores via `db.runs` / `db.approvals` /
 * `db.executions`. StateDb itself retains only the cross-cutting cron-override
 * and workflow kill-switch concerns.
 */
export class StateDb {
  private db: Database.Database;

  /** Owns the `executions` ledger. */
  readonly executions: ExecutionStore;
  /** Owns the `workflow_approvals` table. */
  readonly approvals: ApprovalStore;
  /** Aggregate root for `workflow_runs` + the atomic lifecycle operations. */
  readonly runs: WorkflowRunStore;

  constructor(dbPath?: string) {
    // ":memory:" stays a real per-connection in-memory DB (used by tests for
    // isolation) — only filesystem paths go through resolve(). Previously
    // resolve(":memory:") produced a shared on-disk file named ":memory:",
    // which let parallel test files contend on one DB and deadlock once the
    // stores started holding write transactions.
    const target = dbPath === ":memory:" ? ":memory:" : resolve(dbPath || DEFAULT_DB_PATH);
    this.db = new Database(target);
    this.db.pragma("journal_mode = WAL");
    migrate(this.db);

    this.executions = new ExecutionStore(this.db);
    this.approvals = new ApprovalStore(this.db);
    this.runs = new WorkflowRunStore(this.db, { approvals: this.approvals });
  }

  // ── Cron overrides ─────────────────────────────────────────────

  /** Get the override row for a single cron, or null if none. */
  getCronOverride(name: string): CronOverride | null {
    const row = this.db
      .prepare(`SELECT name, enabled, schedule, updated_at, updated_by FROM cron_overrides WHERE name = ?`)
      .get(name) as Record<string, unknown> | undefined;
    return row ? this.deserializeCronOverride(row) : null;
  }

  /** All override rows keyed by cron name. */
  getAllCronOverrides(): Map<string, CronOverride> {
    const rows = this.db
      .prepare(`SELECT name, enabled, schedule, updated_at, updated_by FROM cron_overrides`)
      .all() as Record<string, unknown>[];
    const map = new Map<string, CronOverride>();
    for (const row of rows) {
      const o = this.deserializeCronOverride(row);
      map.set(o.name, o);
    }
    return map;
  }

  /**
   * Upsert an override. Pass only the fields you want to change — undefined
   * fields preserve the existing value (or default to enabled=1, schedule=null
   * on insert).
   */
  setCronOverride(
    name: string,
    patch: { enabled?: boolean; schedule?: string | null; updatedBy?: string },
  ): void {
    const now = new Date().toISOString();
    const existing = this.getCronOverride(name);
    const enabled = patch.enabled ?? existing?.enabled ?? true;
    const schedule = patch.schedule === undefined ? existing?.schedule ?? null : patch.schedule;
    this.db
      .prepare(
        `INSERT INTO cron_overrides (name, enabled, schedule, updated_at, updated_by)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(name) DO UPDATE SET
           enabled = excluded.enabled,
           schedule = excluded.schedule,
           updated_at = excluded.updated_at,
           updated_by = excluded.updated_by`,
      )
      .run(name, enabled ? 1 : 0, schedule, now, patch.updatedBy ?? null);
  }

  /** Remove the override entirely (revert to YAML defaults). */
  clearCronOverride(name: string): void {
    this.db.prepare(`DELETE FROM cron_overrides WHERE name = ?`).run(name);
  }

  private deserializeCronOverride(row: Record<string, unknown>): CronOverride {
    return {
      name: row.name as string,
      enabled: (row.enabled as number) === 1,
      schedule: (row.schedule as string | null) ?? null,
      updatedAt: row.updated_at as string,
      updatedBy: (row.updated_by as string | null) ?? null,
    };
  }

  // ── Workflow overrides (kill switch) ───────────────────────────

  /**
   * Cheap check used by every dispatch path. Returns true unless an explicit
   * `workflow_overrides` row says otherwise.
   */
  isWorkflowEnabled(name: string): boolean {
    const row = this.db
      .prepare(`SELECT enabled FROM workflow_overrides WHERE name = ?`)
      .get(name) as { enabled: number } | undefined;
    if (!row) return true;
    return row.enabled === 1;
  }

  getWorkflowOverride(name: string): WorkflowOverride | null {
    const row = this.db
      .prepare(`SELECT name, enabled, updated_at, updated_by FROM workflow_overrides WHERE name = ?`)
      .get(name) as Record<string, unknown> | undefined;
    return row ? this.deserializeWorkflowOverride(row) : null;
  }

  getAllWorkflowOverrides(): Map<string, WorkflowOverride> {
    const rows = this.db
      .prepare(`SELECT name, enabled, updated_at, updated_by FROM workflow_overrides`)
      .all() as Record<string, unknown>[];
    const map = new Map<string, WorkflowOverride>();
    for (const row of rows) {
      const o = this.deserializeWorkflowOverride(row);
      map.set(o.name, o);
    }
    return map;
  }

  setWorkflowEnabled(name: string, enabled: boolean, updatedBy?: string): void {
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO workflow_overrides (name, enabled, updated_at, updated_by)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(name) DO UPDATE SET
           enabled = excluded.enabled,
           updated_at = excluded.updated_at,
           updated_by = excluded.updated_by`,
      )
      .run(name, enabled ? 1 : 0, now, updatedBy ?? null);
  }

  private deserializeWorkflowOverride(row: Record<string, unknown>): WorkflowOverride {
    return {
      name: row.name as string,
      enabled: (row.enabled as number) === 1,
      updatedAt: row.updated_at as string,
      updatedBy: (row.updated_by as string | null) ?? null,
    };
  }

  /** Expose the underlying Database instance (for SessionManager, etc.) */
  get database(): Database.Database {
    return this.db;
  }

  close(): void {
    this.db.close();
  }
}
