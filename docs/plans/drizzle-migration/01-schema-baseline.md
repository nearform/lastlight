# Phase 1 — Deps, sqlite schema, idempotent baseline, schema-equivalence proof

Risk: **low**. Read [README.md](README.md) and [00-architecture.md](00-architecture.md)
first — this doc assumes their locked decisions (libsql driver, json/boolean
column modes, hand-edited idempotent baseline).

## Goal

Introduce Drizzle into the repo **without touching any runtime code path**:
install the dependencies, write the complete `sqliteTable` schema for all
seven tables (five state + two messaging), generate the `0000_baseline.sql`
migration and hand-edit it to full idempotency, and prove — mechanically, in
a test — that the Drizzle-migrated schema is equivalent to what the legacy
`migrate()` + `SessionManager` DDL produces today. This phase is the only
window in which both drivers coexist with the legacy DDL still live, so the
schema-equivalence test is the key deliverable: it is the proof that Phase 2b
can swap engines under a database whose shape is byte-for-byte accounted for.

## Preconditions

None — this is the first phase. The repo must be green before starting:
`npm run build && npx vitest run` passes on a clean checkout of `main`.

## Files created / modified

| File | Change |
|---|---|
| `package.json` | deps: `drizzle-orm`, `@libsql/client`; devDep: `drizzle-kit`; script `db:generate:sqlite` |
| `package-lock.json` | npm install side effect |
| `src/state/schema/sqlite.ts` | **new** — all 7 tables, all 12 indexes |
| `drizzle-sqlite.config.ts` | **new** — repo root, drizzle-kit config |
| `drizzle/sqlite/0000_baseline.sql` | **new** — generated, then hand-edited |
| `drizzle/sqlite/meta/_journal.json` + `meta/0000_snapshot.json` | **new** — generated, committed as-is |
| `tests/state/schema-equivalence.test.ts` | **new** — the proof artifact |

Nothing else. No store, no `db.ts`, no `migrate.ts` changes — the legacy path
stays the production path until Phase 2b.

## Step 1 — Dependencies

```bash
npm i drizzle-orm @libsql/client
npm i -D drizzle-kit
```

Pin the latest **stable** lines (locked decision 5 — the finius reference is
on a v1.0.0-rc; do NOT copy that). At planning time that meant approximately
`drizzle-orm ^0.44`, `drizzle-kit ^0.31`, `@libsql/client ^0.15` — check npm
at execution time and take the newest non-RC. Add to `package.json` scripts
(currently `package.json:48-61`):

```json
"db:generate:sqlite": "drizzle-kit generate --config drizzle-sqlite.config.ts"
```

Note `tsconfig.json` includes only `src/**/*`, so the root-level
`drizzle-sqlite.config.ts` is not compiled by `npm run build` — drizzle-kit
loads it with its own loader. No tsconfig change needed.

## Step 2 — `src/state/schema/sqlite.ts`

Source of truth for the shape: `src/state/migrate.ts` (all of it — the
CREATEs at lines 17-88 **plus** every historical `ALTER TABLE ADD COLUMN` at
lines 92-169 and the late index at line 172) and
`src/connectors/messaging/session-manager.ts:21-69` (messaging tables +
indexes + the partial unique index). Transcribe faithfully:

- **Column declaration order must match the legacy physical order** — CREATE
  columns first, then the ALTER-added columns in the order migrate.ts adds
  them. drizzle-kit emits columns in declaration order and the equivalence
  test compares `PRAGMA table_info` in cid order.
- **Index names must match exactly** (legacy names below) — the test compares
  `sqlite_master` index rows by name.
- Timestamps stay `text()` (ISO-8601), booleans `integer({ mode: "boolean" })`,
  JSON columns `text({ mode: "json" }).$type<T>()` per 00-architecture.md.
  Neither mode changes the emitted DDL (still `text` / `integer`), so the
  equivalence test is unaffected by these typings.

### JSON-column audit (verdicts, with evidence)

