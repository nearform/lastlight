# Phase 1 — Deps, sqlite schema, idempotent baseline, schema-equivalence proof

Risk: **low**. Read [README.md](README.md) and [00-architecture.md](00-architecture.md)
first — this doc assumes their locked decisions (libsql driver, json/boolean
column modes, hand-edited idempotent baseline).

## Goal

Introduce Drizzle into the repo **without touching any runtime code path**:
install the dependencies, write the complete `sqliteTable` schema for all
fifteen tables (thirteen state + two messaging), generate the `0000_baseline.sql`
migration and hand-edit it to full idempotency, and prove — mechanically, in
a test — that the Drizzle-migrated schema is equivalent to what the legacy
`migrate()` + `SessionManager` DDL produces today. This phase is the only
window in which both drivers coexist with the legacy DDL still live, so the
schema-equivalence test is the key deliverable: it is the proof that Phase 2b
can swap engines under a database whose shape is byte-for-byte accounted for.

## Execution strategy (added 2026-08-18 — locked decision 16)

Transcribing 15 tables is the one genuinely parallelisable job in this
migration. Fan out the **transcription**, keep the **judgement** serial.

**Fan out — 4 agents, one per group.** Each gets the same brief: read the DDL
at the cited lines, emit a `sqliteTable` definition, preserve physical column
order and exact index names, apply the JSON/boolean verdicts from this doc, and
change nothing else.

| Agent | Tables | Why grouped |
|---|---|---|
| A | `cron_overrides`, `workflow_overrides`, `workflow_approvals`, `cron_runs`, `users` | Plain shapes. `users` needs 3 column-level `UNIQUE`s + 3 named indexes (two redundant with autoindexes — declare both) |
| B | `feedback_anchors`, `feedback_signals` | The two **table-level `UNIQUE`** constraints, the `channel = ''` sentinel, and 8 indexes incl. 2 DESC |
| C | `github_teams`, `github_team_repos`, `github_team_members`, `github_visibility_sync` | All three **composite PKs** live here — one agent so the `primaryKey({columns})` idiom is applied consistently |
| D | `messaging_sessions`, `messaging_messages` | The **partial unique index**, the only FK, the only AUTOINCREMENT, and the nullable-with-default oddities |

**Keep serial — do these yourself, in this order:**

1. **`executions` + `workflow_runs`.** The two largest (26 and 19 columns),
   both with long ALTER histories, and **both carrying the `owner` cid-order
   trap** (see the ⚠ block below). Do not delegate these.
2. **Reconcile + generate.** Assemble `schema/sqlite.ts`, run
   `db:generate:sqlite`, hand-edit `0000_baseline.sql` to full `IF NOT EXISTS`
   idempotency, add the required header comment.
3. **The equivalence test.** This is the phase's whole deliverable and the
   `owner` trap lands squarely on it — the legacy-shaped leg must compare
   columns **by name**, not cid order. Writing it is the judgement call the
   fan-out exists to buy you time for.

Cheap correctness check before generating: the schema file should total
**15 tables and 25 named indexes**, with **5 DESC keys**, **1 partial unique
index**, **1 FK**, and **3 composite PKs**. If any count is off, a group came
back wrong.

## Preconditions

None — this is the first phase. The repo must be green before starting:
`pnpm --filter lastlight-core build && pnpm --filter lastlight-core test`
passes on a clean checkout of `main`.

## Files created / modified

| File | Change |
|---|---|
| `apps/server/package.json` | deps: `drizzle-orm`, `@libsql/client`; devDep: `drizzle-kit`; script `db:generate:sqlite` |
| `pnpm-lock.yaml` | pnpm install side effect (repo-root, one lockfile for the workspace) |
| `apps/server/src/state/schema/sqlite.ts` | **new** — all 15 tables, all 25 named indexes |
| `apps/server/drizzle-sqlite.config.ts` | **new** — `apps/server/` package root, drizzle-kit config |
| `apps/server/drizzle/sqlite/0000_baseline.sql` | **new** — generated, then hand-edited |
| `apps/server/drizzle/sqlite/meta/_journal.json` + `meta/0000_snapshot.json` | **new** — generated, committed as-is |
| `apps/server/tests/state/schema-equivalence.test.ts` | **new** — the proof artifact |

Nothing else. No store, no `db.ts`, no `migrate.ts` changes — the legacy path
stays the production path until Phase 2b.

## Step 1 — Dependencies

```bash
pnpm --filter lastlight-core add drizzle-orm @libsql/client
pnpm --filter lastlight-core add -D drizzle-kit
```

Pin the latest **stable** lines (locked decision 5 — the finius reference is
on a v1.0.0-rc; do NOT copy that). At last verification (2026-07-09) that
meant `drizzle-orm ^0.45` (0.45.2 — note `^0.44` would never resolve to it),
`drizzle-kit ^0.31` (0.31.10), `@libsql/client ^0.17` (0.17.4); drizzle v1
was still RC-only (`1.0.0-rc.4`). Check npm at execution time and take the
newest non-RC. Add to `apps/server/package.json` scripts
(currently `package.json` ≈48-61):

