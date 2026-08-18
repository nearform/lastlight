import { randomUUID } from "crypto";
import { and, desc, eq, isNotNull, sql } from "drizzle-orm";
import { tablesOf, type StateClient, type StateTables } from "./client.js";
import { rows } from "./dialect.js";

/**
 * A lexicographically-sortable row id: a fixed-width millisecond stamp, a
 * per-process counter, then a uuid.
 *
 * `started_at` has millisecond resolution, so two fires in the same millisecond
 * tie — and both reads below break that tie on `id`. Under sqlite the tiebreak
 * used to be `rowid`, i.e. INSERTION ORDER, which PostgreSQL has no equivalent
 * of; a plain `randomUUID()` is a total order but an ARBITRARY one, and
 * arbitrary is not good enough here. `recentFailures` walks newest-first until
 * it meets an `ok`, so a tie straddling an `ok` and a `failed` yields a
 * different count depending which way it happened to sort — the failure alert
 * flickering on a cron that is fine, or staying quiet on one that is not. This
 * restores insertion order without a schema change and reads identically in
 * both dialects.
 *
 * Rows written before this existed carry a bare uuid, which sorts differently —
 * harmless, because the tiebreak only ever compares rows from the SAME
 * millisecond and no millisecond spans the deploy that introduced it.
 */
let idSeq = 0;
function creationOrderedId(): string {
  const stamp = Date.now().toString(16).padStart(12, "0");
  idSeq = (idSeq + 1) & 0xffffff;
  return `${stamp}-${idSeq.toString(16).padStart(6, "0")}-${randomUUID()}`;
}

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
  /**
   * Table objects for THIS client's dialect. Every method destructures what it
   * needs off this instead of importing from `schema/sqlite.js` — see
   * `client.ts` → {@link tablesOf} for why the cast alone cannot do it.
   */
  private readonly t: StateTables;

  constructor(private client: StateClient) {
    this.t = tablesOf(client);
  }

  /** Insert a `running` row and return its id. */
  async start(meta: CronRunStart): Promise<string> {
    const { cronRuns } = this.t;
    const id = creationOrderedId();
    await this.client.insert(cronRuns).values({
      id,
      cronName: meta.cronName,
      workflow: meta.workflow ?? null,
      handler: meta.handler ?? null,
      source: meta.source,
      actor: meta.actor,
      startedAt: new Date().toISOString(),
      status: "running",
    });
    return id;
  }

  /** Stamp `finished_at` and the terminal fields. */
  async finish(id: string, result: CronRunFinish): Promise<void> {
    const { cronRuns } = this.t;
    await this.client
      .update(cronRuns)
      .set({
        finishedAt: new Date().toISOString(),
        status: result.status,
        reposEligible: result.reposEligible ?? null,
        reposScanned: result.reposScanned ?? null,
        discovered: result.discovered ?? null,
        dispatched: result.dispatched ?? null,
        failures: result.failures ?? null,
        error: result.error ?? null,
      })
      .where(eq(cronRuns.id, id));
  }

  /**
   * Most recent row per cron name — what the dashboard's crons list reads.
   *
   * A window function, so it stays raw SQL. Two portability notes: the derived
   * table carries an explicit alias (Postgres rejects a `FROM` subquery without
   * one), and `rn` is a `ROW_NUMBER()` rank — `rn = 1` is an integer compare,
   * not a boolean. The tiebreak is `id DESC` — a real recency order, because
   * the ids are minted in creation order ({@link creationOrderedId}); picking
   * the wrong row of a tie here would show the dashboard the wrong outcome.
   *
   * `rows()` results are NOT column-mapped, so {@link mapCronRunRow} reads the
   * raw snake_case column names.
   */
  async latestByCron(): Promise<Map<string, CronRunRecord>> {
    const { cronRuns } = this.t;
    const ranked = await rows<Record<string, unknown>>(
      this.client,
      sql`SELECT * FROM (
            SELECT *, ROW_NUMBER() OVER (
              PARTITION BY ${cronRuns.cronName}
              ORDER BY ${cronRuns.startedAt} DESC, ${cronRuns.id} DESC
            ) AS rn
            FROM ${cronRuns}
          ) AS ranked
          WHERE rn = 1`,
    );

    const map = new Map<string, CronRunRecord>();
    for (const row of ranked) {
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
   * `id DESC` breaks ties on `started_at`, and the ids are minted in creation
   * order for exactly that purpose — see {@link creationOrderedId}. A merely
   * DETERMINISTIC tiebreak is not sufficient here, which is the trap: this walk
   * stops at the first `ok`, so a tie holding one `ok` and one `failed` returns
   * a different count depending which sorts first. It has to be the RIGHT
   * order, not just a stable one.
   */
  async recentFailures(cronName: string): Promise<number> {
    const { cronRuns } = this.t;
    const recent = await this.client
      .select({ status: cronRuns.status })
      .from(cronRuns)
      .where(and(eq(cronRuns.cronName, cronName), isNotNull(cronRuns.finishedAt)))
      .orderBy(desc(cronRuns.startedAt), desc(cronRuns.id))
      .limit(10);

    let count = 0;
    for (const row of recent) {
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
