import type Database from "better-sqlite3";
import { randomUUID } from "crypto";

/** How a fire was started. */
export type CronRunSource = "schedule" | "manual";

/**
 * `running` while in flight; then `ok` (including a legitimate no-op),
 * `partial` (ran, but one or more dispatches failed), or `failed` (threw
 * before completing).
 */
export type CronRunStatus = "running" | "ok" | "partial" | "failed";

export interface CronRunRecord {
  id: string;
  cronName: string;
  /** The dispatched workflow. Null for a `handler:` cron. */
  workflow: string | null;
  /** The host-side handler. Null for a `workflow:` cron. */
  handler: string | null;
  source: CronRunSource;
  /** Who pressed "Run now". Null for a scheduled fire. */
  actor: string | null;
  startedAt: string;
  finishedAt: string | null;
  status: CronRunStatus;
  /** Managed repos the tick considered, BEFORE per-repo participation. */
  reposEligible: number | null;
  /** Repos that actually participated, AFTER narrowing (issue #180). */
  reposScanned: number | null;
  /** PRs a discovery cron found. Null for a non-discovery cron. */
  discovered: number | null;
  dispatched: number | null;
  failures: number | null;
  error: string | null;
}

export interface CronRunStart {
  cronName: string;
  workflow?: string | null;
  handler?: string | null;
  source: CronRunSource;
  actor: string | null;
}

export interface CronRunFinish {
  status: Exclude<CronRunStatus, "running">;
  reposEligible?: number | null;
  reposScanned?: number | null;
  discovered?: number | null;
  dispatched?: number | null;
  failures?: number | null;
  error?: string;
}

/**
 * Owns the `cron_runs` ledger — one row per cron FIRE, scheduled or manual,
 * for `workflow:` and `handler:` crons alike.
 *
 * Peer of {@link ExecutionStore}, constructed on the shared connection. Two
 * properties are load-bearing:
 *
 * 1. **A no-op fire still writes a row.** A cron whose discovery finds nothing
 *    dispatches nothing, so it creates no `workflow_runs` and no `executions`
 *    row. This ledger is then the ONLY evidence it ran — which is the whole
 *    reason it exists (issue #341).
 * 2. **Rows are keyed on the CRON name, never the workflow.** The same workflow
 *    is reachable from `/api/run`, a GitHub comment and a Slack message; keyed
 *    on the workflow, a hand-triggered failure would inflate the cron's health
 *    and vice versa (issue #327).
 */
export class CronRunStore {
  constructor(private db: Database.Database) {}

  /** Insert a `running` row and return its id. */
  start(meta: CronRunStart): string {
    const id = randomUUID();
    this.db
      .prepare(
        `INSERT INTO cron_runs (id, cron_name, workflow, handler, source, actor, started_at, status)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'running')`,
      )
      .run(
        id,
        meta.cronName,
        meta.workflow ?? null,
        meta.handler ?? null,
        meta.source,
        meta.actor,
        new Date().toISOString(),
      );
    return id;
  }

  /** Stamp `finished_at` and the terminal fields. */
  finish(id: string, result: CronRunFinish): void {
    this.db
      .prepare(
        `UPDATE cron_runs
         SET finished_at = ?, status = ?, repos_eligible = ?, repos_scanned = ?,
             discovered = ?, dispatched = ?, failures = ?, error = ?
         WHERE id = ?`,
      )
      .run(
        new Date().toISOString(),
        result.status,
        result.reposEligible ?? null,
        result.reposScanned ?? null,
        result.discovered ?? null,
        result.dispatched ?? null,
        result.failures ?? null,
        result.error ?? null,
        id,
      );
  }

  /** Most recent row per cron name — what the dashboard's crons list reads. */
  latestByCron(): Map<string, CronRunRecord> {
    const rows = this.db
      .prepare(
        `SELECT * FROM (
           SELECT *, ROW_NUMBER() OVER (
             PARTITION BY cron_name ORDER BY started_at DESC, rowid DESC
           ) AS rn
           FROM cron_runs
         ) WHERE rn = 1`,
      )
      .all() as Record<string, unknown>[];

    const map = new Map<string, CronRunRecord>();
    for (const row of rows) {
      const record = mapCronRunRow(row);
      map.set(record.cronName, record);
    }
    return map;
  }

  /**
   * Consecutive non-`ok` TERMINAL fires, newest first.
   *
   * A `running` row is skipped rather than counted or treated as a stop: a fire
   * in flight is not yet a failure, and must not mask the terminal row beneath
   * it. Mirrors `ExecutionStore.consecutiveFailures` in shape so the
   * scheduler's call site changes key and table but not logic.
   *
   * `rowid DESC` breaks ties on `started_at`. Real crons fire minutes apart so
   * ties never arise in production, but without it "newest first" degrades to
   * SQLite's insertion order — i.e. OLDEST first — and the count walks the
   * sequence backwards, reporting 0 for a cron that has failed every time.
   */
  recentFailures(cronName: string): number {
    const rows = this.db
      .prepare(
        `SELECT status FROM cron_runs
         WHERE cron_name = ? AND finished_at IS NOT NULL
         ORDER BY started_at DESC, rowid DESC
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
}

function mapCronRunRow(row: Record<string, unknown>): CronRunRecord {
  return {
    id: row.id as string,
    cronName: row.cron_name as string,
    workflow: (row.workflow as string | null) ?? null,
    handler: (row.handler as string | null) ?? null,
    source: row.source as CronRunSource,
    actor: (row.actor as string | null) ?? null,
    startedAt: row.started_at as string,
    finishedAt: (row.finished_at as string | null) ?? null,
    status: row.status as CronRunStatus,
    reposEligible: (row.repos_eligible as number | null) ?? null,
    reposScanned: (row.repos_scanned as number | null) ?? null,
    discovered: (row.discovered as number | null) ?? null,
    dispatched: (row.dispatched as number | null) ?? null,
    failures: (row.failures as number | null) ?? null,
    error: (row.error as string | null) ?? null,
  };
}