| Column | Verdict | Evidence |
|---|---|---|
| `workflow_runs.phase_history` | **json**, `$type<PhaseHistoryEntry[]>`, notNull, default `'[]'` | parsed `workflow-run-store.ts:138,358`; stringified `:142`; DDL default `migrate.ts:43` |
| `workflow_runs.context` | **json**, `$type<Record<string, unknown>>` | stringified `workflow-run-store.ts:95`; parsed `:360`; `json_patch` consumer `:302` |
| `workflow_runs.scratch` | **json**, `$type<Record<string, unknown>>` | parsed `workflow-run-store.ts:117,361`; stringified `:121` |
| `executions.extension_status` | **json**, `$type<ExtensionStatusMap>` | holds JSON, but parse/stringify sit *outside* the store: stringified `src/workflows/phase-executor.ts:339`, parsed `src/admin/routes.ts:927` (`parseJsonColumn`, `routes.ts:124`). Store passes it through as an opaque string (`execution-store.ts:40,184,596`) |
| `executions.skills_status` | **json**, `$type<SkillsStatus>` | same pattern: `phase-executor.ts:340`, `routes.ts:928`, `execution-store.ts:46,185,597` |
| `workflow_approvals.artifact` | **plain `text()`** | it is a filename (`'architect-plan.md'`), never JSON — `approval-store.ts:19` types it `string`, `:59` binds it raw, `:183` reads it raw; intent documented at `migrate.ts:116-118` |

The `extension_status` / `skills_status` verdict means Phase 2b must also
drop the `JSON.stringify` at `phase-executor.ts:339-340` and the
`parseJsonColumn` calls at `routes.ts:927-928`, and retype
`ExecutionRecord.extensionStatus` / `.skillsStatus` from `string` to the
object types — record that as a forward note; do **not** touch those files
in this phase. Type imports (type-only, so no runtime coupling):
`ExtensionStatusMap` / `SkillsStatus` from `../../engine/github/profiles.js`
(`profiles.ts:142,170`); `PhaseHistoryEntry` from `../workflow-run-store.js`
(`workflow-run-store.ts:4-9`). Remember `.js` extensions (Node16 resolution).

### `executions` (full snippet)

Legacy DDL: `migrate.ts:18-31`; ALTERs `:128` (session_id) and the loop at
`:136-169`; indexes `:33-34,172`.

```ts
import { index, integer, real, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
import { sql } from "drizzle-orm";
import type { PhaseHistoryEntry } from "../workflow-run-store.js";
import type { ExtensionStatusMap, SkillsStatus } from "../../engine/github/profiles.js";

export const executions = sqliteTable(
  "executions",
  {
    id: text("id").primaryKey(),
    triggerType: text("trigger_type").notNull(),
    triggerId: text("trigger_id").notNull(),
    skill: text("skill").notNull(),
    repo: text("repo"),
    issueNumber: integer("issue_number"),
    startedAt: text("started_at").notNull(),
    finishedAt: text("finished_at"),
    success: integer("success", { mode: "boolean" }),   // nullable tri-state
    error: text("error"),
    turns: integer("turns"),
    durationMs: integer("duration_ms"),
    // ── historical ALTERs, in migrate.ts order ──
    sessionId: text("session_id"),
    costUsd: real("cost_usd"),
    inputTokens: integer("input_tokens"),
    cacheCreationInputTokens: integer("cache_creation_input_tokens"),
    cacheReadInputTokens: integer("cache_read_input_tokens"),
    outputTokens: integer("output_tokens"),
    apiDurationMs: integer("api_duration_ms"),
    stopReason: text("stop_reason"),
    workflowRunId: text("workflow_run_id"),
    outputText: text("output_text"),
    extensionStatus: text("extension_status", { mode: "json" }).$type<ExtensionStatusMap>(),
    skillsStatus: text("skills_status", { mode: "json" }).$type<SkillsStatus>(),
  },
  (t) => [
    index("idx_executions_trigger").on(t.triggerType, t.triggerId),
    index("idx_executions_skill").on(t.skill, t.startedAt),
    index("idx_executions_workflow_run").on(t.workflowRunId, t.skill),
  ],
);
```

### `workflow_runs`

Legacy DDL `migrate.ts:36-49`; ALTERs `:93` (scratch), `:102` (restart_count);
indexes `:50-57`.

