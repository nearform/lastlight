# Target architecture — Drizzle state layer

Read together with [README.md](README.md) (locked decisions + hard constraints).

## Current state (what we're migrating from)

- One shared **synchronous** `better-sqlite3` connection, opened in
  `src/state/db.ts` (`StateDb` constructor: `:memory:` passthrough for tests,
  else `resolve(path)`; sole pragma `journal_mode=WAL`).
- DDL lives in `src/state/migrate.ts`: idempotent boot-time
  `CREATE TABLE/INDEX IF NOT EXISTS` plus try/catch-guarded additive
  `ALTER TABLE ADD COLUMN`. **No migration journal.**
- A **second schema owner**: `src/connectors/messaging/session-manager.ts` is
  handed the raw handle (`db.database`, wired in `src/index.ts`) and
  self-migrates `messaging_sessions` + `messaging_messages`, including a legacy
  table-rebuild (`rebuildWithoutTableUnique`) that sniffs `sqlite_master` for an
  old `UNIQUE(platform,…)` constraint.
- Three stores share the one connection (transactions are per-connection):
  `ExecutionStore` (`executions`), `ApprovalStore` (`workflow_approvals`),
  `WorkflowRunStore` (`workflow_runs`, injected with the approval store for
  cross-table atomic ops). `StateDb` itself owns `cron_overrides` +
  `workflow_overrides`.
- Timestamps are ISO-8601 TEXT everywhere; booleans are INTEGER 0/1; JSON is
  stringified TEXT; PKs are `randomUUID()` TEXT except
  `messaging_messages.id AUTOINCREMENT`.

## Target file layout

```
src/state/
  schema/sqlite.ts   # sqliteTable defs — 7 tables (5 state + 2 messaging), all indexes
  schema/pg.ts       # pgTable mirror: identical export names + column property names
  client.ts          # StateClient (LibSQLDatabase<typeof sqliteSchema>), StateTx,
                     # asStateClient() cast seam for the PG instance, Dialect type
  dialect.ts         # portability seam: rows(client, dialect, sql) / changes(result) /
                     # isUniqueViolation(err) / likeEscape() / dayBucket() / hourBucket()
  legacy-sqlite.ts   # pre-drizzle compat pre-step (runs before the migrator; see below)
  db.ts              # StateDb — async factory: static open(url) / fromClient(client, dialect)
  execution-store.ts / approval-store.ts / workflow-run-store.ts   # async, drizzle
drizzle/sqlite/0000_baseline.sql (+ meta/)   # hand-edited idempotent baseline
drizzle/pg/0000_init.sql (+ meta/)           # generated, fresh-DB only (PGlite)
drizzle-sqlite.config.ts / drizzle-pg.config.ts
```

## Dual-dialect strategy (the honest version)

Drizzle has **no single-schema multi-dialect mode** — `sqliteTable` and
`pgTable` objects are different types. So:

- **Two schema files** with identical export names and column property names.
- Store code is written **once**, typed against the **sqlite** Drizzle instance
  (`LibSQLDatabase<typeof sqliteSchema>` — the production path).
- The PG instance (PGlite in tests) is adapted through one documented
  `asStateClient()` cast in `client.ts`. This is sound because the
  query-builder surface the stores use (`select/insert/update/delete/
  transaction`) is structurally identical across drivers; the two genuinely
  divergent surfaces — raw `sql` execution and rows-affected shape — are
  funneled through `rows()` and `changes()` in `dialect.ts`, branching on a
  runtime `dialect` discriminator (`"sqlite" | "postgres"`) carried by
  `StateDb`.
- **Backend selection is construction-time injection** (`StateDb.open()` /
  `StateDb.fromClient(client, dialect)`), NOT module-load env globals — both
  dialects must be constructible in one test process.

**Two drift guards** keep the schemas honest:
1. `tests/state/schema-parity.test.ts` — diffs table names, column names,
   nullability, PKs, and index names via `getTableConfig` from
   `drizzle-orm/sqlite-core` and `drizzle-orm/pg-core`. It deliberately does
   **NOT** compare column types (jsonb-vs-text and boolean-vs-integer
   divergence is intentional).
2. The **full state test suite runs against PGlite** (Phase 4) — behavioral
   proof, not just structural.

## Reference implementation: finius