```json
"db:generate:sqlite": "drizzle-kit generate --config drizzle-sqlite.config.ts"
```

Note `apps/server/tsconfig.json` includes only `src/**/*`, so the
package-root `drizzle-sqlite.config.ts` is not compiled by
`pnpm --filter lastlight-core build` — drizzle-kit loads it with its own
loader. No tsconfig change needed.

## Step 2 — `apps/server/src/state/schema/sqlite.ts`

Source of truth for the shape: `apps/server/src/state/migrate.ts` (all of it
— the CREATEs at ≈17-112 including the `users` table **plus** every
historical `ALTER TABLE ADD COLUMN` at ≈120-232 and the late index at ≈235)
and `apps/server/src/connectors/messaging/session-manager.ts` ≈21-69
(messaging tables + indexes + the partial unique index). Transcribe
faithfully:

- **Column declaration order must match the legacy physical order** — CREATE
  columns first, then the ALTER-added columns in the order migrate.ts adds
  them. drizzle-kit emits columns in declaration order and the equivalence
  test compares `PRAGMA table_info` in cid order.

> ### ⚠ The `owner` column-order divergence — read before writing the test
>
> **A fresh database and production do NOT have the same physical column
> order, and no schema file can satisfy both.** `migrate.ts` runs
> `ALTER TABLE ... ADD COLUMN owner TEXT` for `workflow_runs` (≈343) and
> `executions` (≈400) — but **`owner` is already in both CREATE bodies**
> (`executions` cid 4, `workflow_runs` cid 3). So:
>
> - **Fresh DB**: the CREATE wins, the ALTER throws, the `catch {}` swallows
>   it, and `owner` sits **mid-table**.
> - **Upgraded prod DB**: the column predates the CREATE-body change, so the
>   ALTER genuinely appended it and `owner` sits **at the tail**.
>
> Consequences, all load-bearing:
>
> 1. **Declare the FRESH order** in `schema/sqlite.ts` (`owner` mid-table).
>    That is what a new Drizzle-managed DB gets and what drizzle-kit diffs
>    against.
> 2. **Column order is NOT a correctness property.** Drizzle addresses columns
>    by name; SQLite does too. Prod keeping `owner` at the tail forever is
>    harmless — `CREATE TABLE IF NOT EXISTS` no-ops there anyway.
> 3. **Therefore the equivalence test must compare cid order ONLY on the
>    fresh-vs-fresh legs (A vs B).** The third assertion — "migrator on a
>    legacy-shaped DB" — must compare columns as a **map keyed by name**, never
>    as a cid-ordered array, or it will fail against the very production shape
>    it exists to protect. Assert the *set* of columns and their types/defaults
>    there, not their positions.
>
> Same applies to any future `ADD COLUMN` whose name already exists in a CREATE
> body. Grep for duplicate column names across CREATE and ALTER before trusting
> any transcription.

- **Index names must match exactly** (legacy names below) — the test compares
  `sqlite_master` index rows by name.
- Timestamps stay `text()` (ISO-8601), booleans `integer({ mode: "boolean" })`,
  JSON columns `text({ mode: "json" }).$type<T>()` per 00-architecture.md.
  Neither mode changes the emitted DDL (still `text` / `integer`), so the
  equivalence test is unaffected by these typings.

### JSON-column audit (verdicts, with evidence)

**Re-verified 2026-08-18.** Only **five** JSON columns exist across all 15
tables — the seven newer tables (`cron_runs`, both `feedback_*`, the four
`github_*`) contain **no JSON at all**, only TEXT/INTEGER scalars.

| Column | Verdict | Evidence |
|---|---|---|
| `workflow_runs.phase_history` | **json**, `$type<PhaseHistoryEntry[]>`, notNull, default `'[]'` | stringified `workflow-run-store.ts:323`; parsed `:319`, `:878`. `createRun` seeds it with the SQL literal `'[]'` (`:247`), not a JS value |
| `workflow_runs.context` | **json**, `$type<Record<string, unknown>>` | stringified `workflow-run-store.ts:257`; parsed `:880`. **But see the SQL-mutation warning below — three writes never round-trip through JS.** |
| `workflow_runs.scratch` | **json**, `$type<Record<string, unknown>>` | stringified `:258`, `:285`; parsed `:281`, `:881` |
| `executions.extension_status` | **json**, `$type<ExtensionStatusMap>` — *only if both boundaries move in the same commit* | stringified in **`packages/workflow-engine/src/core/phase-executor.ts:350`**; parsed in `apps/server/src/admin/routes.ts:192` (`parseJsonColumn`), called at `:1642`. Store treats it as an opaque `string` throughout (`execution-store.ts:57,137,173,325,346`) |
| `executions.skills_status` | same as above | `phase-executor.ts:351`; `routes.ts:193`, `:1643`; `execution-store.ts:63,138,174,328,347` |
| `workflow_approvals.artifact` | **plain `text()`** | a filename (`'architect-plan.md'`), never JSON — `approval-store.ts:16-19`, read raw at `:193`, and queried with `WHERE artifact = ?` in `listByArtifact` `:150-157` |

