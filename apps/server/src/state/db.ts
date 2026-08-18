import { createClient } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { migrate } from "drizzle-orm/libsql/migrator";
import { eq } from "drizzle-orm";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import * as sqliteSchema from "./schema/sqlite.js";
import { applyLegacySqliteCompat } from "./legacy-sqlite.js";
import {
  makeOpSerializer,
  tablesOf,
  type Dialect,
  type StateClient,
  type StateTables,
} from "./client.js";
import { ExecutionStore } from "./execution-store.js";
import { CronRunStore } from "./cron-run-store.js";
import { ApprovalStore } from "./approval-store.js";
import { WorkflowRunStore } from "./workflow-run-store.js";
import { UserStore } from "./user-store.js";
import { TeamStore } from "./team-store.js";
import { FeedbackStore } from "./feedback-store.js";

// Re-export the types that moved out to the per-table stores so existing
// import sites (`import { WorkflowRun } from "../state/db.js"`, etc.) keep
// working unchanged. The carve-out (issue #97) splits the implementation
// across three stores but preserves db.ts as the single import surface for
// the shared vocabulary.
export type { ExecutionRecord } from "./execution-store.js";
export type { WorkflowApproval } from "./approval-store.js";
export type { WorkflowRun, PhaseHistoryEntry, PhaseMarker } from "./workflow-run-store.js";
export type { User, TriggerActorType } from "./user-store.js";
export type { CronRunRecord, CronRunSource, CronRunStatus } from "./cron-run-store.js";
export type {
  ResolvedTeam,
  CachedVisibility,
  VisibilitySync,
  VisibilitySyncStatus,
} from "./team-store.js";
export type {
  FeedbackAnchor,
  FeedbackAnchorInput,
  FeedbackAnchorKind,
  FeedbackSignal,
  FeedbackSummaryRow,
  FeedbackDailyRow,
  FeedbackListOptions,
} from "./feedback-store.js";
export { ExecutionStore } from "./execution-store.js";
export { ApprovalStore } from "./approval-store.js";
export { WorkflowRunStore } from "./workflow-run-store.js";
export { UserStore, TRIGGER_ACTOR_TYPES, isTriggerActorType } from "./user-store.js";
export { TeamStore } from "./team-store.js";
export { FeedbackStore } from "./feedback-store.js";
export { CronRunStore } from "./cron-run-store.js";

const DEFAULT_DB_PATH = "lastlight.db";

/**
 * The generated migrations live at the `apps/server/` package root, so this
 * must resolve from BOTH `src/state/` (tsx dev) and `dist/state/` (compiled).
 */