| property | column | builder |
|---|---|---|
| id | `id` | `text().primaryKey()` |
| workflowName | `workflow_name` | `text().notNull()` |
| triggerId | `trigger_id` | `text().notNull()` |
| repo | `repo` | `text()` |
| issueNumber | `issue_number` | `integer()` |
| currentPhase | `current_phase` | `text().notNull()` |
| phaseHistory | `phase_history` | `text({mode:"json"}).$type<PhaseHistoryEntry[]>().notNull().default(sql\`'[]'\`)` |
| status | `status` | `text().notNull().default("running")` |
| context | `context` | `text({mode:"json"}).$type<Record<string, unknown>>()` |
| startedAt | `started_at` | `text().notNull()` |
| updatedAt | `updated_at` | `text().notNull()` |
| finishedAt | `finished_at` | `text()` |
| scratch | `scratch` | `text({mode:"json"}).$type<Record<string, unknown>>()` |
| restartCount | `restart_count` | `integer().notNull().default(0)` |

Indexes: `index("idx_workflow_runs_trigger").on(t.triggerId, t.status)`,
`index("idx_workflow_runs_status").on(t.status)`,
`index("idx_workflow_runs_started_at").on(sql\`${t.startedAt} DESC\`)` — this
one is **DESC** (`migrate.ts:56`); if the installed drizzle version supports
`.on(t.startedAt.desc())`, prefer that form —
`index("idx_workflow_runs_name_started").on(t.workflowName, <started_at DESC>)`
(`migrate.ts:57`, second key also DESC).

### `cron_overrides` / `workflow_overrides`

Legacy DDL `migrate.ts:59-65` / `:67-72`. No indexes. Identical shape except
`schedule` exists only on `cron_overrides`: `name` `text().primaryKey()`;
`enabled` `integer({mode:"boolean"}).notNull().default(true)` (legacy
`DEFAULT 1`); `schedule` `text()` (cron only); `updatedAt` `text("updated_at").notNull()`;
`updatedBy` `text("updated_by")`.

### `workflow_approvals`

Legacy DDL `migrate.ts:74-85`; ALTERs `:111` (kind), `:120` (artifact);
indexes `:86-87`.

| property | column | builder |
|---|---|---|
| id | `id` | `text().primaryKey()` |
| workflowRunId | `workflow_run_id` | `text().notNull()` |
| gate | `gate` | `text().notNull()` |
| summary | `summary` | `text().notNull()` |
| status | `status` | `text().notNull().default("pending")` |
| requestedBy | `requested_by` | `text()` |
| respondedBy | `responded_by` | `text()` |
| response | `response` | `text()` |
| respondedAt | `responded_at` | `text()` |
| createdAt | `created_at` | `text().notNull()` |
| kind | `kind` | `text().notNull().default("approve")` |
| artifact | `artifact` | `text()` — plain text per audit above |

Indexes: `index("idx_approvals_workflow").on(t.workflowRunId)`,
`index("idx_approvals_status").on(t.status)`.

### `messaging_sessions` (full snippet)

Legacy DDL `session-manager.ts:22-33`; indexes `:44-45` and the partial
unique index `:66-69`. Note `message_count` and `active` are **nullable**
(no NOT NULL in the legacy DDL) — transcribe that, don't "fix" it.

```ts
export const messagingSessions = sqliteTable(
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
    active: integer("active", { mode: "boolean" }).default(true),
  },
  (t) => [
    index("idx_msg_sessions_lookup").on(t.platform, t.channelId, t.threadId, t.userId),
    // "one active session per key" — partial unique (session-manager.ts:50-69)
    uniqueIndex("idx_msg_sessions_unique_active")
      .on(t.platform, t.channelId, t.threadId, t.userId)
      .where(sql`active = 1`),
  ],
);
```

Keep the WHERE clause as the literal `sql\`active = 1\`` so the emitted text
matches the legacy index (`session-manager.ts:68`).

### `messaging_messages`

Legacy DDL `session-manager.ts:35-42`; index `:46-47`. Columns: `id`
`integer().primaryKey({ autoIncrement: true })`; `sessionId`
`text("session_id").notNull().references(() => messagingSessions.id)`;
`role` `text().notNull()`; `content` `text().notNull()`; `timestamp`
`text().notNull()`; `platformMessageId` `text("platform_message_id")`.
Index: `index("idx_msg_messages_session").on(t.sessionId, t.timestamp)`.