> **⚠ The two status columns are the single most dangerous item in Phase 1.**
> Their JSON boundary sits **outside** `apps/server` entirely — the writer moved
> into `packages/workflow-engine` when the engine was extracted (the plan's old
> `src/workflows/phase-executor.ts:339-340` reference is dead). Declaring them
> `{mode:'json'}` without moving **both** boundaries in the same commit
> double-encodes on write and double-decodes on read — and the read side fails
> **silently**: `parseJsonColumn`'s `catch` (`routes.ts:194`) swallows the throw
> and returns `undefined`, so the dashboard just shows nothing. That is data
> loss with no error anywhere. Either leave both `text()` (matching today's
> contract exactly) or move `phase-executor.ts:350-351` **and**
> `routes.ts:1642-1643` **and** retype `ExecutionRecord.extensionStatus` /
> `.skillsStatus` together. Do not touch any of it in Phase 1 — this is a
> forward note for Phase 2.

> **⚠ `workflow_runs.context` is mutated by SQL, not by JS, in three places** —
> `{mode:'json'}` does nothing for them and they must each be rewritten:
> `expireQueued` (`workflow-run-store.ts:632`, `json_patch`), `flipFinished`
> (`:742`, `json_patch` inside a `CASE`), and `restartRun` (`:798`,
> **`json_remove`** — a construct the original plan never mentions). Only
> `flipFinished` appears in 00-architecture's hotspot table; all three need the
> app-side read-modify-write treatment, inside their existing transaction.

**Partial-select interaction:** `WorkflowRunStore.list()` (`:543-549`)
deliberately omits `context` and `scratch` for payload size but **does** select
`phase_history`, and `deserialize` (`:878-881`) parses it unconditionally while
guarding the other two. Keep `phase_history` `.notNull().default(sql\`'[]'\`)`
and both others nullable, or `list()` starts throwing.

**Type imports** (type-only, so no runtime coupling — and note the corrected
origins, both of which moved into the engine package):
`ExtensionStatusMap` / `SkillsStatus` from
**`lastlight-workflow-engine`'s `core/types.ts:207-222` / `:241-247`**, not
`engine/github/profiles.js`; `PhaseHistoryEntry` from
`../workflow-run-store.js`. Remember `.js` extensions (Node16 resolution).

### Boolean-column audit (verdicts, with evidence)

**Six** boolean columns across the 15 tables. Everything else that is INTEGER
is a genuine number — explicitly **not** booleans: `feedback_signals.score`
(−2..+2), `messaging_sessions.message_count`, `workflow_runs.restart_count`,
`users.github_id`, every `*_tokens` / `*_ms` / `issue_number` / `turns`, and
all five `cron_runs` counters.

| Column | Mode | Notes |
|---|---|---|
| `executions.success` | `integer({mode:"boolean"})` **nullable** | **TRI-STATE — `null` means still in flight.** Written `? 1 : 0` at `execution-store.ts:351` and as a SQL literal `0` at `:392,664,679,698`; `recordStart` omits it entirely. `ExecutionRecord.success?: boolean` is optional for exactly this reason |
| `users.is_blocked` | `integer({mode:"boolean"}).notNull().default(false)` | **Zero write sites** — the DDL default is the only writer. Read at `user-store.ts:230` |
| `users.email_is_placeholder` | same | **Zero write sites.** Read at `user-store.ts:231` |
| `cron_overrides.enabled` | `.notNull().default(true)` | write `db.ts:173`, read `:184` |
| `workflow_overrides.enabled` | `.notNull().default(true)` | write `db.ts:235`, reads `:202` (the hot path every dispatch crosses) and `:241` |
| `github_teams.truncated` | `.notNull().default(false)` | write `team-store.ts:93`; read via `COALESCE(t.truncated, 0)` at `:167` — nullable **at the query level** because of a `LEFT JOIN`, so that COALESCE is load-bearing and becomes `COALESCE(…, false)` on PG |
| `messaging_sessions.active` | `integer({mode:"boolean"}).default(true)` — **nullable**, no `.notNull()` | never written from JS; SQL literals only (`session-manager.ts:162,210`), and `INSERT` omits it |

> **⚠ `consecutiveFailures` does not merely need a tweak — it silently dies.**
> `execution-store.ts:731` reads `if (row.success === 0) count++;`. Under
> `{mode:'boolean'}` Drizzle maps `0 → false`, so `=== 0` is **never true
> again** and the function returns 0 forever. It backs the cron failure alert,
> so the failure mode is "alerting quietly turns off", with nothing red
> anywhere. Port it to `=== false` and pin it with a test that would fail on
> the inverted form.

