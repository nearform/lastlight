# Phase 4 — Postgres schema + PGlite test leg

> Read [README.md](README.md) and [00-architecture.md](00-architecture.md)
> first. This phase proves the dialect seam: a `pgTable` mirror schema,
> generated PG migrations, a types-excluded parity test, and the Phase-3
> state suite running green against real Postgres (PGlite, WASM) in the
> ordinary `npx vitest run`.

## Goal

Add `src/state/schema/pg.ts` mirroring `src/state/schema/sqlite.ts` 1:1 by
export name and column property name — with real `jsonb`, real `boolean`,
and an identity column where sqlite used autoincrement — generate
`drizzle/pg/0000_init.sql`, and run the shared state test suite against a
PGlite-backed `StateDb`. No production PG deployment, no data migration
(locked decision 3). PG stays out of runtime deps: the only PG entry point
is `StateDb.fromClient()` from tests.

## Preconditions

- [ ] Phases 1, 2 (combined), 3 checked off in [README.md](README.md).
- `src/state/schema/sqlite.ts` exists with all 7 tables + indexes (Phase 1).
- Stores are async, Drizzle-backed, and route all raw SQL / rows-affected
  reads through `dialect.ts`'s `rows()` / `changes()` (Phase 2b).
- `tests/state/store-suite.ts` exports `runStateDbSuite(makeDb, { dialect })`
  and the sqlite leg runs it green (Phase 3). The `makeDb` contract is
  **a pristine `StateDb` per call** (the sqlite leg hands out
  `StateDb.open(":memory:")` per test).
- `client.ts` exports `asStateClient()` (the documented pg-handle cast) and
  the `Dialect` type (Phase 2b).

## Files

| File | Action |
|---|---|
| `src/state/schema/pg.ts` | create — pgTable mirror |
| `drizzle-pg.config.ts` | create — drizzle-kit config, PG dialect |
| `drizzle/pg/0000_init.sql` (+ `meta/`) | generate — never hand-edit |
| `package.json` | `@electric-sql/pglite` devDep + `db:generate:pg` script |
| `tests/state/schema-parity.test.ts` | create — structural drift guard |
| `tests/state/db.pg.test.ts` | create — PGlite behavioral leg |
| `src/state/db.ts` | small edit — `open()` rejects `postgres://` URLs |

## 1. `src/state/schema/pg.ts`

Source of truth for the table inventory is the same one Phase 1 used:
`src/state/migrate.ts` (5 state tables, all historically-ALTERed columns
included) + `src/connectors/messaging/session-manager.ts:21-69` (the 2
messaging tables + partial unique index). **Do not re-derive from those
files — mirror `schema/sqlite.ts` exactly**: same export names, same column
property names, same column *names* (snake_case strings), same index names.
Only the column builder types change, per this mapping:

| sqlite builder (Phase 1) | pg builder (this phase) |
|---|---|
| `text(...)` (incl. every ISO-8601 timestamp) | `text(...)` — timestamps stay ISO text (locked; keeps `substr()` bucketing + lexicographic ORDER BY identical) |
| `integer(...)` (plain counters/ids) | `integer(...)` |
| `integer({ mode: "boolean" })` | `boolean(...)` |
| `text({ mode: "json" }).$type<T>()` | `jsonb(...).$type<T>()` — **identical `$type<T>`** so store-facing inferred types match |
| `real(...)` (`executions.cost_usd` — the only one) | `doublePrecision(...)` |
| `integer(...).primaryKey({ autoIncrement: true })` (`messaging_messages.id` — the only one) | `integer(...).generatedAlwaysAsIdentity().primaryKey()` |
| `uniqueIndex(...).on(...).where(sql\`active = 1\`)` | `uniqueIndex(...).on(...).where(sql\`active\`)` — `active` is a real boolean on PG; `= 1` would not compile there |
| DDL default `'[]'` on `phase_history` | `.default(sql\`'[]'::jsonb\`)` |
| defaults `'running'`, `'pending'`, `'approve'`, `0`, `1`(bool) | same values: `.default("running")`, …, `.default(0)`, `.default(true)` |

Per-table notes (everything not listed is `text()` in both dialects):