Index tally: 3 (executions) + 4 (workflow_runs) + 2 (approvals) + 3
(messaging_sessions incl. the partial unique) + 1 (messaging_messages) =
**12 named indexes**, one of them partial-unique, two with DESC keys.

## Step 3 — drizzle-kit config + baseline generation

`drizzle-sqlite.config.ts` (repo root; shape after
`/Users/clifton/Documents/finius/drizzle.config.ts`, minus the RC pin):

```ts
import { defineConfig } from "drizzle-kit";

export default defineConfig({
  dialect: "sqlite",
  schema: "./src/state/schema/sqlite.ts",
  out: "./drizzle/sqlite",
});
```

Generate: `npx drizzle-kit generate --config drizzle-sqlite.config.ts --name baseline`
→ `drizzle/sqlite/0000_baseline.sql` + `drizzle/sqlite/meta/{_journal.json,
0000_snapshot.json}`. Commit meta/ untouched.

**Hand-edit `0000_baseline.sql`** (keep the `--> statement-breakpoint`
separators intact — the migrator splits on them):

1. Every `CREATE TABLE` → `CREATE TABLE IF NOT EXISTS`; every
   `CREATE INDEX` / `CREATE UNIQUE INDEX` → `... IF NOT EXISTS`.
2. If drizzle-kit emitted boolean defaults as `DEFAULT true` / `DEFAULT false`,
   rewrite them to `DEFAULT 1` / `DEFAULT 0` (matches legacy DDL text; both
   are valid SQLite, but keeping the legacy literal makes `PRAGMA table_info`
   diffs trivially clean).
3. Prepend this header comment (required):

```sql
-- HAND-EDITED BASELINE — do not regenerate over this file.
-- Hand-editing a drizzle migration is an anti-pattern EXCEPT exactly here:
-- this is a baseline over a journal-less legacy production DB
-- (lastlight.db, previously migrated by src/state/migrate.ts +
-- SessionManager's inline DDL, with no __drizzle_migrations table).
-- Every statement carries IF NOT EXISTS so the file is a strict no-op on an
-- existing DB; the migrator then records it in __drizzle_migrations and all
-- FUTURE migrations are generated normally and never hand-edited.
-- Frozen once shipped: never edit after any DB (incl. prod) has applied it.
```

The `IF NOT EXISTS` edits change the SQL the migrator hashes/applies but not
the meta snapshot, which is what future `drizzle-kit generate` diffs against
— so subsequent migrations are unaffected by the hand-edit.

## Step 4 — `tests/state/schema-equivalence.test.ts`

The proof artifact, only possible while both drivers coexist. Structure:

- **Leg A (legacy)**: `new Database(":memory:")` (better-sqlite3) →
  `migrate(db)` from `src/state/migrate.ts` → `new SessionManager(db)` (its
  constructor runs the messaging DDL, `session-manager.ts:15-18`).
- **Leg B (drizzle)**: `createClient({ url: ":memory:" })` from
  `@libsql/client` → `drizzle(client)` → `migrate(db, { migrationsFolder:
  "drizzle/sqlite" })` from `drizzle-orm/libsql/migrator`.

Extract from each leg and deep-equal after normalization:

1. **Table list**: `SELECT name FROM sqlite_master WHERE type='table'`,
   excluding `sqlite_%` and `__drizzle_migrations` (and their autoindexes).
   Must be exactly the 7 tables.
2. **Columns**: per table, `PRAGMA table_info(<t>)` in cid order, normalized
   to `{ name, type: upper, notNull: notnull === 1 || pk > 0, dflt:
   normalizeDefault(dflt_value), pk: pk > 0 }`. The `|| pk > 0` matters:
   legacy `id TEXT PRIMARY KEY` reports `notnull=0` (SQLite's nullable-PK
   quirk) while drizzle emits `PRIMARY KEY NOT NULL` — semantically a
   tightening we accept, normalized away here. `normalizeDefault` trims,
   lowercases bare keywords, and maps `true`→`1` / `false`→`0`.