### `executions` (full snippet)

Legacy DDL: `migrate.ts` ≈18-31; the issue-#205 actor ALTERs at ≈120-131
(`triggered_by`, `trigger_actor_type`) — **added BEFORE the `session_id`
ALTER**, so their physical position is immediately after `duration_ms`; then
`session_id` ≈191 and the usage-metric loop at ≈199-232; indexes
≈33-34, ≈235. The two actor columns are plain `text()` — NOT json, NOT
boolean.

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
    // issue #205 actor columns — ALTER-added BEFORE session_id, so they sit
    // right after duration_ms; plain text() (NOT json, NOT boolean).
    triggeredBy: text("triggered_by"),
    triggerActorType: text("trigger_actor_type"),
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

Legacy DDL `migrate.ts` ≈36-49; ALTERs in physical order: `triggered_by`,
`trigger_actor_type` (issue #205, ≈120), `scratch` (≈136), `restart_count`
(≈145), `owner` (≈160); indexes ≈50-57. The two actor columns and `owner`
are plain `text()`.

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
| triggeredBy | `triggered_by` | `text()` — issue #205; ALTER-added before scratch |
| triggerActorType | `trigger_actor_type` | `text()` — issue #205; ALTER-added before scratch |
| scratch | `scratch` | `text({mode:"json"}).$type<Record<string, unknown>>()` |
| restartCount | `restart_count` | `integer().notNull().default(0)` |
| owner | `owner` | `text()` — issue #205; ALTER-added after restart_count (carries a data backfill — see the legacy pre-step in Phase 2b) |

Indexes: `index("idx_workflow_runs_trigger").on(t.triggerId, t.status)`,
`index("idx_workflow_runs_status").on(t.status)`,
`index("idx_workflow_runs_started_at").on(sql\`${t.startedAt} DESC\`)` — this
one is **DESC** (`migrate.ts:56`). sqlite-core has **no `.desc()` on index
columns** — `t.startedAt.desc()` throws a TypeError at generate time (that
API exists only in pg-core), so the `sql\`\`` expression form is the ONLY
option; verify the generated baseline actually carries the `DESC` (the
equivalence test compares index sql verbatim, so a silent drop fails loudly).
`index("idx_workflow_runs_name_started").on(t.workflowName,
sql\`${t.startedAt} DESC\`)` (`migrate.ts:57`, second key DESC — this mixed
ASC+DESC composite is the one SQLite cannot satisfy by a reverse scan, so the
DESC is load-bearing, not cosmetic).

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

### `users` (issue #205)

Legacy DDL `migrate.ts` ≈96-112 (a plain `CREATE TABLE IF NOT EXISTS`, not
an ALTER — the whole table is additive). First-class user identity, an
enrichment table LEFT-JOINed on `login`. Physical column order:

| property | column | builder |
|---|---|---|
| id | `id` | `text().primaryKey()` |
| githubId | `github_id` | `integer("github_id").unique()` |
| login | `login` | `text("login").unique()` |
| name | `name` | `text()` |
| email | `email` | `text()` — indexed, **NOT** unique |
| avatarUrl | `avatar_url` | `text("avatar_url")` |
| slackUserId | `slack_user_id` | `text("slack_user_id").unique()` |
| isBlocked | `is_blocked` | `integer("is_blocked",{mode:"boolean"}).notNull().default(false)` |
| emailIsPlaceholder | `email_is_placeholder` | `integer("email_is_placeholder",{mode:"boolean"}).notNull().default(false)` |
| createdAt | `created_at` | `text("created_at").notNull()` |
| updatedAt | `updated_at` | `text("updated_at").notNull()` |
| lastLoginAt | `last_login_at` | `text("last_login_at")` |

Indexes (3): `index("idx_users_login").on(t.login)`,
`index("idx_users_email").on(t.email)`,
`index("idx_users_slack").on(t.slackUserId)`.

**Equivalence-test note (important — no methodology change needed).** The
three column-level `UNIQUE` constraints (`github_id`, `login`,
`slack_user_id`) create `sqlite_autoindex_users_*` entries whose `sql IS
NULL` in `sqlite_master` — exactly like PK autoindexes. Step 4's index
extraction already filters `WHERE ... AND sql IS NOT NULL`, so those
autoindexes are **excluded on BOTH legs**: a legacy column-level `UNIQUE`
and a Drizzle `.unique()` both emit the same inline autoindex with NULL sql.
The users table therefore needs only the added expectations below (the three
named `idx_users_*` indexes, which DO have non-NULL sql), not any change to
how the test compares indexes. `is_blocked` / `email_is_placeholder` stay
`{mode:"boolean"}` — INTEGER DDL, so no equivalence impact (like every other
boolean).

### `cron_runs` (issues #341/#327)

Legacy DDL `migrate.ts` ≈78-94; index ≈96. All CREATE, **no ALTERs**. One row
per cron FIRE — the only record a zero-discovery backstop fire leaves.

`id` `text().primaryKey()`; `cronName` `text("cron_name").notNull()`;
`workflow` `text()`; `handler` `text()`; `source` `text().notNull()`; `actor`
`text()`; `startedAt` `text("started_at").notNull()`; `finishedAt`
`text("finished_at")`; `status` `text().notNull().default("running")`;
`reposEligible` `integer("repos_eligible")`; `reposScanned`
`integer("repos_scanned")`; `discovered` `integer()`; `dispatched`
`integer()`; `failures` `integer()`; `error` `text()`.

Index: `index("idx_cron_runs_name_started").on(t.cronName, sql\`${t.startedAt} DESC\`)`
— **DESC on the second key** (`migrate.ts` ≈96).

Note `workflow` and `handler` are both nullable: a cron declares exactly one.

### `feedback_anchors` (issue #255)

Legacy DDL `migrate.ts` ≈158-194; indexes ≈196-202. All CREATE, no ALTERs.

`id` `text().primaryKey()`; `source` `text().notNull()`; `kind`
`text().notNull()`; `externalId` `text("external_id").notNull()`; `nodeId`
`text("node_id")`; `channel` `text().notNull().default("")`; `owner`
`text()`; `repo` `text()`; `issueNumber` `integer("issue_number")`;
`workflowRunId` `text("workflow_run_id")`; `workflowName`
`text("workflow_name")`; `messagingSessionId` `text("messaging_session_id")`;
`createdAt` `text("created_at").notNull()`; `lastPolledAt`
`text("last_polled_at")`.

**Table-level constraint** (`migrate.ts` ≈193):
`unique().on(t.source, t.channel, t.externalId)`.

Indexes: `idx_feedback_anchors_lookup` on `(source, channel, external_id)` —
**declare it even though it duplicates the UNIQUE autoindex**;
`idx_feedback_anchors_run` on `(workflow_run_id)`;
`idx_feedback_anchors_poll` on `(source, created_at, last_polled_at)`.

Two traps, both deliberate — do **not** "fix" either:

- **`channel` is `NOT NULL DEFAULT ''`** — the empty string is a sentinel, not
  an oversight. It exists precisely because SQLite treats NULLs as distinct,
  which would make the three-column UNIQUE inoperative. The store maps `''` ↔
  `null` at its boundary; the rationale is a 17-line comment at `migrate.ts`
  ≈169-176.
- **`workflow_run_id` is nullable on purpose** (`migrate.ts` ≈181-183) — an
  unattributable bot comment is still worth anchoring.

### `feedback_signals` (issue #255)

Legacy DDL `migrate.ts` ≈204-232; indexes ≈233-239. All CREATE, no ALTERs.

`id` `text().primaryKey()`; `anchorId` `text("anchor_id").notNull()`;
`source` `text().notNull()`; `workflowRunId` `text("workflow_run_id")`;
`workflowName` `text("workflow_name")`; `messagingSessionId`
`text("messaging_session_id")`; `owner` `text()`; `repo` `text()`;
`issueNumber` `integer("issue_number")`; `emoji` `text().notNull()`; `score`
`integer().notNull()` (−2..+2, a real number — **not** a boolean);
`sentiment` `text().notNull()`; `reactor` `text()`; `reactedAt`
`text("reacted_at")`; `observedAt` `text("observed_at").notNull()`;
`removedAt` `text("removed_at")`; `exportedAt` `text("exported_at")`.

**Table-level constraint** (`migrate.ts` ≈231):
`unique().on(t.anchorId, t.reactor, t.emoji)`. Note `reactor` is **nullable**,
so unlike the anchors table this constraint does *not* bind for null reactors.
Transcribe it as-is; do not make `reactor` NOT NULL to "fix" it.

Indexes (5): `idx_feedback_signals_anchor` `(anchor_id)`;
`idx_feedback_signals_run` `(workflow_run_id)`;
`idx_feedback_signals_observed` `(observed_at DESC)`;
`idx_feedback_signals_workflow` `(workflow_name, observed_at DESC)`;
`idx_feedback_signals_export` `(exported_at)`.

`anchor_id` is a logical reference to `feedback_anchors.id` with **no
`REFERENCES` clause** — keep it a plain column.

### The four `github_*` visibility-cache tables (issue #169)

Legacy DDL `migrate.ts` ≈250-295. All CREATE, no ALTERs. **Three of them use
composite primary keys** — the only composite PKs in the schema. In
sqlite-core these are declared with the table-level
`primaryKey({ columns: [...] })` helper, not `.primaryKey()` on a column.

| table | columns | PK |
|---|---|---|
| `github_teams` | `org` `text().notNull()`, `slug` `text().notNull()`, `name` `text()`, `reposSyncedAt` `text("repos_synced_at").notNull()`, `truncated` `integer({mode:"boolean"}).notNull().default(false)` | **composite `(org, slug)`** |
| `github_team_repos` | `org`, `teamSlug` `text("team_slug")`, `repo` — all `text().notNull()` | **composite `(org, team_slug, repo)`** — every column is the key |
| `github_team_members` | `org`, `teamSlug` `text("team_slug")`, `login` — all `text().notNull()` | **composite `(org, team_slug, login)`** — every column is the key |
| `github_visibility_sync` | `login` `text().primaryKey()`, `syncedAt` `text("synced_at").notNull()`, `status` `text().notNull()`, `detail` `text()` | single |

Only one named index across all four:
`index("idx_github_team_members_login").on(t.login)` (`migrate.ts` ≈283).
`github_teams.truncated` is the boolean. `repo` on `github_team_repos` holds
the **qualified** `owner/repo` full name — unlike everywhere else in the
schema post-#279, so do not apply the bare-repo rule here.

`(org, team_slug)` on the two child tables logically references
`github_teams.(org, slug)` — note the **column-name mismatch** (`slug` vs
`team_slug`) and that no FK is declared. Keep it that way.

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

**Do NOT add a table-level `UNIQUE(platform, channel_id, thread_id, user_id)`.**
That constraint used to exist and was *removed* because it broke get-or-create
— a deactivated session still occupied the key, so a returning user could never
start a new one. The partial unique index above is its replacement, and the
whole `rebuildWithoutTableUnique()` path (`session-manager.ts` ≈92-136, moving
to `legacy-sqlite.ts` in Phase 2) exists solely to strip it from databases that
still carry it. Transcribing it back in re-introduces the bug the rebuild
exists to undo.

Two more deliberate oddities here: **`message_count` and `active` are DEFAULT
*without* NOT NULL** — the only such columns in the schema (everything else
pairs the two). Since `active` is the partial index's predicate, a NULL
`active` row is silently exempt from the uniqueness rule. And **`thread_id` is
nullable while being a key column of that unique index**, so DM-style sessions
with no thread do not collide. Transcribe both as-is.

### `messaging_messages`

Legacy DDL `session-manager.ts:35-42`; index `:46-47`. Columns: `id`
`integer().primaryKey({ autoIncrement: true })`; `sessionId`
`text("session_id").notNull().references(() => messagingSessions.id)`;
`role` `text().notNull()`; `content` `text().notNull()`; `timestamp`
`text().notNull()`; `platformMessageId` `text("platform_message_id")`.
Index: `index("idx_msg_messages_session").on(t.sessionId, t.timestamp)`.

### Index tally — **25 named indexes** across 15 tables

3 (executions) + 4 (workflow_runs) + 1 (cron_runs) + 2 (approvals) + 3 (users)
+ 3 (feedback_anchors) + 5 (feedback_signals) + 1 (github_team_members) + 3
(messaging_sessions, incl. the partial unique) + 1 (messaging_messages) = **25**.

**Five tables carry no named index at all**: `cron_overrides`,
`workflow_overrides`, `github_teams`, `github_team_repos`,
`github_visibility_sync`.

Of the 25: exactly **one is UNIQUE and it is also the only partial one**
(`idx_msg_sessions_unique_active ... WHERE active = 1`), and **five carry DESC
keys** — three of them mixed ASC+DESC composites SQLite cannot satisfy by a
reverse scan, so the DESC is load-bearing, not cosmetic:

| index | keys |
|---|---|
| `idx_workflow_runs_started_at` | `started_at DESC` |
| `idx_workflow_runs_name_started` | `workflow_name ASC, started_at DESC` |
| `idx_cron_runs_name_started` | `cron_name ASC, started_at DESC` |
| `idx_feedback_signals_observed` | `observed_at DESC` |
| `idx_feedback_signals_workflow` | `workflow_name ASC, observed_at DESC` |

**Nineteen implicit `sqlite_autoindex_*`** entries also exist (from PKs, the
three composite PKs, `users`' three column-level `UNIQUE`s, and the two
table-level `UNIQUE` constraints on the feedback tables). They have `sql IS
NULL` in `sqlite_master` and step 4's extraction already filters them out on
**both** legs, so no methodology change is needed — a legacy column-level
`UNIQUE` and a Drizzle `.unique()` emit the identical NULL-sql autoindex.

**Three named indexes are redundant with an autoindex and must STILL be
declared** — omit them and `drizzle-kit generate` will emit `DROP INDEX`
against prod: `idx_users_login` (duplicates the `login UNIQUE` autoindex),
`idx_users_slack` (duplicates `slack_user_id UNIQUE`), and
`idx_feedback_anchors_lookup` (duplicates the `UNIQUE(source, channel,
external_id)` autoindex, same columns, same order).

## Step 3 — drizzle-kit config + baseline generation

`drizzle-sqlite.config.ts` (the `apps/server/` package root; `schema:`/`out:`
paths are relative to that package root; shape after
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
   Must be exactly the 15 tables. Also exclude `sqlite_sequence`, which
   `messaging_messages.id AUTOINCREMENT` creates.
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
   `messaging_messages.session_id → messaging_sessions.id` FK. That is the
   **only declared FK in the entire 15-table schema**, so this assertion is
   really "exactly one FK, and it is this one". Every other cross-table
   reference (`executions.workflow_run_id`, `workflow_approvals.workflow_run_id`,
   `feedback_signals.anchor_id`, the `feedback_*.messaging_session_id` pair,
   `github_team_*.（org, team_slug)`) is **logical only** — declare those as
   plain columns, NOT `.references(...)`, or the baseline stops matching prod.
   Note also that `PRAGMA foreign_keys` is **never enabled at runtime** (the
   sole pragma on the connection is `journal_mode = WAL`), so the one FK is
   declared-but-unenforced today; Phase 2's `busy_timeout` addition must not
   accidentally turn it on.
5. **Composite primary keys**: `PRAGMA table_info` reports `pk` as a 1-based
   position, not a boolean. The three `github_*` tables have multi-column PKs,
   so normalize to the ordered list of PK columns per table rather than a
   `pk > 0` flag — a flag would pass while the key order silently diverged.

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
pnpm --filter lastlight-core build   # tsc green; schema file compiles under strict
pnpm --filter lastlight-core test    # full suite green, incl. the new equivalence test
git diff --stat                      # confirms no runtime source file changed
                                     # (apps/server/src delta = schema/sqlite.ts only)
```

Dashboard typecheck not needed (no admin routes touched).

## Risk watch-items

- **Column order / default mismatches** — caught mechanically by the test's
  cid-order comparison. Fix by reordering declarations in `schema/sqlite.ts`
  and regenerating (pre-freeze, regenerating + re-hand-editing is fine).
- **Drizzle default-value quoting** — `DEFAULT 'running'` vs `"running"`,
  `true` vs `1`. The hand-edit (step 3.2) plus `normalizeDefault` cover the
  known cases; any residue shows up as a test diff, not silent drift.
- **Index name or DESC mismatches** — drizzle-kit uses exactly the names in
  the schema file; a typo surfaces as a missing/extra key in the index map.
  Verify `idx_workflow_runs_started_at` / `idx_workflow_runs_name_started`
  really carry `DESC` in the emitted sql (the `.desc()` builder form does not
  exist on sqlite — see the workflow_runs section). If drizzle-kit won't emit
  the `sql\`\`` expression form's DESC either, hand-edit it into the baseline
  (pre-freeze, this is sanctioned) and note the meta-snapshot divergence in
  the Deviations section. The partial `uniqueIndex(...).where(...)` IS
  emitted correctly by current drizzle-kit (verified on 0.31.10).
- **PK NOT NULL tightening** — expected divergence, normalized in the test
  (step 4.2); do not "fix" the schema to make PKs nullable.
- **libsql `:memory:`** — `createClient({ url: ":memory:" })` is
  per-connection in-memory, matching the better-sqlite3 test posture
  (`src/state/db.ts:66-73`). Don't use a shared file path in tests. Safe in
  THIS phase because nothing here calls `client.transaction()` (locked
  decision 12's hazard: the client opens a fresh — empty — `:memory:`
  connection after any transaction). The drizzle migrator doesn't run through
  `client.transaction()`, so Leg B on `:memory:` is fine — but if its schema
  mysteriously vanishes mid-test, that hazard is the first suspect: switch
  Leg B to a temp file.

## Done criteria

- [x] `drizzle-orm` + `@libsql/client` in dependencies, `drizzle-kit` in
      devDependencies — all latest stable, no RC pins.
- [x] `db:generate:sqlite` script in package.json.
- [x] `apps/server/src/state/schema/sqlite.ts` defines all 15 tables, 25
      named indexes (incl. the partial unique + both DESC indexes), with the
      JSON/boolean mode decisions recorded above.
- [x] `apps/server/drizzle/sqlite/0000_baseline.sql` exists, fully
      `IF NOT EXISTS`-idempotent, with the required header comment; `meta/`
      committed.
- [x] `apps/server/tests/state/schema-equivalence.test.ts` green: legacy vs
      drizzle schema equal after normalization; migrator-twice no-op;
      migrator succeeds on a legacy-seeded file DB with data intact.
- [x] `pnpm --filter lastlight-core build && pnpm --filter lastlight-core test`
      green; no runtime code path changed.
- [x] README.md Phase 1 checkbox ticked; deviations (if any) appended below.

## Deviations (executed 2026-08-18)

All done-criteria met. Versions resolved exactly as predicted:
`drizzle-orm@^0.45.2`, `drizzle-kit@^0.31.10`, `@libsql/client@^0.17.4` — all
latest stable, no RC. Final state: **204 test files / 3,119 tests** (baseline
203 / 3,115 plus this phase's 4). `git status` on `apps/server/src/` shows
`state/schema/` and nothing else.

### 1. `unique()` does NOT become an inline constraint — the step-4 note was wrong

**The one finding that changed the deliverable.** Step 4 and the `users`
"Equivalence-test note" both assert that a Drizzle `.unique()` and a legacy
column-level `UNIQUE` "both emit the same inline autoindex with NULL sql", so
they cancel out on both legs and "no methodology change is needed".

They do not cancel out. drizzle-kit renders **both** column-level `.unique()`
and table-level `unique().on(...)` as standalone `CREATE UNIQUE INDEX`
statements with real, non-NULL sql. The legacy DDL used inline `UNIQUE`
constraints, which SQLite implements as `sqlite_autoindex_*` with NULL sql. So
the drizzle leg carries **five named indexes the legacy leg does not**:
`users_github_id_unique`, `users_login_unique`, `users_slack_user_id_unique`,
`feedback_anchors_source_channel_external_id_unique`,
`feedback_signals_anchor_id_reactor_emoji_unique`.

Semantically identical, structurally different. Keeping `.unique()` is not
optional — dropping it would leave a fresh Drizzle DB with no uniqueness on
`users`' three keys and no constraint for the feedback stores' `ON CONFLICT`
upserts to target in Phase 2.

So the test gained a **`uniqueKeyTuples()`** extractor (`PRAGMA index_list` +
`index_info`) that compares *what the database enforces* — the unique column
tuples, however spelled — instead of trusting index names to line up. The five
names are an explicit allowlist with the rationale inline. This is a stronger
assertion than the doc specified, not a weaker one.

**Consequence for the production cutover, and it is benign:** the baseline
creates five redundant unique indexes over a prod DB that already has the
equivalent inline constraints. Safe by construction — the existing constraint
guarantees no violating row, so the index build cannot fail. The
production-shaped test pins exactly this: the *set* of enforced rules is
unchanged, and precisely those five tuples become doubly-indexed. Nothing else
in the baseline touches a prod-shaped DB.

### 2. Two tables in this doc were short some columns

Both found by reading `migrate.ts` rather than the doc's tables:

- **`executions` has 27 columns, not 26.** The full snippet omits **`owner`**
  (`migrate.ts:26`, CREATE-body cid 4) — the very column the ⚠ block is about.
  Copying that snippet verbatim would have dropped it from the schema and
  emitted a `DROP COLUMN`-shaped diff against prod's most-read table.
- **`workflow_runs` has 19 columns**, as its headline says, but the property
  table lists only 17 — missing **`trace_id`** and **`span_id`**
  (`migrate.ts:452-458`, the issue-#255 OTel context, ALTER-added after
  `restart_count`). Without them a feedback signal could not be parented on its
  run's trace.

Also: the `workflow_runs` property table places `owner` at the tail, which
contradicts the ⚠ block eight sections above it. The ⚠ block is correct and was
followed — `owner` is declared **mid-table at cid 3** (fresh order). The table's
tail placement describes the *upgraded prod* shape, which is exactly the
divergence the ⚠ block exists to explain.

### 3. Index tally arithmetic

**25 named indexes is right** (asserted in the test), but the tally sentence's
own addends sum to 26: `messaging_sessions` has **2** named indexes
(`idx_msg_sessions_lookup` + the partial `idx_msg_sessions_unique_active`), not
the 3 stated. The baseline emits **30** index statements — those 25 plus the
five from §1.

### 4. Execution strategy — no fan-out

The 4-agent transcription fan-out was not used; all 15 tables were transcribed
serially. The doc had already done the fan-out's actual work (it carries the
per-column builder spec for every table), so the agents' only remaining job was
re-reading the DDL — which is where §1 and §2 were found, and which had to be
done once, carefully, against the whole file rather than four disjoint slices.
Reconciling four fragments of one file would have added coordination cost
without adding verification. Recorded because locked decision 16's fan-out for
**Phase 2** is a different proposition — seven independent store files, not one
shared schema file — and this is not a precedent against it.

### 5. Minor

- Line references in this doc have drifted (`users` is at `migrate.ts:127-140`,
  not ≈96-112; `feedback_anchors` at 158-202; the `github_*` block at 250-295).
  Shapes were as described.
- `ExtensionStatusMap` / `SkillsStatus` are imported from the package entry
  `lastlight-workflow-engine` rather than its internal `core/types.js` path
  (`index.ts` re-exports `core/types.js` wholesale, and `profiles.ts` already
  re-exports them from there). Type-only, so no runtime coupling either way.
- `drizzle-kit` emitted the `sql`-expression DESC keys and the partial
  `uniqueIndex(...).where(...)` correctly on 0.31.10 — no hand-edit needed for
  either, and both are pinned by a dedicated test case.