const MIGRATIONS_DIR = fileURLToPath(new URL("../../drizzle/sqlite", import.meta.url));

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
 * Construction root for the seven per-table stores (issue #97): it opens the
 * single Drizzle client, runs the compat pre-step + migrations, and builds the
 * stores on top of it (all sharing the one client so transactions span every
 * store). Callers reach the stores via `db.runs` / `db.approvals` /
 * `db.executions` / …. StateDb itself retains only the cross-cutting
 * cron-override and workflow kill-switch concerns.
 *
 * Construction is async — the driver is — so it is a static factory rather
 * than a constructor: {@link StateDb.open} for production, {@link
 * StateDb.fromClient} to adopt an existing Drizzle instance.
 */
export class StateDb {
  /** Owns the `executions` ledger. */
  readonly executions: ExecutionStore;
  /** Owns the `workflow_approvals` table. */
  readonly approvals: ApprovalStore;
  /** Aggregate root for `workflow_runs` + the atomic lifecycle operations. */
  readonly runs: WorkflowRunStore;
  /** First-class user identity — populated on dashboard login (issue #205). */
  readonly users: UserStore;
  /**
   * GitHub team → managed-repo visibility cache (issue #169). Populated lazily,
   * per logged-in user — see {@link TeamStore} for why it is a cache and not a
   * mirror of the org.
   */
  readonly teams: TeamStore;
  /** Reaction-derived eval signals + the anchors they hang on (issue #255). */
  readonly feedback: FeedbackStore;
  /**
   * One row per cron FIRE (issues #341/#327). The only record a zero-discovery
   * backstop fire leaves — it dispatches nothing, so it writes no
   * `workflow_runs` and no `executions` row.
   */
  readonly cronRuns: CronRunStore;

  /**
   * Table objects for THIS client's dialect. Every method destructures what it
   * needs off this instead of importing from `schema/sqlite.js` — see
   * `client.ts` → {@link tablesOf} for why the cast alone cannot do it.
   */
  private readonly t: StateTables;

  private constructor(
    private readonly _client: StateClient,
    private readonly _dialect: Dialect,
    private readonly closer?: () => void,
  ) {
    this.t = tablesOf(_client);

    // ONE serializer per CONNECTION, handed to every store that opens a
    // transaction. A per-store chain would leave WorkflowRunStore's five named
    // ops racing TeamStore's four on this same client — see makeOpSerializer.
    const serialize = makeOpSerializer();

    this.executions = new ExecutionStore(_client);
    this.approvals = new ApprovalStore(_client);
    this.runs = new WorkflowRunStore(_client, { approvals: this.approvals, serialize });
    this.users = new UserStore(_client);
    this.teams = new TeamStore(_client, { serialize });
    this.feedback = new FeedbackStore(_client);
    this.cronRuns = new CronRunStore(_client);
  }

  /**
   * Production entry: open (or create) the SQLite database, apply the legacy
   * compat pre-step, then run migrations.
   *
   * Normalizes every accepted form HERE so no caller ever builds a `file:` URL:
   * `:memory:` passes through, `file:` URLs pass through, and anything else is
   * treated as a filesystem path.
   *
   * **`:memory:` is only safe for a caller that never opens a transaction.**
   * The libsql client lazily opens a NEW connection after every
   * `client.transaction()`, and for `:memory:` a new connection is a new, EMPTY
   * database — so the first committed transaction silently discards the schema
   * and every subsequent query fails with `no such table`. Verified on
   * @libsql/client 0.17. Nothing in production uses `:memory:`; a test that
   * touches `WorkflowRunStore`'s named ops or any `TeamStore` write must use a
   * temp FILE instead.
   */
  static async open(pathOrUrl?: string): Promise<StateDb> {
    const input = pathOrUrl || DEFAULT_DB_PATH;
    // Case-insensitive: URL schemes are, and `POSTGRES://…` reaching the libsql
    // client produces an opaque ConnectionFailed instead of this message.
    if (/^postgres(ql)?:\/\//i.test(input)) {
      throw new Error(
        `PG runtime not enabled: StateDb.open() cannot open "${input}". ` +
          `The Postgres dialect is test-only for now — construct it with StateDb.fromClient().`,
      );
    }
    const url =
      input === ":memory:" || input.startsWith("file:") ? input : `file:${resolve(input)}`;
    const raw = createClient({ url });
    await raw.execute("PRAGMA journal_mode = WAL");
    // Best-effort only: this pragma is connection-scoped and the libsql client
    // opens a fresh connection after every transaction, so it covers just the
    // pre-first-transaction window. The op serializer is the real defense.
    await raw.execute("PRAGMA busy_timeout = 5000");
    await applyLegacySqliteCompat(raw);
    const client = drizzle(raw, { schema: sqliteSchema });
    await migrate(client, { migrationsFolder: MIGRATIONS_DIR });
    return new StateDb(client, "sqlite", () => raw.close());
  }

  /**
   * Test / Phase-4 entry: adopt an existing Drizzle instance. Runs no
   * migrations — the caller owns the schema.
   */
  static fromClient(
    client: StateClient,
    dialect: Dialect,
    opts?: { close?: () => void },
  ): StateDb {
    return new StateDb(client, dialect, opts?.close);
  }

  get client(): StateClient {
    return this._client;
  }

  get dialect(): Dialect {
    return this._dialect;
  }

  // ── Cron overrides ─────────────────────────────────────────────

  /** Get the override row for a single cron, or null if none. */
  async getCronOverride(name: string): Promise<CronOverride | null> {
    const { cronOverrides } = this.t;
    const [row] = await this._client
      .select()
      .from(cronOverrides)
      .where(eq(cronOverrides.name, name))
      .limit(1);
    return row ? { ...row, schedule: row.schedule ?? null, updatedBy: row.updatedBy ?? null } : null;
  }

  /** All override rows keyed by cron name. */
  async getAllCronOverrides(): Promise<Map<string, CronOverride>> {
    const { cronOverrides } = this.t;
    const rows = await this._client.select().from(cronOverrides);
    const map = new Map<string, CronOverride>();
    for (const row of rows) {
      map.set(row.name, {
        ...row,
        schedule: row.schedule ?? null,
        updatedBy: row.updatedBy ?? null,
      });
    }
    return map;
  }

  /**
   * Upsert an override. Pass only the fields you want to change — undefined
   * fields preserve the existing value (or default to enabled=1, schedule=null
   * on insert).
   */
  async setCronOverride(
    name: string,
    patch: { enabled?: boolean; schedule?: string | null; updatedBy?: string },
  ): Promise<void> {
    const { cronOverrides } = this.t;
    const now = new Date().toISOString();
    const existing = await this.getCronOverride(name);
    const enabled = patch.enabled ?? existing?.enabled ?? true;
    const schedule = patch.schedule === undefined ? (existing?.schedule ?? null) : patch.schedule;
    const values = { name, enabled, schedule, updatedAt: now, updatedBy: patch.updatedBy ?? null };
    await this._client
      .insert(cronOverrides)
      .values(values)
      .onConflictDoUpdate({
        target: cronOverrides.name,
        set: {
          enabled: values.enabled,
          schedule: values.schedule,
          updatedAt: values.updatedAt,
          updatedBy: values.updatedBy,
        },
      });
  }

  /** Remove the override entirely (revert to YAML defaults). */
  async clearCronOverride(name: string): Promise<void> {
    const { cronOverrides } = this.t;
    await this._client.delete(cronOverrides).where(eq(cronOverrides.name, name));
  }

  // ── Workflow overrides (kill switch) ───────────────────────────

  /**
   * Cheap check used by every dispatch path. Returns true unless an explicit
   * `workflow_overrides` row says otherwise.
   */
  async isWorkflowEnabled(name: string): Promise<boolean> {
    const { workflowOverrides } = this.t;
    const [row] = await this._client
      .select({ enabled: workflowOverrides.enabled })
      .from(workflowOverrides)
      .where(eq(workflowOverrides.name, name))
      .limit(1);
    return row ? row.enabled : true;
  }

  async getWorkflowOverride(name: string): Promise<WorkflowOverride | null> {
    const { workflowOverrides } = this.t;
    const [row] = await this._client
      .select()
      .from(workflowOverrides)
      .where(eq(workflowOverrides.name, name))
      .limit(1);
    return row ? { ...row, updatedBy: row.updatedBy ?? null } : null;
  }

  async getAllWorkflowOverrides(): Promise<Map<string, WorkflowOverride>> {
    const { workflowOverrides } = this.t;
    const rows = await this._client.select().from(workflowOverrides);
    const map = new Map<string, WorkflowOverride>();
    for (const row of rows) map.set(row.name, { ...row, updatedBy: row.updatedBy ?? null });
    return map;
  }

  async setWorkflowEnabled(name: string, enabled: boolean, updatedBy?: string): Promise<void> {
    const { workflowOverrides } = this.t;
    const now = new Date().toISOString();
    await this._client
      .insert(workflowOverrides)
      .values({ name, enabled, updatedAt: now, updatedBy: updatedBy ?? null })
      .onConflictDoUpdate({
        target: workflowOverrides.name,
        set: { enabled, updatedAt: now, updatedBy: updatedBy ?? null },
      });
  }

  /**
   * Async by contract: libsql's `close()` is synchronous today, but a Postgres
   * pool's is not, and every caller already awaits this.
   */
  async close(): Promise<void> {
    this.closer?.();
  }
}
