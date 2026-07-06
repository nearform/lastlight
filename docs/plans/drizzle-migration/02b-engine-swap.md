# Phase 2 — Async API flip + engine swap: libsql + Drizzle (combined)

> **Risk: HIGH — this is the crux of the migration.** Everything before this
> phase was preparation; everything after it is consolidation. Read
> [README.md](README.md) (locked decisions, hard constraints) and
> [00-architecture.md](00-architecture.md) end-to-end before starting.
>
> **COMBINED PHASE (locked decision 7, 2026-07-06):** the former Phase 2a
> (async API ripple) and Phase 2b (engine swap) execute as ONE phase, with
> this doc as the driver. [02a-async-api.md](02a-async-api.md) is the ripple
> reference — its method/consumer inventories, signature flips, landmines
> (minus L7/R5, which are moot), fire-and-forget table, floating-promise
> audit, and test tables all apply *within this phase*. There are NO sync
> twins: transaction closures are written directly as async drizzle
> transactions (below). The repo must be green at the END of this phase;
> intermediate commits on the `drizzle-migration` branch (locked decision 6)
> need not be.

## Goal

Delete `better-sqlite3` from `src/`. `StateDb`, the three stores
(`ExecutionStore` / `ApprovalStore` / `WorkflowRunStore`), and
`SessionManager` run on `drizzle-orm/libsql` + `@libsql/client` behind a
fully async API — established in this same phase via the 02a ripple
(combined phase, locked decision 7). Consumers change in two ways at once:
every call site awaits (02a's inventories/landmines) and the construction
sites move to `await StateDb.open(...)` / `new SessionManager(db.client,
db.dialect)`. No store method signature changes beyond `async` + the
additive trailing transaction parameter described below.

Also in scope, because they fall out of the swap:

- The five named atomic ops become real async transactions
  (`client.transaction(async (tx) => …)`) with the `changes() !== 1 → throw`
  compare-and-set guards preserved.
- `SessionManager` stops being a second schema owner: its DDL moved to the
  Phase 1 baseline; its legacy `UNIQUE(platform,…)` rebuild moves to
  `src/state/legacy-sqlite.ts`.
- `src/state/migrate.ts` is **deleted** (DDL now lives in
  `drizzle/sqlite/0000_baseline.sql` + `legacy-sqlite.ts`).
- The `/admin/api/executions` wire format is pinned to snake_case
  (Drizzle-mapped rows are camelCase; the dashboard contract is snake_case).
- Two known bugs get fixed (do NOT preserve them — README "Known bugs"):
  the dispatcher's undefined `r.startedAt`/`r.issueNumber`
  (`src/engine/dispatcher.ts:111`) and `consecutiveFailures`' `=== 0` check
  (`src/state/execution-store.ts:465`).

## Preconditions

- [ ] **Phase 1 done**: `src/state/schema/sqlite.ts` exists (7 tables, all
  indexes, `{mode:'json'}` / `{mode:'boolean'}` columns),
  `drizzle/sqlite/0000_baseline.sql` is idempotent, and
  `tests/state/schema-equivalence.test.ts` is green (legacy `migrate()` DDL
  ≡ Drizzle migrator output).
- [ ] ~~**Phase 2a done**~~ **In-scope instead (combined phase)**: the async
  ripple is executed as part of this phase, using
  [02a-async-api.md](02a-async-api.md) as the map — every method of
  `StateDb`, the three stores, and `SessionManager` becomes `async`; all
  ~15 consumer files and ~10 test files `await` them (02a's inventories,
  landmines L1–L6/L8/L9, fire-and-forget table, floating-promise audit).
  Suggested order: rewrite the state layer on drizzle first (this doc), then
  chase the compiler outward through the consumers (02a's tables).
- [ ] Read Phase 1's committed `src/state/schema/sqlite.ts` and note which
  columns it made json-mode and boolean-mode — the porting tables below
  assume: **json** = `workflow_runs.phase_history` / `context` / `scratch`
  plus `executions.extension_status` / `skills_status` (Phase 1's audited
  decision, honoring locked decision 4 — real JSON columns);
  **boolean** = `executions.success`, `cron_overrides.enabled`,
  `workflow_overrides.enabled`, `messaging_sessions.active`.
  `workflow_approvals.artifact` is a filename, not JSON — plain text.
  For the two status columns the stores never parse/stringify today — the
  JSON boundary sits in the callers — so this phase moves that boundary
  into the schema: drop the stringify at
  `src/workflows/phase-executor.ts:339-340` (pass the objects through),
  change `ExecutionRecord.extensionStatus`/`skillsStatus` to their object
  types (`ExtensionStatusMap` / `SkillsStatus` from
  `src/engine/github/profiles.ts`), and replace `parseJsonColumn(...)` at
  `src/admin/routes.ts:927-928` (helper at `routes.ts:124`) with a
  pass-through. Where the porting tables below say the status columns
  "stay strings", apply this conversion instead. (If Phase 1 deviated and
  shipped them as plain text, keep the caller-side boundary unchanged.)

## Scope guards (what this phase does NOT do)

- No Postgres anything — no `schema/pg.ts`, no PGlite, no `postgres://`
  handling in `StateDb.open` (Phase 4). `client.ts`'s `asStateClient()` is
  defined now but first *used* in Phase 4.
- No config slot / Dockerfile / packaging changes (Phase 5). `DB_PATH` /
  `STATE_DIR` resolution (`src/config/config.ts:355`) is untouched — `open()`
  keeps taking a filesystem path, not a URL.
- No evals-barrel shape changes: `src/evals-api.ts` exports no DB types and
  `runWorkflow`'s `db?: StateDb` is type-erased — verified; keep it so.
- The long-running sandbox dispatch stays **outside** transactions (callers
  already dispatch after the atomic op returns — keep that ordering).

---

## New files

### `src/state/client.ts` — the client seam

Adapted from finius `src/server/db/client.ts` (the pg-cast technique), but
with construction-time injection instead of module-load env selection.
Full load-bearing content:

```ts
// The Drizzle client seam. Store code is written ONCE, typed against the
// sqlite Drizzle instance (the production path). A Postgres instance (Phase 4,
// PGlite in tests) is adapted through the asStateClient() cast — sound because
// the query-builder surface the stores use (select/insert/update/delete/
// transaction) is structurally identical across drivers; the two genuinely
// divergent surfaces (raw sql execution, rows-affected shape) are funneled
// through rows()/changes() in dialect.ts.
import type { LibSQLDatabase } from "drizzle-orm/libsql";
import * as sqliteSchema from "./schema/sqlite.js";

/** Runtime discriminator carried by StateDb; branches nothing in 2b. */
export type Dialect = "sqlite" | "postgres";

export type StateClient = LibSQLDatabase<typeof sqliteSchema>;

/** The transaction handle client.transaction() passes to its callback. */
export type StateTx = Parameters<Parameters<StateClient["transaction"]>[0]>[0];

/** Anything a store method can run queries against (root client or enclosing tx). */
export type StateDbc = StateClient | StateTx;

/**
 * The ONE documented cast that lets a non-libsql Drizzle instance (PGlite in
 * Phase 4 tests) drive the sqlite-typed stores. Do not add a second cast site.
 */
export function asStateClient(db: unknown): StateClient {
  return db as StateClient;
}
```

### `src/state/dialect.ts` — the portability seam

Adapted from finius `src/server/db/raw.ts` (feature-detected helpers — do
not copy its `node:sqlite` sync branches) and `dialect.ts` (keep the seam
minimal: only constructs that actually diverge). Full content:

```ts
// Portability seam: raw-SQL execution and result shapes are the only two
// surfaces that differ between drizzle-orm/libsql and a future pg driver.
// Everything else the stores do goes through the shared query-builder API.
//
// IMPORTANT: rows() results are NOT column-mapped by Drizzle — no
// boolean/json conversion, no camelCase renaming. Raw queries must alias
// columns themselves and treat booleans as 0/1 integers. Only builder
// queries (client.select()...) return mapped rows.
import { sql, type SQL, type SQLWrapper } from "drizzle-orm";
import type { StateDbc } from "./client.js";

type RawCapable = {
  all?: (q: SQL) => Promise<unknown>;
  run?: (q: SQL) => Promise<unknown>;
  execute?: (q: SQL) => Promise<unknown>;
};

/** Run a raw query, return all rows. libsql: .all(sql). pg: .execute(sql) → {rows}. */
export async function rows<T = Record<string, unknown>>(dbc: StateDbc, query: SQL): Promise<T[]> {
  const d = dbc as unknown as RawCapable;
  if (typeof d.all === "function") return (await d.all(query)) as T[];
  const res = (await d.execute!(query)) as { rows?: T[] } | T[];
  return (Array.isArray(res) ? res : res.rows ?? []) as T[];
}

/** Run a raw statement for its side effect; returns the driver result (feed to changes()). */
export async function run(dbc: StateDbc, query: SQL): Promise<unknown> {
  const d = dbc as unknown as RawCapable;
  if (typeof d.run === "function") return d.run(query);
  return d.execute!(query);
}

/**
 * Rows-affected from an awaited builder mutation (or run()). libsql
 * ResultSet: .rowsAffected. pg QueryResult: .rowCount. PGlite: .affectedRows.
 * Replaces every better-sqlite3 `result.changes` read — the compare-and-set
 * guards depend on this being exact.
 */
export function changes(result: unknown): number {
  const r = result as {
    rowsAffected?: number; rowCount?: number | null;
    affectedRows?: number; changes?: number | bigint;
  } | null;
  return Number(r?.rowsAffected ?? r?.rowCount ?? r?.affectedRows ?? r?.changes ?? 0);
}

/** UNIQUE violation detection across drivers (pg SQLSTATE 23505 on the cause chain, sqlite message). */
export function isUniqueViolation(error: unknown): boolean {
  for (let e: unknown = error, depth = 0; e != null && depth < 6;
       e = (e as { cause?: unknown }).cause, depth++) {
    if ((e as { code?: string }).code === "23505") return true;
    if (e instanceof Error && /UNIQUE|unique constraint/i.test(e.message)) return true;
  }
  return false;
}

/** Escape %, _ and \ for a LIKE … ESCAPE '\' pattern (port of execution-store.ts:499). */
export function likeEscape(input: string): string {
  return input.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}

/** UTC day bucket over an ISO-8601 text column: replaces date(col). Identical keys in both dialects. */
export function dayBucket(col: SQLWrapper): SQL {
  return sql`substr(${col}, 1, 10)`;
}

/** UTC hour bucket (YYYY-MM-DDTHH): replaces strftime('%Y-%m-%dT%H', col). */
export function hourBucket(col: SQLWrapper): SQL {
  return sql`substr(${col}, 1, 13)`;
}
```

`isUniqueViolation`'s first call site is `getOrCreateSession`'s race guard
(locked decision 11 — see the SessionManager table); the rest are all used
below.

### `src/state/legacy-sqlite.ts` — pre-migrator compat pre-step

Runs **before** the Drizzle migrator on every boot; sqlite-only; idempotent.
Operates on the **raw `@libsql/client` `Client`** (drizzle isn't constructed
yet). Two jobs:

**1. `PRAGMA table_info`-guarded `ADD COLUMN`s** — for operators upgrading
from versions older than the current column set, where the baseline's
`CREATE TABLE IF NOT EXISTS` would no-op without adding their missing
columns. Guard by column presence, **not** try/catch (libsql errors are
async and we don't want to swallow real failures). The exact historical
column set, enumerated from `src/state/migrate.ts:92-169`:

```ts
import type { Client } from "@libsql/client";

const LEGACY_COLUMNS: Record<string, string[]> = {
  workflow_runs: [
    "scratch TEXT",                                    // migrate.ts:93
    "restart_count INTEGER NOT NULL DEFAULT 0",        // migrate.ts:102
  ],
  workflow_approvals: [
    "kind TEXT NOT NULL DEFAULT 'approve'",            // migrate.ts:111
    "artifact TEXT",                                   // migrate.ts:120
  ],
  executions: [
    "session_id TEXT",                                 // migrate.ts:128
    "cost_usd REAL",                                   // migrate.ts:137-162 (loop)
    "input_tokens INTEGER",
    "cache_creation_input_tokens INTEGER",
    "cache_read_input_tokens INTEGER",
    "output_tokens INTEGER",
    "api_duration_ms INTEGER",
    "stop_reason TEXT",
    "workflow_run_id TEXT",
    "output_text TEXT",
    "extension_status TEXT",
    "skills_status TEXT",
  ],
};

async function tableColumns(client: Client, table: string): Promise<Set<string>> {
  const res = await client.execute(`PRAGMA table_info(${table})`);
  return new Set(res.rows.map((r) => String(r.name)));
}

export async function applyLegacySqliteCompat(client: Client): Promise<void> {
  for (const [table, defs] of Object.entries(LEGACY_COLUMNS)) {
    const cols = await tableColumns(client, table);
    if (cols.size === 0) continue; // table absent — baseline creates it complete
    for (const def of defs) {
      const name = def.split(" ")[0];
      if (!cols.has(name)) {
        await client.execute(`ALTER TABLE ${table} ADD COLUMN ${def}`);
      }
    }
  }
  await rebuildMessagingIfLegacyUnique(client);
}
```

(The `idx_executions_workflow_run` index from `migrate.ts:170-176` needs no
compat step — the baseline's `CREATE INDEX IF NOT EXISTS` handles it.)

**2. The messaging `UNIQUE(platform,…)` table rebuild**, ported verbatim in
spirit from `src/connectors/messaging/session-manager.ts:89-133` (SQLite's
official table-rebuild recipe: `foreign_keys` OFF outside the transaction,
copy → drop → rename, `foreign_key_check` **before** COMMIT, restore the
pragma). Mark it `// TODO(remove after v0.11)` — it exists for exactly one
more release.

```ts
// TODO(remove after v0.11): one-shot rebuild for pre-partial-unique-index DBs.
async function rebuildMessagingIfLegacyUnique(client: Client): Promise<void> {
  const master = await client.execute(
    `SELECT sql FROM sqlite_master WHERE type='table' AND name='messaging_sessions'`,
  );
  const tableSql = String(master.rows[0]?.sql ?? "");
  if (!tableSql.includes("UNIQUE(platform")) return;

  console.log("[state] legacy compat: rebuilding messaging_sessions without table-level UNIQUE");
  const fkRow = await client.execute("PRAGMA foreign_keys");
  const fkWasOn = Number(fkRow.rows[0]?.foreign_keys ?? 0) === 1;
  await client.execute("PRAGMA foreign_keys = OFF");
  try {
    await client.execute("BEGIN");
    try {
      await client.executeMultiple(`
        CREATE TABLE messaging_sessions__new (
          id TEXT PRIMARY KEY, platform TEXT NOT NULL, channel_id TEXT NOT NULL,
          thread_id TEXT, user_id TEXT NOT NULL, agent_session_id TEXT,
          created_at TEXT NOT NULL, last_activity_at TEXT NOT NULL,
          message_count INTEGER DEFAULT 0, active INTEGER DEFAULT 1
        );
        INSERT INTO messaging_sessions__new
          SELECT id, platform, channel_id, thread_id, user_id, agent_session_id,
                 created_at, last_activity_at, message_count, active
          FROM messaging_sessions;
        DROP TABLE messaging_sessions;
        ALTER TABLE messaging_sessions__new RENAME TO messaging_sessions;
        CREATE INDEX IF NOT EXISTS idx_msg_sessions_lookup
          ON messaging_sessions(platform, channel_id, thread_id, user_id);
      `);
      const violations = await client.execute("PRAGMA foreign_key_check");
      if (violations.rows.length > 0) {
        throw new Error(`FK check failed after messaging rebuild: ${JSON.stringify(violations.rows)}`);
      }
      await client.execute("COMMIT");
    } catch (err) {
      await client.execute("ROLLBACK").catch(() => {});
      throw err;
    }
  } finally {
    if (fkWasOn) await client.execute("PRAGMA foreign_keys = ON");
  }
}
```

If `executeMultiple` refuses to run inside the explicit `BEGIN` on the local
file client (watch-item — it shouldn't, statements share the one
connection), fall back to individual `client.execute()` calls per statement.

---

## `src/state/db.ts` rewrite

Keep the re-export block (`db.ts:13-18`) exactly as is — `db.ts` stays the
single import surface for `ExecutionRecord` / `WorkflowApproval` /
`WorkflowRun` / the store classes. The class becomes an async factory:

```ts
import { createClient, type Client } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { migrate } from "drizzle-orm/libsql/migrator";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import * as sqliteSchema from "./schema/sqlite.js";
import { applyLegacySqliteCompat } from "./legacy-sqlite.js";
import type { StateClient, Dialect } from "./client.js";

// Resolves from BOTH src/state/ and dist/state/ to the repo-root drizzle/sqlite.
const MIGRATIONS_DIR = fileURLToPath(new URL("../../drizzle/sqlite", import.meta.url));

export class StateDb {
  readonly executions: ExecutionStore;
  readonly approvals: ApprovalStore;
  readonly runs: WorkflowRunStore;

  private constructor(
    private readonly _client: StateClient,
    private readonly _dialect: Dialect,
    private readonly closer?: () => void,
  ) {
    this.executions = new ExecutionStore(_client);
    this.approvals = new ApprovalStore(_client);
    this.runs = new WorkflowRunStore(_client, { approvals: this.approvals });
  }

  /**
   * Production entry: open (or create) the sqlite DB, run compat + migrations.
   * Accepts BOTH forms (locked decision 9) — normalization lives HERE, never
   * in callers:
   *   ":memory:"          → as-is (per-connection in-memory; test isolation —
   *                         preserve the rationale from db.ts:66-72)
   *   "file:..."          → as-is
   *   "postgres(ql)://…"  → throw "PG runtime not enabled" (added Phase 4)
   *   anything else       → filesystem path: `file:${resolve(path)}`
   */
  static async open(pathOrUrl?: string): Promise<StateDb> {
    const input = pathOrUrl || DEFAULT_DB_PATH;
    const url =
      input === ":memory:" || input.startsWith("file:")
        ? input
        : `file:${resolve(input)}`;
    const raw = createClient({ url });
    await raw.execute("PRAGMA journal_mode = WAL");
    await raw.execute("PRAGMA busy_timeout = 5000");
    await applyLegacySqliteCompat(raw);
    const client = drizzle(raw, { schema: sqliteSchema });
    await migrate(client, { migrationsFolder: MIGRATIONS_DIR });
    return new StateDb(client, "sqlite", () => raw.close());
  }

  /** Test/Phase-4 entry: adopt an existing Drizzle instance. No migration is run. */
  static fromClient(client: StateClient, dialect: Dialect, opts?: { close?: () => void }): StateDb {
    return new StateDb(client, dialect, opts?.close);
  }

  get client(): StateClient { return this._client; }
  get dialect(): Dialect { return this._dialect; }
  // async by contract (locked decision 9): libsql's close() is sync today,
  // but Phase 3/4 already `await db.close()` and a future PG pool needs it.
  async close(): Promise<void> { this.closer?.(); }
}
```

`get database()` (db.ts:203-205) is **deleted** — the compiler will flag any
straggler. `busy_timeout=5000` is new (the old code set only WAL,
db.ts:74) — it's the first line of defense for the concurrency watch-item.

**Cron/workflow overrides** (StateDb's own methods) port to the builder with
`onConflictDoUpdate`:

| Method (db.ts) | Port |
|---|---|
| `getCronOverride` :85 | builder `select().from(cronOverrides).where(eq(name))` — boolean-mapped; delete `deserializeCronOverride` (`=== 1` at :139 gone) |
| `getAllCronOverrides` :93 | builder select-all → `Map` |
| `setCronOverride` :110 | keep the read-then-patch semantics (:115-117), then `insert(...).values(...).onConflictDoUpdate({ target: cronOverrides.name, set: {...} })` |
| `clearCronOverride` :132 | builder `delete().where(eq(name))` |
| `isWorkflowEnabled` :152 | builder select `{ enabled }`; `row ? row.enabled : true` (boolean, no `=== 1`) |
| `getWorkflowOverride` / `getAllWorkflowOverrides` :160/:167 | builder; delete `deserializeWorkflowOverride` |
| `setWorkflowEnabled` :179 | `onConflictDoUpdate` upsert |

## Transaction plumbing

Every method that participates in a cross-store atomic op gains a
**trailing** `dbc: StateDbc = this.client` parameter (`StateDbc` from
`client.ts`) so it runs against either the root client or an enclosing
transaction. Additive with a default — no consumer changes. The full list:

- `WorkflowRunStore.appendPhase`, `mergeScratch`, `setPaused`, `setRunning`,
  `flipFinished` (private), `getRun`
- `ApprovalStore.create`, `respond`, `resolveReplyGate`, `getById`

The **five named atomic ops** become libsql async transactions. Pattern
(replaces `this.db.transaction(() => {...})()` at
`workflow-run-store.ts:409/433/451/470` and the conditional at :292):

```ts
async pauseForApproval(runId, approval, marker, scratchPatch?): Promise<void> {
  await this.client.transaction(async (tx) => {
    await this.appendPhase(runId, marker.phase, {…}, tx);
    if (scratchPatch) await this.mergeScratch(runId, scratchPatch, tx);
    await this.approvals.create(approval, tx);
    await this.setPaused(runId, tx);
  });
}
```

- `resolveGateAndResume` / `resolveGateAndFail`
  (workflow-run-store.ts:432-461): inside the tx — `getById(id, tx)`;
  `changes(await respond(..., tx)) !== 1` → **throw** (the throw inside the
  async callback rolls the transaction back — this IS the double-responder
  guard, preserved exactly); `setRunning`/`flipFinished` with `tx`; return
  `getRun(..., tx)`.
- `resolveReplyGateAndResume` (:463-479): `resolveReplyGate(..., tx)`
  count-guard → `mergeScratch(tx)` → `setRunning(tx)` → `getRun(tx)`.
- `finishRun` (:275-296): wraps in a transaction when `terminalMarker` is
  set **or when `error` is set** — new: `flipFinished`'s `json_patch` SQL
  (:301-305) becomes an app-side read-modify-write on the json-mode
  `context` column (read `context` object, `{ ...(ctx ?? {}), error }`,
  update), and the RMW must be atomic. Plain finish (neither) stays a
  single builder update, no transaction.

Dispatch stays outside: callers of these ops already dispatch after the
awaited op returns — do not move any `dispatchWorkflow` call inside a
transaction callback.

---

## Per-store porting tables

Rule of thumb (from the plan): **GROUP BY / correlated subquery / CASE /
LIKE-ESCAPE stays a `` sql`…` `` template** referencing schema columns
(`${executions.startedAt}`) executed through `rows()`/`run()`; **simple CRUD
moves to the query builder**. Raw rows are unmapped (0/1 booleans, aliased
names); builder rows are mapped (booleans, json, camelCase). Builder rows
return `null` for nullable columns — add one small `nullsToUndefined`
normalization where the record types use optionals.

### `ExecutionStore` (`src/state/execution-store.ts`)

| Method (line) | Port | JSON / boolean notes |
|---|---|---|
| `recordStart` :68 | builder insert | |
| `recordSessionId` :89 | builder update | |
| `recordOutputText` :100 | builder update | |
| `getExecutionOutput` :105 | builder select `{ outputText }` | |
| `getPhaseOutput` :118 | builder: `and(eq(skill), scope, isNotNull(outputText))`, `orderBy(desc(finishedAt))`, `limit(1)`; scope = `workflowRunId ? eq(executions.workflowRunId, …) : eq(executions.triggerId, …)` | |
| `recordFinish` :131 | builder update; always-set columns (`finishedAt`, `success`, `error ?? null`, `turns ?? null`, `durationMs ?? null`) plus **conditionally spread** set entries for the nine `COALESCE(?, col)` columns (:159-168) — include a key only when the value is defined; equivalent to the COALESCE and cleaner | `success` passed as boolean |
| `recordSkippedPhase` :199 | builder insert (`success: false`) | |
| `listChatThreads` :234 / `getChatThread` :289 | **sql`` via `rows()`** — GROUP BY + correlated `messaging_messages` subquery + LEFT JOIN. Keep the existing camelCase `AS` aliases (:249-265); reference columns as `${executions.triggerId}` etc. | no booleans in the projection — raw is safe |
| `isRunning` :342 | builder: `and(eq(skill), eq(triggerId), isNull(finishedAt))` limit 1 | |
| `isCompleted` :352 | builder: `eq(executions.success, true)` | boolean |
| `shouldRunPhase` :369 | two builder queries (running / done) with the scope condition | `eq(success, true)` |
| `markStaleAsFailed` :393 | builder update; return `changes(result)` | `success: false` |
| `markAllStaleForTrigger` :411 | builder update; `changes(result)` | |
| `markLatestAsFailed` :427 | **sql`` via `run()`** — `UPDATE … WHERE id = (SELECT id … ORDER BY started_at DESC LIMIT 1)` correlated subquery; return `changes(await run(...))` | `success = 0` literal in raw SQL is fine (sqlite stores boolean as 0/1) — but write `${executions.success} = 0` via the column ref |
| `recentExecutions` :445 / `allExecutions` :472 / `runningExecutions` :603 | builder full-row select — **this fixes the latent snake_case-cast bug** (README "Known bugs"); rows come back as real `ExecutionRecord`s (camelCase, boolean `success`) after `nullsToUndefined` | json/boolean mapped by builder |
| `consecutiveFailures` :455 | builder select `{ success }` desc limit 10; **`row.success === false`** (was `=== 0`, :465) | THE boolean-regression hotspot — pin with a test |
| `searchErrors` :487 | **sql`` via `rows()`** — `LIKE ? ESCAPE '\'` ×3 (builder `like()` has no ESCAPE). Use `likeEscape()` from dialect.ts (delete the inline :499 escape). Keep the aliases (:508-512); raw `success` stays 0/1 → keep the `Boolean(r.success)` mapping at :525 | raw = unmapped |
| `getExecutionsForWorkflowRun` :542 | **sql`` via `rows()`** — `(workflow_run_id = ? OR (workflow_run_id IS NULL AND trigger_id = ?)) AND skill LIKE ?`; keep the explicit aliased column list (:546-568) and the mapping block (:575-599) incl. `Boolean(r.success)` | raw = unmapped — the mapping block must now `JSON.parse` `extension_status`/`skills_status` into their object types (raw sql bypasses the json-mode mapping; `ExecutionRecord` types them as objects per Preconditions) |
| `executionStats` :612 | counts → builder (`select({ c: count() })`); the per-skill CASE rollup (:627-632) and per-trigger GROUP BY (:639-641) → **sql`` via `rows()`** with the portable CASE forms — successes: `SUM(CASE WHEN ${executions.success} THEN 1 ELSE 0 END)` (truthiness works on sqlite 0/1 and pg boolean; NULL falls to ELSE); failures: `SUM(CASE WHEN ${executions.success} = 0 THEN 1 ELSE 0 END)` — do NOT write `WHEN NOT ${col}` for failures, because `NOT NULL` is NULL and still-running rows must fall to ELSE in both dialects (`= 0` compares false in pg via boolean literal comparison — use `${executions.success} = ${false}` if the fragment binds a param) | same CASE forms reused by `dailyStats`/`hourlyStats` |
| `dailyStats` :652 / `hourlyStats` :721 | **sql`` via `rows()`** — replace `date(started_at)` / `strftime('%Y-%m-%dT%H', …)` with `${dayBucket(executions.startedAt)}` / `${hourBucket(executions.startedAt)}` in SELECT, WHERE and GROUP BY. The JS-side bucket-key generation (:673-677, :740-745) already emits matching `YYYY-MM-DD` / `YYYY-MM-DDTHH` keys — unchanged | success CASE as above |

### `ApprovalStore` (`src/state/approval-store.ts`)

| Method (line) | Port | Notes |
|---|---|---|
| `create` :41 | builder insert, `dbc` param | `kind: approval.kind ?? "approve"`, `artifact ?? null` |
| `resolveReplyGate` :77 | builder update `where(and(eq(id), eq(kind,'reply'), eq(status,'pending')))`; return `changes(result)`; `dbc` param | compare-and-set guard |
| `getPendingReplyGateByTrigger` :97 | builder join: `select(getTableColumns(workflowApprovals)).from(wa).innerJoin(wr, eq(wa.workflowRunId, wr.id)).where(and(eq(wr.triggerId,…), eq(wa.status,'pending'), eq(wa.kind,'reply'))).orderBy(desc(wa.createdAt)).limit(1)` | |
| `getById` :111 | builder, `dbc` param | |
| `getPendingForWorkflow` :117 | builder | |
| `getPendingByTrigger` :125 | builder join (same shape as reply-gate variant, without the kind filter) | |
| `listForWorkflow` :142 | builder, `orderBy(asc(createdAt))` | |
| `listPending` :150 | builder | |
| `respond` :165 | builder update `where(and(eq(id), eq(status,'pending')))`; `changes(result)`; `dbc` param | compare-and-set guard |
| `deserialize` :175 | shrink to `nullsToUndefined` + `kind ?? "approve"` — builder rows are already camelCase | no json columns here (`artifact` is a filename) |

### `WorkflowRunStore` (`src/state/workflow-run-store.ts`)

| Method (line) | Port | JSON / boolean notes |
|---|---|---|
| `createRun` :82 | builder insert; pass `context` / `scratch` **objects** directly, `phaseHistory: []` | **drop `JSON.stringify`** (:95-96) — json-mode columns |
| `mergeScratch` :111 | read `{ scratch }` via `dbc`, spread-merge, builder update; `dbc` param | drop parse/stringify (:117-121). The "poison patch throws" rollback semantic survives: Drizzle serializes the json param when executing the UPDATE — a `JSON.stringify` throw aborts the statement (and rolls back an enclosing tx) before any mutation |
| `appendPhase` :134 | read `{ phaseHistory }` (already an array), push, builder update; `dbc` param | drop parse/stringify (:138-142) |
| `getRun` :146 | builder full-row select; `dbc` param | deserialize drops `JSON.parse` ×3 (:358-361) |
| `getByTrigger` :152 | builder `inArray(status, ["running","paused"])` desc limit 1 | |
| `hasRunForTrigger` :168 | builder limit 1 | |
| `listActive` :178 | builder | |
| `listRecent` :186 | builder | |
| `list` :203 | builder with `and(...optional filters)`; count via `select({ c: count() })`; **keep the explicit column selection** (:243-247 — no `context`/`scratch` on dashboard polls); deserialize tolerates their absence (it already does) | `phaseHistory` still selected → arrives as array |
| `distinctNames` :261 | builder `selectDistinct({ workflowName }).orderBy(asc(...))` | |
| `finishRun` :275 | see Transaction plumbing — tx when `terminalMarker` **or** `error` | |
| `flipFinished` :298 | app-side RMW replacing `json_patch` (hotspot table in 00-architecture); `dbc` param | |
| `cancelRun` :309 | builder update | |
| `setPaused` :317 / `setRunning` :325 | builder update; `dbc` param | |
| `incrementRestartCount` :338 | builder update with `sql\`COALESCE(${t.restartCount}, 0) + 1\`` + `.returning({ restartCount })` (sqlite RETURNING — portable to pg) — collapses the update+select pair (:340-347) | |
| `deserialize` :350 | drop `JSON.parse` ×3; keep `restartCount ?? 0`; `nullsToUndefined` | |
| named ops :403-479 | see Transaction plumbing | |

### `SessionManager` (`src/connectors/messaging/session-manager.ts`)

Constructor becomes `constructor(private client: StateClient, private dialect: Dialect = "sqlite")`.
**Delete `migrate()` (:20-70) and `rebuildWithoutTableUnique()` (:89-133)**
— DDL (both tables, both indexes, the partial unique index :65-69) is in the
Phase 1 baseline; the rebuild moved to `legacy-sqlite.ts`.

| Method (line) | Port | Notes |
|---|---|---|
| `getSession` :136 | builder | `rowToSession` shrinks — builder rows are camelCase, `active` already boolean |
| `getOrCreateSession` :142 | builder ×3. **The `thread_id IS ?` null-safe compare (:149, :160) ports as** `key.threadId == null ? isNull(messagingSessions.threadId) : eq(messagingSessions.threadId, key.threadId)` (compute once, use in both the lookup and the deactivate). `active = 1` → `eq(active, true)`; deactivate sets `{ active: false }`. **Race guard (locked decision 11):** lookup-then-insert is no longer atomic-by-physics under async — wrap the insert in try/catch; on `isUniqueViolation(err)` (dialect.ts — its first real call site) re-run the active-session lookup and return the winner; rethrow anything else. Add a test: two concurrent `getOrCreateSession` for the same fresh key resolve to the same session id (goes to the portable factory in Phase 3) | insert supplies the same columns as :166-168; `message_count`/`active` come from DDL defaults |
| `setAgentSessionId` :190 | builder update | |
| `touchSession` :197 | builder update with `messageCount: sql\`${t.messageCount} + 1\`` | |
| `deactivateSession` :206 | builder update `{ active: false }` | |
| `addMessage` :211 | builder insert (never supply `id` — AUTOINCREMENT) | |
| `getHistory` :219 | builder asc + limit | |
| `hasActiveThread` :238 | builder (`threadId` is a non-null string here — plain `eq`) | `eq(active, true)` |
| `cleanupStaleSessions` :250 | delete messages via `inArray(messagingMessages.sessionId, client.select({ id }).from(messagingSessions).where(and(eq(active, false), lt(lastActivityAt, cutoff))))` subquery, then delete sessions; return `changes(result)` | `active = 0` → `eq(active, false)` |

## Construction sites

- **`src/index.ts:142-146`**:

  ```ts
  const db = await StateDb.open(config.dbPath);
  console.log(`[state] Database: ${config.dbPath}`);
  const sessionManager = new SessionManager(db.client, db.dialect);
  ```

  (`main()` is already async.) Also reword the stale better-sqlite3 comment
  at `src/index.ts:403-406` (ProgressNotifier timing rationale) — the
  guarantee it describes now rests on `simple.ts` awaiting `onRunStart`
  before the first reporter call, not on driver synchrony.
- **`src/workflows/simple.ts:320-325` (locked decision 10):** replace the
  fire-and-forget `callbacks.onRunStart(workflowId).catch(…)` with
  `try { await callbacks.onRunStart(workflowId); } catch (err) { log }`
  before dispatching — notifier setup (status comment, checklist seed) must
  complete before the first reporter call now that setup does real I/O.
  `RunnerCallbacks.onRunStart` is already Promise-typed (`runner.ts:57`), so
  no exported-shape change; update 02a's fire-and-forget table entry for
  this site from "unchanged" to "awaited".
- No other production construction sites exist (verified:
  `new StateDb` appears only in index.ts + 2 test files; `new SessionManager`
  in index.ts + 2 test files).

---

## Wire format — dashboard contract

Verified against `dashboard/src/api.ts`:

- **`GET /admin/api/executions`** (`src/admin/routes.ts:787-792`) — the
  dashboard types this **snake_case** with integer success
  (`Execution`, api.ts:38-51: `trigger_type`, `trigger_id`, `issue_number`,
  `started_at`, `finished_at`, `success: number | null`, `duration_ms`).
  Today the route leaks raw `SELECT *` rows; after the swap
  `allExecutions()` returns camelCase `ExecutionRecord`s, so the route MUST
  re-serialize:

  ```ts
  function executionToWire(r: ExecutionRecord) {
    return {
      id: r.id,
      trigger_type: r.triggerType,
      trigger_id: r.triggerId,
      skill: r.skill,
      repo: r.repo ?? null,
      issue_number: r.issueNumber ?? null,
      started_at: r.startedAt,
      finished_at: r.finishedAt ?? null,
      success: r.success === undefined ? null : r.success ? 1 : 0,
      error: r.error ?? null,
      turns: r.turns ?? null,
      duration_ms: r.durationMs ?? null,
      session_id: r.sessionId ?? null,
      workflow_run_id: r.workflowRunId ?? null,
    };
  }
  // routes.ts:790-791 →
  return c.json({ executions: executions.map(executionToWire) });
  ```

- **`GET /workflow-runs` / `/workflow-runs/:id`** (routes.ts:861-897) —
  **already camelCase** and stays camelCase: the dashboard's `WorkflowRun`
  type (api.ts:82-95) is `workflowName` / `triggerId` / `startedAt` /
  `phaseHistory`, matching `WorkflowRunStore.deserialize` output. **No
  change.** (The plan's generic "re-serialize list routes" instruction does
  not apply here — only `/executions` was leaking raw rows.)
- **`GET /workflow-runs/:id/executions`** (routes.ts:902-931) — already maps
  camelCase explicitly. With the status columns json-mode (see
  Preconditions), `extensionStatus`/`skillsStatus` arrive as objects, so
  `parseJsonColumn` at :927-928 becomes a pass-through (keep the helper at
  :124 if other call sites remain; otherwise delete it).
- `/stats`, `/stats/daily`, `/stats/hourly`, `/log-search`, `/approvals*`
  (routes.ts:668-688, 802, 1204-1300) — shapes produced by store methods
  whose output shape is preserved above; no route changes.
- Other `runningExecutions()` consumers (routes.ts:773, :982) read `.skill`
  / `.id` — names identical in both casings; no change.

**Pin test** — new `tests/admin/executions-wire.test.ts` (follow the
fixture pattern of `tests/admin/routes.test.ts`: `new Hono()` +
`createAdminRoutes` + `app.request`, but with a REAL
`await StateDb.open(":memory:")` instead of a fake). Seed one finished
(success), one failed, and one still-running execution via
`recordStart`/`recordFinish`, then `GET /executions` and assert the exact
wire keys and values, notably:

```ts
expect(body.executions[0]).toMatchObject({
  trigger_type: "webhook", trigger_id: "owner/repo#1",
  started_at: expect.any(String), duration_ms: 1234, success: 1,
});
// still-running row:
expect(runningRow.success).toBe(null);
expect(runningRow.finished_at).toBe(null);
// no camelCase leakage:
expect(Object.keys(body.executions[0])).not.toContain("triggerId");
```

## Dispatcher behavior change (bug fix, visible)

`src/engine/dispatcher.ts:106-116` (status-report handler) reads
`r.startedAt` / `r.issueNumber` from `runningExecutions()` rows. Today those
are `undefined` at runtime (raw snake_case rows cast to `ExecutionRecord`),
so `/status` replies render as `• *build:executor* on repo (started
undefined)` with the issue number silently dropped. After the swap the rows
are properly mapped — **no dispatcher code change needed**, but the visible
status text now shows real ISO timestamps and ` #N` issue suffixes. Mention
this in the phase's commit message; if any test snapshot pinned the broken
text, fix the snapshot, not the code.

---

## Test changes

- **Construction**: `new StateDb(":memory:")` → `db = await StateDb.open(":memory:")`
  in `tests/state/db.test.ts:8` and `tests/state/workflow-run-store.test.ts:12`.
  (These are the only two real-StateDb constructions;
  `tests/workflows/runner.test.ts`, `phase-executor.test.ts`,
  `tests/engine/dispatcher.test.ts`, `tests/admin/*.test.ts` use fakes typed
  `as unknown as StateDb` — untouched beyond what 2a already did.)
- **`workflow-run-store.test.ts` rollback test** (:66-109, "injected
  collaborator"): the raw better-sqlite3 + `migrate()` construction becomes
  a second `await StateDb.open(":memory:")` whose `client` is shared:
  `new WorkflowRunStore(inner.client, { approvals: throwingApprovals })`.
  The throwing `ApprovalStore` fake **still works**: `create()` throwing
  inside the async transaction callback rejects the callback promise and
  Drizzle rolls back — assert the run is still `running` with empty
  `phaseHistory`, exactly as today. Delete the `import { migrate }` and
  `import Database` lines.
- **`tests/connectors/messaging/session-manager.test.ts`**:
  - Fresh-path fixture (:17-18): `db = await StateDb.open(":memory:")`;
    `manager = new SessionManager(db.client, "sqlite")`. Direct
    `db.prepare(...)` assertions (e.g. :41-45) become libsql
    `raw.execute(...)` reads or builder queries — simplest is to keep a
    handle on a raw `createClient({ url: ":memory:" })`… which `open()`
    doesn't expose. Instead, do raw reads through
    `rows(db.client, sql\`SELECT …\`)`.
  - **Legacy fixtures** (:54-84 FK-referencing messages; :106-125
    unconditional UNIQUE) rebuild on libsql and now exercise
    `legacy-sqlite.ts` end-to-end:

    ```ts
    const raw = createClient({ url: ":memory:" });
    await raw.executeMultiple(LEGACY_DDL_AND_SEED);        // the existing SQL strings, verbatim
    await applyLegacySqliteCompat(raw);                    // the rebuild under test
    const client = drizzle(raw, { schema: sqliteSchema });
    await migrate(client, { migrationsFolder: MIGRATIONS_DIR }); // baseline no-ops + partial index
    const manager = new SessionManager(client, "sqlite");
    ```

    Assertions unchanged in spirit: messages survive (:88-91), FK still
    enforced (:94-98 — expect the libsql rejection instead of a sync throw),
    old row survives + fresh insert no longer collides (:139-145).
- **`tests/connectors/slack/connector.test.ts:63-64`**: same fresh-path
  fixture (StateDb.open + `db.client`) replacing `new Database(":memory:")`.
- **`tests/state/schema-equivalence.test.ts`** (from Phase 1): the
  better-sqlite3 leg is dropped with the dependency. Freeze the legacy
  `migrate()` DDL as a string fixture (e.g.
  `tests/state/fixtures/legacy-schema.sql` — the literal SQL from the
  now-deleted `src/state/migrate.ts`, CREATE TABLEs with the ALTERed columns
  folded in, matching what Phase 1's test compared). The test becomes:
  execute the fixture on a libsql `:memory:` client → run
  `applyLegacySqliteCompat` + the Drizzle migrator → assert every statement
  no-ops (normalized `PRAGMA table_info` + `sqlite_master` index metadata
  identical before/after, `__drizzle_migrations` has one row). This keeps
  the prod-shape proof alive forever, not just while both drivers coexist.
- **New: `tests/state/concurrency.test.ts`** — see Verification below.
- **New: `tests/admin/executions-wire.test.ts`** — see Wire format above.
- A `consecutiveFailures` case (in `tests/state/db.test.ts` if not already
  present): two failures then a success → returns 2; asserts the
  `=== false` port didn't invert.

## Dependency removal

Order matters — remove code first, then the package:

1. `grep -rn better-sqlite3 src tests` → must return **empty**. Known
   stragglers to sweep: `src/index.ts:403` (comment),
   `tests/connectors/slack/connector.test.ts:4`,
   `tests/connectors/messaging/session-manager.test.ts:2`,
   `tests/state/workflow-run-store.test.ts:2`, and the deleted
   `src/state/migrate.ts`.
2. `npm rm better-sqlite3 @types/better-sqlite3`.
3. `npm run build && npx vitest run` — full suite green without the module
   installed (catches any dynamic import).

## Verification

Beyond the standard `npm run build && npx vitest run` +
`cd dashboard && npx tsc -b` (admin routes touched):

### Prod-shape smoke (mandatory — this is the phase that touches prod data)

1. Get a copy of the real DB into the scratchpad dir: locally
   `cp data/lastlight.db data/lastlight.db-wal data/lastlight.db-shm <scratch>/`
   if a dev copy exists; otherwise pull from prod (data lives in the docker
   volume `lastlight_agent-data` on the prod host — see local agent memory —
   e.g. `ssh root@<prod> docker run --rm -v lastlight_agent-data:/d alpine cat /d/lastlight.db > <scratch>/lastlight.db`,
   after a `PRAGMA wal_checkpoint(TRUNCATE)` so the WAL is folded in).
2. Boot the state layer against it:

   ```bash
   npx tsx --eval '
     const { StateDb } = await import("./src/state/db.ts");
     const db = await StateDb.open(process.env.SMOKE_DB);
     console.log("runs:", (await db.runs.list({ limit: 5 })).total);
     console.log("executions:", (await db.executions.allExecutions(5)).length);
     console.log("chat threads:", (await db.executions.listChatThreads(3)).length);
     console.log("stats:", (await db.executions.dailyStats(7)).at(-1));
     await db.close();
   ' # SMOKE_DB=<scratch>/lastlight.db
   ```

   Watch the logs: the legacy compat step should log nothing (all columns
   present) and the migrator should apply exactly the baseline.
3. `sqlite3 <copy> 'SELECT * FROM __drizzle_migrations;'` → exactly one row.
   `sqlite3 <copy> 'PRAGMA integrity_check;'` → `ok`.
4. Optional full boot: `DB_PATH=<copy> npm run dev`, open the dashboard,
   confirm the workflow-runs list, a run's phase detail, and the chat
   sessions tab all show **historical** data (this exercises the wire-format
   mapping against real rows, including pre-`workflow_run_id` legacy rows).
5. Run the smoke **twice** on the same copy — second boot must be a no-op
   (idempotence of compat + migrator).

### Concurrency probe — `tests/state/concurrency.test.ts`

Guards the libsql interactive-transaction risk. On a **file-backed** DB
(`await StateDb.open(join(tmpDir, "probe.db"))` — `:memory:` can't surface
cross-transaction contention):

- Seed a run + `pauseForApproval`. Then race the responders:

  ```ts
  const results = await Promise.allSettled([
    db.runs.resolveGateAndResume(approvalId, "alice"),
    db.runs.resolveGateAndFail(approvalId, "bob", "changed my mind"),
  ]);
  ```

  Assert: **exactly one** fulfilled; the loser rejects with `/not pending/`;
  **no** rejection message contains `SQLITE_BUSY`; the run's final status
  matches the winner; the approval has exactly one responder.
- Loop ~20 iterations of overlapping `pauseForApproval` (distinct runs) +
  `resolveGateAndResume` to shake out intermittent busy errors under WAL.

**The mutex ships by design (locked decision 8), not as a fallback.** A
passing probe is weak evidence (timing-dependent, fast local disk), and
libsql local-client overlapping transactions have failure modes beyond
`SQLITE_BUSY` (nested-BEGIN errors, shared-handle interleaving). The
in-process mutex serializing the five named ops is semantically free in a
single-writer process — build it in from the start; the probe below remains
as the regression guard:

```ts
private opChain: Promise<unknown> = Promise.resolve();
private serialize<T>(fn: () => Promise<T>): Promise<T> {
  const next = this.opChain.then(fn, fn);
  this.opChain = next.catch(() => {});
  return next;
}
// pauseForApproval = this.serialize(() => this.client.transaction(...))
```

Keep the probe test — it's the regression guard for Phase 4's PG
transactions too (where the mutex is equally harmless).

## Risk watch-items

- **libsql interactive-transaction BUSY errors** on the local file client:
  drizzle's libsql transactions are real `BEGIN`-held transactions; two
  overlapping ones on one process can surface `SQLITE_BUSY` where
  better-sqlite3's sync transactions physically couldn't interleave.
  Mitigations: the named-op mutex (shipped by design, locked decision 8),
  `busy_timeout=5000` pragma (set in `open()`), the concurrency probe as
  regression guard.
- **Raw-vs-builder mapping mismatches** — the #1 regression class. Raw
  `rows()` results bypass ALL Drizzle mapping: booleans arrive as 0/1, json
  columns as strings, names as whatever the SQL aliases say. Every method in
  the porting tables is marked builder (mapped) or sql`` (unmapped); when
  touching one, re-check which side of the line it's on. Special care:
  `searchErrors` / `getExecutionsForWorkflowRun` keep their `Boolean(r.success)`
  raw mapping while `consecutiveFailures` (builder) uses `=== false`.
- **json-mode double-encoding**: passing an already-stringified value into a
  `{mode:'json'}` column stores a JSON-encoded *string*. Writers of json
  columns after this phase: `createRun` / `mergeScratch` / `appendPhase` /
  `flipFinished` (already pass objects) plus the executions status columns —
  which is exactly why the stringify at `phase-executor.ts:339-340` MUST be
  dropped in the same commit that flips those columns to json-mode (see
  Preconditions). A double-encoded value here fails silently (stored as a
  quoted string, read back as a string, dashboard shows raw JSON text) —
  add one assertion to the routes pin test that `extensionStatus` comes
  back as an object, not a string.
- **`undefined` vs `null` in builder writes**: Drizzle omits `undefined`
  keys in `.set()` (column untouched) and applies column defaults for
  omitted `.values()` keys. Where the old SQL wrote explicit NULL
  (`?? null` params), keep `?? null`; where it used `COALESCE(?, col)`,
  conditional key spreading is the equivalent.
- **`@libsql/client` native binding on node:22-slim**: prebuilt binaries are
  the reason libsql was chosen (locked decision 2), but the docker-image
  proof happens in **Phase 5** (the Dockerfile build drops `python3 make
  g++` there). In this phase only local dev (macOS arm64) and CI verify the
  binding — do not touch the Dockerfile yet, and flag Phase 5 if the local
  install needed any fallback.
- **Migrations folder resolution**: `new URL("../../drizzle/sqlite",
  import.meta.url)` must resolve from `src/state/` (tsx dev) AND
  `dist/state/` (compiled) to the repo-root `drizzle/`. Verify both:
  `npm run dev` boot and `npm run build && node -e 'import("./dist/state/db.js").then(m => m.StateDb.open(":memory:"))'`.
  (npm-tarball resolution is Phase 5's `files` change.)
- **Timestamps**: everything stays ISO-8601 TEXT — no `Date` objects should
  appear in any row type. If a builder column was accidentally declared with
  a timestamp mode in Phase 1, rows will come back as `Date` and comparisons
  like `last_activity_at >= cutoff` silently change — the schema-equivalence
  test plus `tests/state/db.test.ts`'s string assertions should catch it.

## Done criteria

- [ ] `src/state/client.ts`, `src/state/dialect.ts`,
  `src/state/legacy-sqlite.ts` exist as specced; `src/state/migrate.ts`
  deleted; `SessionManager.migrate`/`rebuildWithoutTableUnique` deleted.
- [ ] `StateDb.open(dbPath?)` / `StateDb.fromClient(client, dialect)` are the
  only construction paths; `get client()` / `get dialect()` replace
  `get database()`; `src/index.ts:142-146` updated.
- [ ] All three stores + SessionManager contain zero `better-sqlite3` types,
  zero manual `JSON.parse`/`stringify` for json-mode columns, zero
  `=== 0`/`=== 1` boolean compares on mapped rows.
- [ ] The five named ops run in `client.transaction`; the trailing-`dbc`
  participants are exactly the listed methods; rollback + double-responder
  tests green.
- [ ] `/admin/api/executions` returns snake_case (pin test green);
  `/workflow-runs*` responses byte-identical in shape to before;
  `cd dashboard && npx tsc -b` green with **zero dashboard changes**.
- [ ] `grep -rn better-sqlite3 src tests` empty; `better-sqlite3` +
  `@types/better-sqlite3` removed from package.json; full suite green.
- [ ] Prod-shape smoke passed (twice, idempotent; `__drizzle_migrations` =
  1 row; `integrity_check` ok; dashboard shows history).
- [ ] The named-op mutex is in place (locked decision 8) and the concurrency
  probe is green (exactly one winner, no SQLITE_BUSY leak).
- [ ] The 02a ripple is complete per its own done criteria (70 async methods,
  signature flips, fire-and-forget table, floating-promise greps clean,
  evals barrel untouched, dashboard tsc green).
- [ ] `simple.ts` awaits `onRunStart` (locked decision 10);
  `getOrCreateSession` race guard + test in place (locked decision 11);
  `StateDb.open` normalizes path/URL forms and `close()` is async (locked
  decision 9).
- [ ] README.md Phase 2 checkbox ticked; deviations recorded below.

## Deviations

*(append what/why here during execution)*
