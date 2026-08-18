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
- **Seven** stores share the one connection (transactions are per-connection):
  `ExecutionStore` (`executions`, ~1,030 LOC), `ApprovalStore`
  (`workflow_approvals`), `WorkflowRunStore` (`workflow_runs`, ~1,000 LOC,
  injected with the approval store for cross-table atomic ops), `UserStore`
  (`users` — issue #205), `TeamStore` (`github_teams` / `github_team_repos` /
  `github_team_members` / `github_visibility_sync` — issue #169),
  `FeedbackStore` (`feedback_anchors` / `feedback_signals` — issue #255),
  `CronRunStore` (`cron_runs` — issues #341/#327). `StateDb` itself owns
  `cron_overrides` + `workflow_overrides`. `state/` is ~4,700 LOC across ~134
  inline `db.prepare(...)` calls — no statement caching, no query builder.
  *(2026-08-18: the last three stores postdate the original text, which said
  "four stores".)*
- **Transactions live in TWO stores**: the five named atomic ops in
  `WorkflowRunStore` **plus four in `TeamStore`** (`recordResolution`,
  `invalidateLogin`, `invalidateTeam`, `invalidateAll`) — nine sites — and
  `SessionManager` hand-rolls `BEGIN`/`COMMIT`/`ROLLBACK` around its legacy
  table rebuild. See README locked decision 8: the async mutex must therefore
  be connection-scoped, not store-scoped.
- **`migrate.ts` carries DATA backfills as well as DDL** — the `workflow_runs`
  owner/repo de-qualification (whose result the `executions` backfill then
  reads back out), and the `feedback_anchors.channel` sentinel. They re-run on
  every boot; README locked decision 14 moves them to journaled one-shot
  migrations.
- **A consumer sits outside `apps/server` entirely**: `packages/workflow-engine`
  declares a **synchronous** `WorkflowStateStore` port (`ports.ts:185-210`) that
  `StateDb` satisfies structurally, fenced by a compile-time contract test.
  Twenty-three engine call sites read it (18 `core/phase-executor.ts`, 5
  `core/scheduler.ts`). README locked decision 13 flips it to `Promise<T>`.
- Timestamps are ISO-8601 TEXT everywhere; booleans are INTEGER 0/1; JSON is
  stringified TEXT; PKs are `randomUUID()` TEXT except the three **composite**
  PKs (`github_teams`, `github_team_repos`, `github_team_members`) and
  `messaging_messages.id AUTOINCREMENT`. `executions.cost_usd` is the schema's
  only REAL column. **Exactly one declared FK exists**
  (`messaging_messages.session_id → messaging_sessions.id`, no ON DELETE), and
  `PRAGMA foreign_keys` is **never turned on** — the sole runtime pragma is
  `journal_mode = WAL`.

## Target file layout

```
apps/server/src/state/
  schema/sqlite.ts   # sqliteTable defs — 15 tables (13 state + 2 messaging), 25 named indexes
  schema/pg.ts       # pgTable mirror: identical export names + column property names
  client.ts          # StateClient (LibSQLDatabase<typeof sqliteSchema>), StateTx,
                     # asStateClient() cast seam for the PG instance, Dialect type,
                     # and the connection-scoped op serializer (locked decision 8)
  dialect.ts         # portability seam: rows(client, dialect, sql) / changes(result) /
                     # isUniqueViolation(err) / likeEscape() / dayBucket() / hourBucket()
                     # / strposExpr() — instr() has no PG equivalent (hotspot table)
  legacy-sqlite.ts   # pre-drizzle compat pre-step (runs before the migrator; see below)
  db.ts              # StateDb — async factory: static open(url) / fromClient(client, dialect)
  execution-store.ts / approval-store.ts / workflow-run-store.ts / user-store.ts
  team-store.ts / feedback-store.ts / cron-run-store.ts            # all 7 async, drizzle
  repo-ref.ts        # qualifiedRepoSql becomes a dialect-aware SQL fragment, not a string
  build-assets.ts    # UNTOUCHED — filesystem-only, never opens the DB
apps/server/drizzle/sqlite/0000_baseline.sql (+ meta/)   # hand-edited idempotent baseline
apps/server/drizzle/sqlite/0001_backfill_*.sql           # journaled one-shot DATA backfills
                                                         # (locked decision 14) — ORDER MATTERS
apps/server/drizzle/pg/0000_init.sql (+ meta/)           # generated, fresh-DB only (PGlite)
apps/server/drizzle-sqlite.config.ts / apps/server/drizzle-pg.config.ts  # at the package root

packages/workflow-engine/src/
  ports/ports.ts     # RunStore + ExecutionLedger flip to Promise<T> (locked decision 13)
  core/phase-executor.ts / core/scheduler.ts   # await at 23 call sites
  test-support/fakes.ts                        # InMemoryStateStore rewritten async
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
**stable** drizzle-orm/drizzle-kit unless a needed API requires otherwise
(v1 was still RC-only at last check, 2026-07-09). Because finius runs the v1
line, its `drizzle/` directory uses the **v1 migration layout** (timestamped
folders + `snapshot.json`, no `meta/_journal.json`) — do not copy that layout
either; stable drizzle-kit emits `0000_name.sql` + `meta/`. And finius's
`affectedRows()` reads `.changes ?? .rowCount` (node:sqlite / node-postgres) —
our drivers need `.rowsAffected` (libsql) / `.affectedRows` (PGlite) instead;
`dialect.ts`'s `changes()` covers all four, but don't copy finius's property
list verbatim.

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
     async. This includes the issue-#205 actor columns
     (`executions`/`workflow_runs`: `triggered_by`, `trigger_actor_type`) and
     `workflow_runs.owner` — and `owner` carries a one-time **data backfill**
     in the same guarded step (`UPDATE workflow_runs SET owner =
     json_extract(context, '$.owner') WHERE owner IS NULL AND context IS NOT
     NULL`, `migrate.ts` ≈159-168). `json_extract` is sqlite-only, which is
     fine — this pre-step is sqlite-only; the backfill is idempotent
     (`WHERE owner IS NULL`).
  2. The messaging `UNIQUE(platform,…)` table rebuild ported from
     `session-manager.ts` (sniff `sqlite_master`, `PRAGMA foreign_keys`
     toggle, copy, drop, rename, `foreign_key_check`). Keep one more release
     with a `TODO(remove after v0.12)` marker (the migration ships in v0.11 —
     see Phase 5's release section).
- **PG migrations** (`drizzle/pg/`): plain generated output, fresh databases
  only (PGlite per-test). No legacy story.
- **Runtime application** in `StateDb.open()`: pragmas
  (`journal_mode=WAL`, `busy_timeout=5000` — note the latter is
  connection-scoped and lost once a transaction swaps the client's
  connection; locked decision 12) → legacy pre-step → `migrate()`
  from `drizzle-orm/libsql/migrator` with `migrationsFolder` resolved
  module-relative (`new URL("../../drizzle/sqlite", import.meta.url)` — must
  resolve from both `src/state/` and `dist/state/`). Tests boot the identical
  path (fidelity over `drizzle-kit push`) — against `:memory:` where no
  transactions run, per-test temp files everywhere the five named ops are
  exercised (locked decision 12).

## Portability hotspot ports

> **Re-derived 2026-08-18.** The original table had 7 rows and was drawn from a
> 3-store codebase. The full audit found **five more classes** the table never
> covered — three of them **hard syntax errors** on Postgres rather than
> behavioural drift. Those are listed in the second table below; treat both as
> one checklist.

| Hotspot (current code) | Port |
|---|---|
| `json_patch(COALESCE(context,'{}'), json_object('error',?))` in `WorkflowRunStore.flipFinished` (`:742`) — **and two more the plan missed**: `expireQueued` (`:632`, same fragment) and `restartRun` (`:798`, `json_remove(COALESCE(context,'{}'), '$.error')`) | App-side read-modify-write inside the same transaction — trivial once `context` is a json-mode column (read object, `{...ctx, error}` / delete the key, update). **All three**, not just `flipFinished`. `flipFinished`'s `CASE WHEN ? IS NOT NULL` also needs an explicit cast on PG — a bare parameter there has indeterminate type |
| `date(started_at)` / `strftime('%Y-%m-%dT%H',…)` GROUP BY rollups in `ExecutionStore.dailyStats/hourlyStats` (`:932,941,942,994,1003,1004`) — **plus `FeedbackStore.dailyScores`** (`feedback-store.ts:451,457,458`, `date(observed_at)`), which the plan never listed | `substr(col, 1, 10)` / `substr(col, 1, 13)` via `dayBucket()`/`hourBucket()` — exists in both dialects; ISO text makes bucket keys identical. The JS side already generates matching keys (`execution-store.ts:923-928,984-990`; `feedback-store.ts:434-440`), so the string form must be preserved exactly |
| `LIKE ? ESCAPE '\'` in `searchErrors` (`:786-788`) | `lower(col) LIKE lower(pattern) ESCAPE '\'` — PG LIKE is case-sensitive, SQLite's isn't; lower() both sides. The docstring at `:748-752` explicitly relies on the case-insensitivity, so this is behaviour preservation, not cosmetics. Keep the existing wildcard escaping |
| `thread_id IS ?` null-safe compare — **four sites, not one**: `session-manager.ts:152,163` **and `feedback-store.ts:249,319`** (`reactor IS ?`) | `x == null ? isNull(col) : eq(col, x)`. These are the identity predicates for session lookup and signal idempotency — get one wrong and rows silently fork instead of matching |
| `SUM(CASE WHEN success = 1 …)` fragments | Successes: `CASE WHEN ${col} THEN 1 ELSE 0 END` (truthiness works on sqlite 0/1 and pg boolean; NULL falls to ELSE). Failures: `CASE WHEN ${col} = ${false} THEN 1 ELSE 0 END` — explicit comparison, NOT `WHEN NOT ${col}`; see 02b's porting table for the rationale |
| `result.changes === 1` compare-and-set | `changes(result)` helper: libsql `rowsAffected`, PGlite/node-postgres `affectedRows`/`rowCount` |
| `INSERT … ON CONFLICT DO UPDATE … excluded.*` upserts (cron/workflow overrides) | Drizzle `.onConflictDoUpdate({ target, set })` — portable |

### Additional hotspots found 2026-08-18 (absent from the original plan)

The first three are **hard syntax errors** on Postgres — the query does not
parse, so the PGlite leg fails loudly rather than drifting. Good, but they must
be ported before that leg can go green at all.

| Hotspot | Port |
|---|---|
| **`rowid`** in `ORDER BY started_at DESC, rowid DESC` — `cron-run-store.ts:123,156` | **No `rowid` in Postgres.** The docstring at `:146-150` says this tiebreak is load-bearing: without it `recentFailures` reports 0 for an always-failing cron (same-timestamp rows tie arbitrarily). Needs a real monotonic tiebreak column, or ordering by the TEXT `id`. Do NOT just drop it |
| **Unaliased derived table** — `SELECT * FROM ( … ) WHERE rn = 1`, `cron-run-store.ts:121-126` | PG **requires** an alias on a `FROM` subquery. Add one (`AS latest`) — mechanical, but a parse error until you do |
| **`instr()`** — `repo-ref.ts:109` (`qualifiedRepoSql`, fanning out to **8 call sites** across `execution-store.ts:96,442,502,550,772,777,788,891` and `workflow-run-store.ts:667,670,673,694,699`) plus four `migrate.ts` backfills (`:374-378,387-392,408-411,424-426`) | PG has no `instr()` — use `strpos(str, sub)` / `position(sub in str)`. `substr()`, `\|\|` and `<>` are all fine. This is the single widest-reaching fragment in the codebase |
| **`INSERT OR IGNORE`** — `team-store.ts:98,103` | PG: `ON CONFLICT DO NOTHING`. Drizzle: `.onConflictDoNothing()` |
| **`COALESCE(?, col)` update idioms** — six sites, incl. `recordFinish`'s **ten columns in one statement** (`execution-store.ts:338-347`), `feedback-store.ts:147-154` (7 columns in an `ON CONFLICT` arm), `workflow-run-store.ts:797,852`, and `user-store.ts:141-144` — plus `user-store.ts:155`'s **reversed** `COALESCE(name, ?)` where the *existing* value wins | `COALESCE` itself is portable, but every untyped parameter inside one needs an explicit cast on PG (`COALESCE($1::text, session_id)`) or you get "could not determine data type of parameter". The builder equivalent is conditional key spreading — include a `.set()` key only when the value is defined. **Watch the reversed one**: spreading it the normal way inverts its meaning |
| `ORDER BY last_polled_at IS NOT NULL, last_polled_at ASC` — `feedback-store.ts:211` | A boolean used as a sort key. Works on both (`false` sorts before `true`, matching SQLite's `0 < 1`) but it is fragile enough to deserve a pinning test rather than trust |
| `COALESCE(t.truncated, 0)` over a `LEFT JOIN` — `team-store.ts:167` | Becomes `COALESCE(…, false)` on PG once `truncated` is a real boolean. The column is `NOT NULL`, so the NULL comes purely from the outer join — the COALESCE is load-bearing, not defensive |
| `SELECT sql FROM sqlite_master …` — `session-manager.ts:62` | SQLite catalog access, inherently sqlite-only. Moves wholesale into `legacy-sqlite.ts` (Phase 2) and never runs on PG |

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
transactions can fail in ways beyond `SQLITE_BUSY`, and the `busy_timeout`
pragma is connection-scoped — the libsql client swaps connections after each
transaction, so the mutex, not the pragma, is the load-bearing defense).
Long-running sandbox dispatch stays outside transactions (callers already
dispatch after the atomic op returns).

## Non-goals

No sqlite→pg data migration tooling (stays an optional follow-on — see
[06-prod-postgres.md](06-prod-postgres.md) §8). CLI untouched. Dashboard code
untouched (wire format preserved server-side). Sandbox/docker integration tests
unaffected.

**Through Phase 5**, also a non-goal: a production Postgres service —
`StateDb.open` recognizes a `postgres://` URL and throws an informative "PG
runtime not enabled" error; PG entry is `fromClient` (tests) only, keeping `pg`
out of runtime deps. **Phase 6 removes this non-goal** —
[06-prod-postgres.md](06-prod-postgres.md) replaces the throw with a real,
**driver-selectable** Postgres pool client — standard **node-postgres** (default)
or **Neon serverless** (`drizzle-orm/neon-serverless`, WebSocket) — adding `pg` +
`@neondatabase/serverless` as runtime deps (each lazily imported by its own
driver branch, so sqlite deployments load neither and neither driver loads the
other). Both sit behind the unchanged `"postgres"` dialect seam, making Postgres
operator-selectable. (Neon's `neon-http` driver is deliberately excluded — it
can't run the interactive transactions the five atomic ops require.)