| Table | Non-text / notable columns on PG |
|---|---|
| `executions` | `issue_number`, `turns`, `duration_ms`, `input_tokens`, `cache_creation_input_tokens`, `cache_read_input_tokens`, `output_tokens`, `api_duration_ms` → `integer()`; `cost_usd` → `doublePrecision()`; `success` → `boolean()` **nullable** (tri-state: null = running); `extension_status`, `skills_status` → `jsonb().$type<…>()` (Phase 1's JSON audit converted these two; `output_text`, `stop_reason`, `session_id`, `workflow_run_id` stay text). Indexes: `idx_executions_trigger`, `idx_executions_skill`, `idx_executions_workflow_run`. |
| `workflow_runs` | `issue_number` → `integer()`; `restart_count` → `integer().notNull().default(0)`; `phase_history` / `context` / `scratch` → `jsonb().$type<…>()`. Indexes: `idx_workflow_runs_trigger`, `idx_workflow_runs_status`, `idx_workflow_runs_started_at` (desc), `idx_workflow_runs_name_started` (desc on started_at). |
| `cron_overrides` | `enabled` → `boolean().notNull().default(true)`. |
| `workflow_overrides` | `enabled` → `boolean().notNull().default(true)`. |
| `workflow_approvals` | all text; `kind` `.notNull().default("approve")`; `artifact` stays plain text (filename, not JSON — per Phase 1's audit). Indexes: `idx_approvals_workflow`, `idx_approvals_status`. |
| `messaging_sessions` | `message_count` → `integer().default(0)` (nullable — the legacy DDL has no NOT NULL); `active` → `boolean().default(true)` (nullable, same reason). Indexes: `idx_msg_sessions_lookup` + partial unique `idx_msg_sessions_unique_active`. |
| `messaging_messages` | `id` → identity PK; `session_id` keeps the FK `.references(() => messagingSessions.id)`. Index: `idx_msg_messages_session`. |

JSON payload types (`PhaseHistoryEntry[]`, the `context`/`scratch` shapes,
`extension_status`/`skills_status` shapes) must be **the same declarations**
on both schemas. If Phase 1 declared them inside `schema/sqlite.ts`, use a
type-only import (`import type { … } from "./sqlite.js"` — erased at
compile, no sqlite-core runtime import); if Phase 1 put them in a shared
`schema/json-types.ts`, import from there. Do not redeclare.

Representative table — `workflow_runs` (json columns + defaults):

```ts
// src/state/schema/pg.ts
// PostgreSQL mirror of ./sqlite.ts. Export names, table names, column
// names, and index names are IDENTICAL so the stores' one set of queries
// runs on both, and tests/state/schema-parity.test.ts guards drift.
// Type divergence is intentional and confined to: boolean() vs
// integer-0/1, jsonb() vs text{mode:json}, doublePrecision() vs real,
// identity vs autoincrement. Timestamps stay ISO-8601 text() (locked).
// This file exists ONLY for drizzle-kit generate (drizzle-pg.config.ts)
// and the PGlite test leg — no runtime module may import it.
import { sql } from "drizzle-orm";
import {
  boolean, doublePrecision, index, integer, jsonb, pgTable, text,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import type { PhaseHistoryEntry, RunContext, RunScratch } from "./sqlite.js";

export const workflowRuns = pgTable(
  "workflow_runs",
  {
    id: text("id").primaryKey(),
    workflowName: text("workflow_name").notNull(),
    triggerId: text("trigger_id").notNull(),
    repo: text("repo"),
    issueNumber: integer("issue_number"),
    currentPhase: text("current_phase").notNull(),
    phaseHistory: jsonb("phase_history").$type<PhaseHistoryEntry[]>()
      .notNull().default(sql`'[]'::jsonb`),
    status: text("status").notNull().default("running"),
    context: jsonb("context").$type<RunContext>(),
    scratch: jsonb("scratch").$type<RunScratch>(),
    restartCount: integer("restart_count").notNull().default(0),
    startedAt: text("started_at").notNull(),
    updatedAt: text("updated_at").notNull(),
    finishedAt: text("finished_at"),
  },
  (t) => [
    index("idx_workflow_runs_trigger").on(t.triggerId, t.status),
    index("idx_workflow_runs_status").on(t.status),
    index("idx_workflow_runs_started_at").on(t.startedAt.desc()),
    index("idx_workflow_runs_name_started").on(t.workflowName, t.startedAt.desc()),
  ],
);
```

And the messaging pair (identity PK + FK + partial unique index):

```ts
export const messagingSessions = pgTable(
  "messaging_sessions",
  {
    id: text("id").primaryKey(),
    platform: text("platform").notNull(),
    channelId: text("channel_id").notNull(),
    threadId: text("thread_id"),
    userId: text("user_id").notNull(),
    agentSessionId: text("agent_session_id"),
    createdAt: text("created_at").notNull(),
    lastActivityAt: text("last_activity_at").notNull(),
    messageCount: integer("message_count").default(0),
    active: boolean("active").default(true),
  },
  (t) => [
    index("idx_msg_sessions_lookup").on(t.platform, t.channelId, t.threadId, t.userId),
    // Partial unique: one ACTIVE session per key; stale rows may pile up.
    // sqlite spells the predicate `active = 1`; on PG `active` is a real
    // boolean. The parity test compares WHERE *presence*, not text.
    uniqueIndex("idx_msg_sessions_unique_active")
      .on(t.platform, t.channelId, t.threadId, t.userId)
      .where(sql`active`),
  ],
);

export const messagingMessages = pgTable(
  "messaging_messages",
  {
    // sqlite: integer PK autoincrement. Inserts NEVER supply an id —
    // GENERATED ALWAYS will (correctly) error if one does.
    id: integer("id").generatedAlwaysAsIdentity().primaryKey(),
    sessionId: text("session_id").notNull().references(() => messagingSessions.id),
    role: text("role").notNull(),
    content: text("content").notNull(),
    timestamp: text("timestamp").notNull(),
    platformMessageId: text("platform_message_id"),
  },
  (t) => [index("idx_msg_messages_session").on(t.sessionId, t.timestamp)],
);
```

Mirror the remaining five tables (`executions`, `cronOverrides`,
`workflowOverrides`, `workflowApprovals`) the same way. Sanity rule while
porting: for each column, copy the property name + name string from
`sqlite.ts` verbatim, then apply the mapping table above to the builder.

## 2. drizzle-kit config + generation

`drizzle-pg.config.ts` (repo root, sibling of Phase 1's
`drizzle-sqlite.config.ts`):

```ts
import { defineConfig } from "drizzle-kit";

export default defineConfig({
  dialect: "postgresql",
  schema: "./src/state/schema/pg.ts",
  out: "./drizzle/pg",
});
```

`package.json` script (next to Phase 1's sqlite one):

```json
"db:generate:pg": "drizzle-kit generate --config drizzle-pg.config.ts"
```

Run it once → `drizzle/pg/0000_init.sql` + `drizzle/pg/meta/`. **Commit the
generated output as-is.** Unlike the sqlite baseline (hand-edited to be
idempotent over a journal-less legacy DB — the one sanctioned exception),
the PG migrations target *fresh databases only* (PGlite per test); there is
no legacy story, so plain generated output is correct and hand-editing it
is forbidden. Re-running `db:generate:pg` after any pg.ts change appends a
new migration; during this phase, before anything ships, prefer deleting
`drizzle/pg/` and regenerating a clean `0000_init`.

Spot-check the generated SQL contains: `jsonb` for the five JSON columns,
`boolean` for the four flag columns, `double precision` for `cost_usd`,
`GENERATED ALWAYS AS IDENTITY` on `messaging_messages.id`, and the partial
`CREATE UNIQUE INDEX … WHERE active`.

## 3. `tests/state/schema-parity.test.ts`

The structural drift guard: add a column/index to one schema and forget the
other → this fails with a readable message. Technique lifted from finius's
`tests/schema-cross-parity.test.ts` — `getTableConfig` from **both** cores,
normalize to a dialect-independent shape, deep-equal. It deliberately does
**NOT compare column types**: jsonb-vs-text, boolean-vs-integer,
doublePrecision-vs-real, and identity-vs-autoincrement divergence is the
point of this phase.

```ts
import { describe, expect, it } from "vitest";
import { getTableConfig as sqliteTableConfig } from "drizzle-orm/sqlite-core";
import { getTableConfig as pgTableConfig } from "drizzle-orm/pg-core";
import * as sqliteSchema from "../../src/state/schema/sqlite.js";
import * as pgSchema from "../../src/state/schema/pg.js";

const TABLES = [
  "executions", "workflowRuns", "cronOverrides", "workflowOverrides",
  "workflowApprovals", "messagingSessions", "messagingMessages",
] as const;
```

Compare, per table (sorted so ordering never matters):

- **table name** (`cfg.name`);
- **columns**: `{ name, notNull, primary }` — names give "column X exists
  in sqlite but not pg" failures for free via `toEqual` diffs, but also add
  an explicit set-difference assertion with a hand-built message
  (`expect(missingInPg, \`columns in sqlite but not pg: …\`).toEqual([])`
  and the mirror) so the failure reads instantly;
- **PK membership**: single-column PKs come through `column.primary`;
  composite `cfg.primaryKeys` (none today, but compare anyway);
- **indexes**: `{ name, unique: i.config.unique, columns, partial:
  Boolean(i.config.where) }` — name + uniqueness + partial-WHERE
  *presence*, not the WHERE text (`active = 1` vs `active` is fine).
  Note: `.desc()` index entries surface as `IndexedColumn`, so extract
  names with a `(c as { name?: string }).name ?? String(c)` fallback like
  finius's `colName`;
- **FKs** (`cfg.foreignKeys` → local/foreign column names — guards the
  `messaging_messages.session_id` reference);
- **module export sets**: `Object.keys(sqliteSchema)` vs `pgSchema` — only
  compare *table* exports if `sqlite.ts` also exports types/helpers;
  filter with `is(v, Table)` (`import { is } from "drizzle-orm"; import
  { Table } from "drizzle-orm";`) rather than assuming bare key equality.

Explicitly assert what is NOT compared in a comment block at the top of the
file, so a future agent doesn't "fix" it.

## 4. `tests/state/db.pg.test.ts`

The behavioral proof — the *same* Phase-3 suite, PG dialect:

```ts
import { describe } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { fileURLToPath } from "node:url";
import { asStateClient } from "../../src/state/client.js";
import { StateDb } from "../../src/state/db.js";
import { runStateDbSuite } from "./store-suite.js";

const MIGRATIONS = fileURLToPath(new URL("../../drizzle/pg", import.meta.url));

async function makePgStateDb(): Promise<StateDb> {
  // int8 (OID 20) → number: PG returns COUNT(*)/SUM as int8, and the
  // pg-types default surfaces it as a STRING. finius fixes this with
  // types.setTypeParser(20, Number) on node-postgres; the PGlite
  // equivalent is the `parsers` constructor option. Without this, the
  // stats-rollup assertions fail with "3" !== 3.
  const pglite = new PGlite({ parsers: { 20: (v: string) => Number(v) } });
  const db = drizzle(pglite);
  await migrate(db, { migrationsFolder: MIGRATIONS });
  return StateDb.fromClient(asStateClient(db), "postgres");
}

describe("StateDb on PGlite (postgres dialect)", () => {
  runStateDbSuite(makePgStateDb, { dialect: "postgres" });
});
```

(Adapt the exact `makeDb` signature to what Phase 3 shipped — if the suite
expects a teardown, close the PGlite handle there: `await pglite.close()`.)

**Lifecycle — fresh PGlite per test (recommended).** The `makeDb` contract
from Phase 3 is a pristine DB per call (the sqlite leg hands out `:memory:`
per test), and reusing one PGlite across tests would leak identity-sequence
positions, `__drizzle_migrations` rows, and any test data — silently
weakening the suite. Cost is acceptable: the WASM module is compiled once
per worker process and cached, so only the *first* `new PGlite()` pays the
~1s init; subsequent in-memory instances are ~100ms, and the whole file
runs in its own vitest worker (default forks pool) in parallel with the
rest of the suite. If the file ever exceeds ~60s, the escape hatch is one
PGlite per file with `DROP SCHEMA public CASCADE; CREATE SCHEMA public;` +
re-migrate per test — but re-migration dominates that path's cost, so the
win is small; stay per-test unless measured otherwise.

**Cross-dialect bucket-key assertion.** Add one extra test in this file
(outside/alongside the suite): build a sqlite `StateDb` and a PG `StateDb`,
insert the *same fixed ISO fixtures* (e.g. executions at
`2026-01-05T09:15:00.000Z`, `2026-01-05T17:45:00.000Z`,
`2026-01-06T00:01:00.000Z`), and assert `dailyStats()` / `hourlyStats()`
return **identical bucket keys AND counts** on both — deep-equal the two
result arrays. This pins the `dayBucket()`/`hourBucket()` `substr`-on-ISO
design: if anyone reintroduces `date()`/`strftime`/`date_trunc`, this test
names the divergence.

## 5. `StateDb.open` URL guard

In `src/state/db.ts`, `open()` gains a first-line check (before the
path/URL normalization from locked decision 9):

```ts
if (/^postgres(ql)?:\/\//i.test(url)) {
  throw new Error(
    "PG runtime not enabled; sqlite is the supported production store. " +
    "Postgres is test-only via StateDb.fromClient(asStateClient(db), \"postgres\").",
  );
}
```

This is what keeps `pg`/PGlite out of runtime dependencies: `open()` never
constructs a PG client, so no runtime module imports a PG driver, and a
misconfigured `DATABASE_URL` (Phase 5 adds the slot) fails loudly at boot
instead of half-working. Add a small test for the throw (message
substring) — it can live in the existing `db` test file or `db.pg.test.ts`.

## 6. package.json + CI

- `npm i -D @electric-sql/pglite` — devDependency, latest stable. Nothing
  under `dependencies`; `src/state/schema/pg.ts` imports only
  `drizzle-orm/pg-core` (drizzle-orm is already a runtime dep from Phase 1),
  so shipping pg.ts in `dist/` is harmless.
- Guard the boundary: `grep -rn "schema/pg\|@electric-sql/pglite\|drizzle-orm/pglite" src/`
  must hit only `src/state/schema/pg.ts` itself (and nothing importing it).
  Importers live in `tests/` + `drizzle-pg.config.ts` only.
- **CI: no pipeline change.** Both legs are ordinary `tests/**/*.test.ts`
  files picked up by the existing `npx vitest run` glob
  (`vitest.config.ts`). PGlite is pure WASM — no postgres service, no
  docker, no opt-in env var.

## Expected dialect leaks the suite will surface

These are the *known* divergences the seam exists for. If the PGlite leg
fails, check this list before suspecting PGlite (it is real Postgres):

- **`changes()` shape** — libsql `.rowsAffected` vs PGlite
  `.affectedRows` / node-postgres `.rowCount`. Every compare-and-set guard
  (`changes(result) !== 1 → throw/return false`) exercises this; a miss
  shows up as approval/reply-gate tests failing with `undefined !== 1`.
- **`rows()` shape** — libsql raw results vs PG's `{ rows, fields }`
  wrapper. Any `sql`-template query that bypassed `rows()` returns the
  wrapper object instead of an array on PG.
- **Missed `= 1` boolean literal** — PG errors loudly (`operator does not
  exist: boolean = integer`) on any `success = 1` / `active = 1` /
  `enabled = 1` fragment that escaped the Phase 2b port. Loud is good;
  fix the query (truthiness `CASE WHEN ${col} THEN …` / `eq(col, true)`),
  never the schema.
- **`LIKE … ESCAPE '\'`** — supported in both dialects, but PG LIKE is
  case-sensitive where SQLite's isn't; `searchErrors` must be on the
  `lower(col) LIKE lower(pattern) ESCAPE '\'` form from the hotspot table.
- **Identity insert** — `GENERATED ALWAYS` rejects an explicit
  `messaging_messages.id`; sqlite autoincrement silently accepted one. Any
  store code or suite fixture supplying an id fails here — fix the caller
  (inserts never supply an id).
- **int8-as-string** — `COUNT(*)` / `SUM(...)` come back as strings via the
  pg-types defaults. Canonical fix is the PGlite `parsers: { 20: Number }`
  option shown above (finius: `types.setTypeParser(20, Number)` in its
  client). Also record the requirement in `asStateClient()`'s doc comment
  in `client.ts` — the cast can't enforce it, so any future PG client
  handed to `fromClient` must normalize int8 itself. If flakiness appears
  anyway (e.g. `AVG` → numeric OID 1700), a defensive `Number()` coercion
  in `dialect.ts`'s aggregate helpers is acceptable — but prefer the
  parser at the source.
- **NULL ordering / GROUP BY strictness** — PG sorts NULLs last on `ASC`
  (sqlite: first) and rejects selecting non-aggregated columns absent from
  `GROUP BY` (sqlite: lax). Ordering tests on nullable columns
  (`finished_at`) and any lax rollup query surface here.

## Verification

```bash
npm run build && npx vitest run          # whole suite: sqlite leg + PG leg + parity
npx vitest run tests/state/              # focused: both legs + parity together
npm run db:generate:pg && git status     # regeneration is a no-op (deterministic)
grep -rn "schema/pg\|pglite" src/ --include='*.ts' | grep -v "src/state/schema/pg.ts"
                                         # → empty: pg schema not in the runtime import graph
```

Plus: `npm run typecheck:test`, and confirm the parity test *fails
correctly* once — temporarily add a throwaway column to `pg.ts`, watch the
"exists in pg but not sqlite" message, revert.

## Risk watch-items

- **PGlite failures are genuine dialect bugs.** PGlite is real Postgres
  compiled to WASM, not an emulation — do not "fix" a red PG test by
  loosening the assertion; fix the query or the seam.
- **jsonb normalization vs sqlite text round-trip.** jsonb canonicalizes
  key order, strips duplicate keys and whitespace; sqlite `{mode:'json'}`
  round-trips the exact serialized text. Any suite assertion comparing
  *raw stored JSON strings* (or key order) diverges — always compare
  parsed values with `toEqual`. Audit the Phase-3 suite for string-level
  JSON comparisons before blaming the schema.
- **Schema drift after this phase.** Any later sqlite.ts change must be
  mirrored in pg.ts + `db:generate:pg` re-run. The parity test catches
  structure; it deliberately cannot catch a *type-level* mistake (e.g.
  forgetting `$type<T>` on a jsonb column — that surfaces as a store
  compile error or a PG-leg behavioral failure instead).
- **drizzle-orm/pglite version coupling.** The `drizzle-orm/pglite` driver
  and migrator ship inside the pinned stable drizzle-orm; if the PGlite
  devDep major-bumps, re-check drizzle's peer range before upgrading.
- **Suite runtime.** Watch the PG file's wall time in CI output; the
  per-file escape hatch above exists if per-test instances ever hurt.

## Done criteria

- [ ] `src/state/schema/pg.ts` mirrors `sqlite.ts` — 7 tables, identical
      export/property/column/index names; jsonb + boolean + identity +
      doublePrecision mappings applied; identical `$type<T>` params.
- [ ] `drizzle-pg.config.ts` + `db:generate:pg` script added;
      `drizzle/pg/0000_init.sql` + `meta/` committed, purely generated.
- [ ] `tests/state/schema-parity.test.ts` green; compares names /
      nullability / PKs / index name+unique+partial / FKs; excludes types;
      failure messages name the missing column and side.
- [ ] `tests/state/db.pg.test.ts` green: fresh PGlite per test → pg
      migrator → `StateDb.fromClient(..., "postgres")` → full
      `runStateDbSuite`, plus the cross-dialect stats bucket-key test.
- [ ] `StateDb.open("postgres://…")` throws the "PG runtime not enabled"
      error; covered by a test.
- [ ] `@electric-sql/pglite` in devDependencies only; no runtime module
      imports `schema/pg.ts` or any PG driver.
- [ ] `npm run build && npx vitest run` green — both dialect legs in the
      one run (that IS the CI wiring; no pipeline change).
- [ ] README checkbox ticked; deviations recorded below.