`/Users/clifton/Documents/finius` (note: NOT `~/work/finius`) runs one Drizzle
query layer over SQLite + Postgres with this same architecture. Its
`src/server/db/{dialect,client,schema-active,raw,fragments}.ts` top-of-file doc
comments are the best written spec of the pattern (~280 LOC of portability seam
total). **Adopt:** the minimal dialect-seam interface (only SQL constructs that
actually diverge), the feature-detected `raw.ts` helpers (rows-affected via
`.rowsAffected` vs `.rowCount`/`.affectedRows`; unique-violation detection
walking `DrizzleQueryError.cause` for PG SQLSTATE `23505` vs SQLite's `UNIQUE`
message), the pg-handle-cast technique, per-dialect drizzle-kit configs +
runtime migrators, and the types-excluded cross-parity test
(`tests/schema-cross-parity.test.ts`).

**Deliberately diverge from finius on three points:**
1. finius uses `node:sqlite` and consequently has **no transactions at all**
   (node:sqlite's `transaction` can't await). Last Light's five named atomic
   ops and compare-and-set guards are non-negotiable → libsql, real async
   transactions.
2. finius stores JSON as plain text even on PG. We use **real jsonb** (locked
   decision 4).
3. finius selects its backend via module-load env (`activeBackend()`). We use
   construction-time injection.

Also: finius pins drizzle-orm **v1.0.0-rc** — pin Last Light to the latest
**stable** drizzle-orm/drizzle-kit unless a needed API requires otherwise.

## Column type decisions (both schemas)

- **Timestamps stay ISO-8601 `text()` in BOTH dialects.** Keeps lexicographic
  ordering, makes the stats rollups dialect-neutral via `substr()`, and needs
  zero data migration. Do NOT use pg `timestamp`/`timestamptz`.
- **Booleans:** sqlite `integer({ mode: "boolean" })` / pg `boolean()`.
  Applies to `executions.success` (nullable tri-state), `cron_overrides.enabled`,
  `workflow_overrides.enabled`, `messaging_sessions.active`.
- **JSON columns: real JSON types.** sqlite `text({ mode: "json" }).$type<T>()`
  / pg `jsonb().$type<T>()` with the **same `$type<T>` on both** so the inferred
  store-facing type is identical. Applies to every column the stores currently
  `JSON.parse`/`stringify` — resolved by Phase 1's audit: json-mode =
  `workflow_runs.phase_history` (DDL default `'[]'`), `workflow_runs.context`,
  `workflow_runs.scratch`, `executions.extension_status`
  (`$type<ExtensionStatusMap>`), `executions.skills_status`
  (`$type<SkillsStatus>`); `workflow_approvals.artifact` is a filename, NOT
  JSON — plain text. For the two status columns the JSON boundary lives
  outside the store today (`phase-executor.ts` stringifies,
  `admin/routes.ts` `parseJsonColumn` parses) — Phase 2b moves that boundary
  into the schema (see its Preconditions). Stores drop manual
  parse/stringify at these boundaries. Existing
  sqlite rows already contain valid JSON text, so `{mode:'json'}` reads them
  as-is — no data migration. Keep `WorkflowRunStore.list()`'s explicit column
  selection so multi-MB `context`/`scratch` never ride along on dashboard polls.
- `messaging_messages.id`: sqlite `integer().primaryKey({ autoIncrement: true })`
  / pg `integer().generatedAlwaysAsIdentity().primaryKey()`. Inserts never
  supply an id.
- **Partial unique index** (`WHERE active = 1` on messaging_sessions): native
  in both dialects via `uniqueIndex(...).on(...).where(sql\`...\`)`.

## Migration story

- **SQLite baseline** (`drizzle/sqlite/0000_baseline.sql`): drizzle-kit
  generated, then **hand-edited to be fully idempotent** (`IF NOT EXISTS` on
  every CREATE TABLE/INDEX), containing the complete current column set
  including all historically-ALTERed columns, plus both messaging tables. On an
  existing prod DB every statement no-ops; the migrator then records it in
  `__drizzle_migrations` and future migrations proceed normally. Hand-editing a
  migration is an anti-pattern **except exactly here** — a baseline over a
  journal-less legacy DB; say so in the file header comment.