3. **Indexes**: `SELECT name, tbl_name, sql FROM sqlite_master WHERE
   type='index' AND sql IS NOT NULL` (auto PK indexes have NULL sql and are
   excluded on both legs). Normalize sql: lowercase, strip `` ` ``/`"`/`[]`
   quoting, collapse whitespace, drop `if not exists`. Compare as a map
   keyed by index name — this covers the DESC keys and the partial index's
   `WHERE active = 1` clause verbatim.
4. **Foreign keys**: per table, `PRAGMA foreign_key_list(<t>)` normalized to
   `{ from, table, to, onUpdate, onDelete }` — pins the
   `messaging_messages.session_id → messaging_sessions.id` FK.

(libsql is async: read Leg B's pragmas via `client.execute("PRAGMA ...")`
— same result shape, rows as objects.)

Additional assertions in the same file:

- **Migrator twice is a no-op**: run the drizzle migrator a second time on
  Leg B; it must not throw, `__drizzle_migrations` still has exactly one
  row, and the extracted schema is unchanged.
- **Migrator on a legacy-shaped DB (prod shape)**: `fs.mkdtempSync` a temp
  dir, create `legacy.db` via better-sqlite3 + legacy `migrate()` +
  `new SessionManager(...)`, insert one `executions` row and one
  `messaging_sessions` row, close. Reopen with
  `createClient({ url: "file:" + path })`, run the drizzle migrator: it must
  succeed (every baseline statement no-ops), the seeded rows must still be
  readable, and `__drizzle_migrations` must exist with one row.

Because `{mode:'json'}` / `{mode:'boolean'}` don't change emitted DDL (still
TEXT / INTEGER), none of the typing decisions above can affect this test —
equivalence is purely about the SQL shape.

## Verification

```bash
npm run build            # tsc green; schema file compiles under strict
npx vitest run           # full suite green, incl. the new equivalence test
git diff --stat          # confirms no runtime source file changed
                         # (src/ delta = schema/sqlite.ts only)
```

Dashboard tsc not needed (no admin routes touched).

## Risk watch-items

- **Column order / default mismatches** — caught mechanically by the test's
  cid-order comparison. Fix by reordering declarations in `schema/sqlite.ts`
  and regenerating (pre-freeze, regenerating + re-hand-editing is fine).
- **Drizzle default-value quoting** — `DEFAULT 'running'` vs `"running"`,
  `true` vs `1`. The hand-edit (step 3.2) plus `normalizeDefault` cover the
  known cases; any residue shows up as a test diff, not silent drift.
- **Index name or DESC mismatches** — drizzle-kit uses exactly the names in
  the schema file; a typo surfaces as a missing/extra key in the index map.
  Verify `idx_workflow_runs_started_at` really carries `DESC` in the emitted
  sql; keep the `sql\`\`` key form if the builder form drops it.
- **PK NOT NULL tightening** — expected divergence, normalized in the test
  (step 4.2); do not "fix" the schema to make PKs nullable.
- **libsql `:memory:`** — `createClient({ url: ":memory:" })` is
  per-connection in-memory, matching the better-sqlite3 test posture
  (`src/state/db.ts:66-73`). Don't use a shared file path in tests.

## Done criteria

- [ ] `drizzle-orm` + `@libsql/client` in dependencies, `drizzle-kit` in
      devDependencies — all latest stable, no RC pins.
- [ ] `db:generate:sqlite` script in package.json.
- [ ] `src/state/schema/sqlite.ts` defines all 7 tables, 12 indexes (incl.
      the partial unique + both DESC indexes), with the JSON/boolean mode
      decisions recorded above.
- [ ] `drizzle/sqlite/0000_baseline.sql` exists, fully `IF NOT EXISTS`-
      idempotent, with the required header comment; `meta/` committed.
- [ ] `tests/state/schema-equivalence.test.ts` green: legacy vs drizzle
      schema equal after normalization; migrator-twice no-op; migrator
      succeeds on a legacy-seeded file DB with data intact.
- [ ] `npm run build && npx vitest run` green; no runtime code path changed.
- [ ] README.md Phase 1 checkbox ticked; deviations (if any) appended below.