- **`legacy-sqlite.ts`** runs **before** the migrator, sqlite-only, idempotent,
  every boot:
  1. `PRAGMA table_info`-guarded `ALTER TABLE ADD COLUMN` for operators
     upgrading from versions older than the current column set (where
     `CREATE TABLE IF NOT EXISTS` would no-op without adding their missing
     columns). Guard by column presence, not try/catch — libsql errors are
     async.
  2. The messaging `UNIQUE(platform,…)` table rebuild ported from
     `session-manager.ts` (sniff `sqlite_master`, `PRAGMA foreign_keys`
     toggle, copy, drop, rename, `foreign_key_check`). Keep one more release
     with a `TODO(remove after v0.11)` marker.
- **PG migrations** (`drizzle/pg/`): plain generated output, fresh databases
  only (PGlite per-test). No legacy story.
- **Runtime application** in `StateDb.open()`: pragmas
  (`journal_mode=WAL`, `busy_timeout=5000`) → legacy pre-step → `migrate()`
  from `drizzle-orm/libsql/migrator` with `migrationsFolder` resolved
  module-relative (`new URL("../../drizzle/sqlite", import.meta.url)` — must
  resolve from both `src/state/` and `dist/state/`). Tests boot the identical
  path against `:memory:` (fidelity over `drizzle-kit push`).

## Portability hotspot ports

| Hotspot (current code) | Port |
|---|---|
| `json_patch(COALESCE(context,'{}'), json_object('error',?))` in `WorkflowRunStore.flipFinished` | App-side read-modify-write inside the same transaction — trivial once `context` is a json-mode column (read object, `{...ctx, error}`, update) |
| `date(started_at)` / `strftime('%Y-%m-%dT%H',…)` GROUP BY rollups in `ExecutionStore.dailyStats/hourlyStats` | `substr(started_at, 1, 10)` / `substr(started_at, 1, 13)` via `dayBucket()`/`hourBucket()` — `substr(text,int,int)` exists in both dialects; ISO text makes bucket keys identical |
| `LIKE ? ESCAPE '\'` in `searchErrors` | `lower(col) LIKE lower(pattern) ESCAPE '\'` — identical behavior in both dialects (PG LIKE is case-sensitive, SQLite's isn't; lower() both sides). Keep the existing wildcard escaping |
| `thread_id IS ?` null-safe compare (SessionManager) | `key.threadId == null ? isNull(col) : eq(col, value)` |
| `SUM(CASE WHEN success = 1 …)` fragments | Successes: `CASE WHEN ${col} THEN 1 ELSE 0 END` (truthiness works on sqlite 0/1 and pg boolean; NULL falls to ELSE). Failures: `CASE WHEN ${col} = ${false} THEN 1 ELSE 0 END` — explicit comparison, NOT `WHEN NOT ${col}`; see 02b's porting table for the rationale |
| `result.changes === 1` compare-and-set | `changes(result)` helper: libsql `rowsAffected`, PGlite/node-postgres `affectedRows`/`rowCount` |
| `INSERT … ON CONFLICT DO UPDATE … excluded.*` upserts (cron/workflow overrides) | Drizzle `.onConflictDoUpdate({ target, set })` — portable |

## Transaction design (Phase 2b detail, summarized here for orientation)

The five named atomic ops in `WorkflowRunStore` (`finishRun` with
terminalMarker, `pauseForApproval`, `resolveGateAndResume`,
`resolveGateAndFail`, `resolveReplyGateAndResume`) become
`this.client.transaction(async (tx) => { … })`. Cross-store participant
methods gain a trailing `dbc: StateClient | StateTx = this.client` parameter so
they run against either the root client or an enclosing transaction. A
`changes(result) !== 1` inside the callback **throws to roll back**, preserving
the double-responder guards. The five ops are additionally serialized by a
small in-process mutex on `WorkflowRunStore` (README locked decision 8 —
shipped by design, not as a probe-failure fallback; overlapping libsql
transactions can fail in ways beyond `SQLITE_BUSY`). Long-running sandbox
dispatch stays outside transactions (callers already dispatch after the
atomic op returns).

## Non-goals

No sqlite→pg data migration tooling. No production Postgres service —
`StateDb.open` recognizes a `postgres://` URL and throws an informative "PG
runtime not enabled" error; PG entry is `fromClient` (tests) only, keeping `pg`
out of runtime deps. CLI untouched. Dashboard code untouched (wire format
preserved server-side). Sandbox/docker integration tests unaffected.
