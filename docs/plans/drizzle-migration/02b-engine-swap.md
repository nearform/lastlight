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

Delete `better-sqlite3` from `apps/server/src/`. `StateDb`, the four stores
(`ExecutionStore` / `ApprovalStore` / `WorkflowRunStore` / `UserStore`), and
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

- [ ] **Phase 1 done**: `apps/server/src/state/schema/sqlite.ts` exists
  (8 tables incl. `users`, all 15 named indexes, `{mode:'json'}` /
  `{mode:'boolean'}` columns),
  `drizzle/sqlite/0000_baseline.sql` is idempotent, and
  `tests/state/schema-equivalence.test.ts` is green (legacy `migrate()` DDL
  ≡ Drizzle migrator output).
- [ ] ~~**Phase 2a done**~~ **In-scope instead (combined phase)**: the async
  ripple is executed as part of this phase, using
  [02a-async-api.md](02a-async-api.md) as the map — every method of
  `StateDb`, the four stores (incl. `UserStore`), and `SessionManager`
  becomes `async`; all
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

## Ripple scale — re-derived 2026-08-18

02a's inventory was measured against a 5-class, 3-store codebase. Current
reality:

| 02a said | Actual |
|---|---|
| 70 public methods across 5 classes | **127 public methods across 9 classes** — StateDb 10, ExecutionStore 28, ApprovalStore 10, WorkflowRunStore 34, UserStore 8, TeamStore 8, FeedbackStore 15, CronRunStore 4, SessionManager 10 |
| ~124 production call sites | **196**, across 28 files |
| ~15 consumer files | **28** in `apps/server/src` + `packages/workflow-engine` |
| 5 transaction sites | **9**, plus SessionManager's hand-rolled `BEGIN`/`COMMIT` |
| ~10 test files | **37** |
| landmines L1–L9 | L1–L9 **plus the eight below** |

Exactly **two** public members are non-DB and stay sync:
`WorkflowRunStore.addTerminalObserver` and `StateDb.get database` (the latter
is deleted anyway).

### Two traps that will defeat a naive codemod

1. **Aliased store handles evade any receiver-prefixed grep.** Searching for
   `db.runs.` / `db.users.` / `db.teams.` misses
   `connectors/slack/connector.ts:643,649,651` (a bare local `users`),
   `engine/github/team-visibility.ts:160,162,178,224,358,384` (`this.store`),
   and `workflows/handlers/post-review.ts:117` (`this.run.store.runs.*`).
   **Search by method name, not by receiver.**
2. **`state/feedback-store.ts` contains two literal NUL bytes** (lines 338-339)
   — deliberate composite-key separators in template literals
   (`` `${k.reactor ?? ""}\0${k.emoji}` ``), written as raw control characters
   rather than `\0` escapes. The file is valid UTF-8, but `file(1)` reports
   `data` and plain `grep`/`wc` treat it as binary and bail. Any sweep across
   the state layer needs `grep -a`. (Converting them to `\0` escapes would be a
   tidy-up, but it is an unrelated behaviour-neutral change — do it separately,
   not inside this migration.)

### The eight additional landmines (none are in 02a)

| # | Site | Why it is not a mechanical `await` |
|---|---|---|
| **L10** | `workflows/admission.ts:82-107` (`admitNext`) | The `for(;;)` loop does `countRunning()` → `listQueued()` → `admitRun()` (CAS) → `getRun()`. Today the whole body is synchronous, so **nothing can interleave between the count and the admit**. Under async, the event-driven `admitNext()` and the 15 s sweep can interleave mid-iteration: the `admitRun` CAS still protects each row, but `countRunning() >= cap` can be **over-admitted by N concurrent loops**. This is a concurrency-design decision, not a port. Decide explicitly: serialize `admitNext` through the same op-chain as the transactions, or re-check the cap after the CAS |
| **L11** | `index.ts:1027-1029` → `notifierOnRunStart` (`:938`) | The comment states the invariant: *"Synchronous notifier setup must finish before simple.ts calls `reporter.start()` … so it runs FIRST — before the first `await` in this callback."* Awaiting destroys the guarantee the comment names. README locked decision 10 (`simple.ts` awaits `onRunStart`) is precisely the fix — re-establish the ordering explicitly and **rewrite that comment**, or the next reader trusts a dead invariant |
| **L12** | `engine/review-check.ts:391` | `mergeScratch(run.id, { reviewCheck: null })` **must be awaited** — the comment at `:389-390` says *"Clear before the network call: a failed update must not leave a ref that re-fires on the next terminal transition."* Fire-and-forget here reintroduces double-conclude. Explicitly NOT on the fire-and-forget table |
| **L13** | `workflows/runner.ts:487` (`failWorkflow`) | Tempting to `void`, but the k8s backpressure branch at `:483-485` depends on the fail-flip **not** having happened before `requeueRunning`'s CAS. Ordering is load-bearing; if this becomes fire-and-forget the requeue path must still await |
| **L14** | `connectors/messaging/thread-transcript.ts:110` (`withThreadTranscript`) | Returns an `EventEnvelope` **synchronously** and is called inline at `engine/dispatcher.ts:181` (`chatOwnsTranscript ? inbound : withThreadTranscript(...)`). It cannot become async without changing the dispatch shape. Its internal `recordThreadMessage` (`:119`) is the fire-and-forget part |
| **L15** | `engine/chat/chat-prompt.ts:138,139,159,160` | `isWorkflowEnabled` is consumed inside **`.filter()` callbacks** within a string-concatenation expression, three hops from `index.ts:267`'s sync `systemPrompt: () => …` thunk. Resolve the enabled set **once per turn** before the thunk (the cleanest option — `chat-runner.ts:357` is already inside async `doTurn`), rather than making `chatSystemSuffix` async |
| **L16** | `admin/routes.ts:2453-2469` (`/crons`) | `defs.map((def) => { … db.cronRuns.recentFailures(def.name) … })` — one store call per cron inside a sync `.map`, under a 10 s dashboard poll. Note `latestByCron()` at `:2452` was already hoisted out deliberately ("one query for the whole list rather than one per cron") but `recentFailures` was not. Batch it the same way rather than `Promise.all`-ing N queries |
| **L17** | `admin/routes.ts:2001-2012` (`computeArtifactMetadata`) | A sync `: ArtifactMetadata` helper doing `listByArtifact` then a `.map()` whose body calls `db.runs.getRun(...)` per row. Needs `Promise.all` inside the map, and the helper flips async for both callers (`:2261`, `:2276`) |

### Interfaces that must flip (22 total)

Beyond 02a's three (`PhaseReporter`, `SessionSource`, `getJobs`):
`TerminalRunObserver` (`workflow-run-store.ts:160`) and its 2 registrations;
`ChatPromptOptions.isWorkflowEnabled` and the `systemPrompt` thunk;
`RepoForSession` (`admin/sessions.ts:100`); the engine's `RunStore` /
`ExecutionLedger` / `WorkflowStateStore` / `persistPhase` / `failWorkflow`
(locked decision 13); the four notify-transport callbacks
(`transports/github.ts:17`, `transports/slack.ts:18,27`); the three connector
option callbacks (`onTeamChanged`, `onBotMessage`, `onReactionAction`); and
**18 exported sync functions** that become `Promise`-returning — including
`applyDerivedState`, `harvestFixMarkers`, `ingestReaction`, `retractReaction`,
`exportSignal`, `drainFeedbackExport`, `recordReviewCheck`,
`recordThreadMessage`, `getJobs`, `summarizeBot`, `didSpendAttempt`,
`mountAdmin`.

Already `Promise`-returning and needing **body** changes only:
`AdmissionController`, `RunnerCallbacks`, `CronHandler`, `ProgressReporter`.

### Transaction sites — 9, not 5

The five named ops in `WorkflowRunStore` (`:730` `finishRun`, `:934`
`pauseForApproval`, `:958` `resolveGateAndResume`, `:976` `resolveGateAndFail`,
`:995` `resolveReplyGateAndResume`) **plus four in `TeamStore`** (`:81`
`recordResolution`, `:183` `invalidateLogin`, `:203` `invalidateTeam`, `:224`
`invalidateAll`) — hence the connection-scoped serializer in README locked
decision 8. `TeamStore`'s carry no CAS guard (they are all-or-nothing cache
rewrites); the three `resolveGate*` ops carry the load-bearing
`changes !== 1 → throw` guards.

Also note **five CAS guards that live OUTSIDE any transaction** and must keep
exact rows-affected semantics: `admitRun` (`:606`), `expireQueued` (`:624` —
which fires `notifyTerminal` from *inside* the `changes === 1` branch),
`restartRun` (`:790`), `requeue` (`:812`), `requeueRunning` (`:832`).

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
column set, enumerated from `apps/server/src/state/migrate.ts` ≈120-232:

```ts
import type { Client } from "@libsql/client";

const LEGACY_COLUMNS: Record<string, string[]> = {
  workflow_runs: [
    "triggered_by TEXT",                               // migrate.ts ≈120 (issue #205)
    "trigger_actor_type TEXT",                         // migrate.ts ≈120 (issue #205)
    "scratch TEXT",                                    // migrate.ts ≈136
    "restart_count INTEGER NOT NULL DEFAULT 0",        // migrate.ts ≈145
    "owner TEXT",                                      // migrate.ts ≈160 (issue #205; + backfill below)
  ],
  workflow_approvals: [
    "kind TEXT NOT NULL DEFAULT 'approve'",            // migrate.ts ≈174
    "artifact TEXT",                                   // migrate.ts ≈183
  ],
  executions: [
    "triggered_by TEXT",                               // migrate.ts ≈120 (issue #205)
    "trigger_actor_type TEXT",                         // migrate.ts ≈120 (issue #205)
    "session_id TEXT",                                 // migrate.ts ≈191
    "cost_usd REAL",                                   // migrate.ts ≈199-232 (loop)
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
        // owner (issue #205) carries a one-time data backfill in the same
        // guarded step (migrate.ts ≈159-168). sqlite-only json_extract — fine
        // here (this pre-step is sqlite-only); idempotent via WHERE owner IS NULL.
        if (table === "workflow_runs" && name === "owner") {
          await client.execute(
            `UPDATE workflow_runs SET owner = json_extract(context, '$.owner')
              WHERE owner IS NULL AND context IS NOT NULL`,
          );
        }
      }
    }
  }
  await rebuildMessagingIfLegacyUnique(client);
}
```

(The `idx_executions_workflow_run` index from `migrate.ts` ≈233-239 needs no
compat step — the baseline's `CREATE INDEX IF NOT EXISTS` handles it. The
`users` table is a plain `CREATE TABLE IF NOT EXISTS` (not an ALTER), so the
baseline creates it complete — no per-column compat entry is needed for it.)

**2. The messaging `UNIQUE(platform,…)` table rebuild**, ported verbatim in
spirit from `src/connectors/messaging/session-manager.ts:89-133` (SQLite's
official table-rebuild recipe: `foreign_keys` OFF outside the transaction,
copy → drop → rename, `foreign_key_check` **before** COMMIT, restore the
pragma). Mark it `// TODO(remove after v0.12)` — the migration ships in
v0.11 and this exists for exactly one more release after that.

**Do NOT use `executeMultiple()` inside the explicit `BEGIN`.** Verified
empirically (`@libsql/client` 0.15 and 0.17 alike): `executeMultiple` has a
`finally` block that force-rolls-back any open transaction when it returns,
so `BEGIN` → `executeMultiple(...)` → `COMMIT` silently undoes the rebuild
and the `COMMIT` then throws `cannot commit - no transaction is active` —
boot would fail on exactly the legacy DBs this shim exists for. One
`client.execute()` per statement instead:

```ts
// TODO(remove after v0.12): one-shot rebuild for pre-partial-unique-index DBs.
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
    // One execute() per statement — executeMultiple() force-rolls-back any
    // open transaction in its finally block (see note above).
    await client.execute("BEGIN");
    try {
      await client.execute(`CREATE TABLE messaging_sessions__new (
        id TEXT PRIMARY KEY, platform TEXT NOT NULL, channel_id TEXT NOT NULL,
        thread_id TEXT, user_id TEXT NOT NULL, agent_session_id TEXT,
        created_at TEXT NOT NULL, last_activity_at TEXT NOT NULL,
        message_count INTEGER DEFAULT 0, active INTEGER DEFAULT 1
      )`);
      await client.execute(`INSERT INTO messaging_sessions__new
        SELECT id, platform, channel_id, thread_id, user_id, agent_session_id,
               created_at, last_activity_at, message_count, active
        FROM messaging_sessions`);
      await client.execute("DROP TABLE messaging_sessions");
      await client.execute("ALTER TABLE messaging_sessions__new RENAME TO messaging_sessions");
      await client.execute(`CREATE INDEX IF NOT EXISTS idx_msg_sessions_lookup
        ON messaging_sessions(platform, channel_id, thread_id, user_id)`);
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

(The partial unique index is deliberately NOT recreated here — the baseline
migrator runs immediately after and its `CREATE UNIQUE INDEX IF NOT EXISTS`
covers it, same boot, before any writes.)

---

## `src/state/db.ts` rewrite

Keep the re-export block (`db.ts` ≈13-21) exactly as is — `db.ts` stays the
single import surface for `ExecutionRecord` / `WorkflowApproval` /
`WorkflowRun` / `User` / `TriggerActorType` / `TRIGGER_ACTOR_TYPES` /
`isTriggerActorType` / the store classes (incl. `UserStore`, issue #205). The
class becomes an async factory (import `UserStore` from `./user-store.js`
alongside the other stores):

```ts
import { createClient, type Client } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { migrate } from "drizzle-orm/libsql/migrator";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import * as sqliteSchema from "./schema/sqlite.js";
import { applyLegacySqliteCompat } from "./legacy-sqlite.js";
import type { StateClient, Dialect } from "./client.js";

// Resolves from BOTH src/state/ and dist/state/ to the apps/server/ package-root drizzle/sqlite.
const MIGRATIONS_DIR = fileURLToPath(new URL("../../drizzle/sqlite", import.meta.url));

export class StateDb {
  readonly executions: ExecutionStore;
  readonly approvals: ApprovalStore;
  readonly runs: WorkflowRunStore;
  readonly users: UserStore;        // issue #205
  readonly teams: TeamStore;        // issue #169 — TRANSACTS (4 sites)
  readonly feedback: FeedbackStore; // issue #255
  readonly cronRuns: CronRunStore;  // issues #341/#327

  private constructor(
    private readonly _client: StateClient,
    private readonly _dialect: Dialect,
    private readonly closer?: () => void,
  ) {
    // ONE serializer per CONNECTION, shared by every store that opens a
    // transaction (README locked decision 8). Store-scoped chains would leave
    // WorkflowRunStore's five named ops racing TeamStore's four on the same
    // libsql client, which is exactly the hazard the mutex exists to prevent.
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
db.ts:74) — but note it is **connection-scoped, and the libsql client
silently opens a NEW connection after every `transaction()` call** (verified;
same root cause as locked decision 12), so it only reliably covers the
pre-first-transaction window. The named-op mutex (locked decision 8) is the
real concurrency defense; keep the pragma as cheap best-effort.

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
| `markLatestAsFailed` :427 | **sql`` via `run()`** — `UPDATE … WHERE id = (SELECT id … ORDER BY started_at DESC LIMIT 1)` correlated subquery; return `changes(await run(...))` | set the failure via a **bound param**: `SET ${executions.success} = ${false}` (libsql binds `false` as 0, pg as boolean — verified portable). NEVER a literal `= 0`: PG rejects boolean=integer in both SET and WHERE |
| `recentExecutions` :445 / `allExecutions` :472 / `runningExecutions` :603 | builder full-row select — **this fixes the latent snake_case-cast bug** (README "Known bugs"); rows come back as real `ExecutionRecord`s (camelCase, boolean `success`) after `nullsToUndefined` | json/boolean mapped by builder |
| `consecutiveFailures` :455 | builder select `{ success }` desc limit 10; **`row.success === false`** (was `=== 0`, :465) | THE boolean-regression hotspot — pin with a test |
| `searchErrors` :487 | **sql`` via `rows()`** — `LIKE ? ESCAPE '\'` ×3 (builder `like()` has no ESCAPE). Use `likeEscape()` from dialect.ts (delete the inline :499 escape). Keep the aliases (:508-512); raw `success` stays 0/1 → keep the `Boolean(r.success)` mapping at :525 | raw = unmapped |
| `getExecutionsForWorkflowRun` :542 | **sql`` via `rows()`** — `(workflow_run_id = ? OR (workflow_run_id IS NULL AND trigger_id = ?)) AND skill LIKE ?`; keep the explicit aliased column list (:546-568) and the mapping block (:575-599) incl. `Boolean(r.success)` | raw = unmapped — the mapping block must now `JSON.parse` `extension_status`/`skills_status` into their object types (raw sql bypasses the json-mode mapping; `ExecutionRecord` types them as objects per Preconditions) |
| `executionStats` :612 | counts → builder (`select({ c: count() })`); the per-skill CASE rollup (:627-632) and per-trigger GROUP BY (:639-641) → **sql`` via `rows()`** with the portable CASE forms — successes: `SUM(CASE WHEN ${executions.success} THEN 1 ELSE 0 END)` (truthiness works on sqlite 0/1 and pg boolean; NULL falls to ELSE); failures: `SUM(CASE WHEN ${executions.success} = ${false} THEN 1 ELSE 0 END)` — the `${false}` is a **bound param** (libsql binds it as 0, pg as boolean — verified portable). Do NOT write `WHEN NOT ${col}` (NOT NULL is NULL; still-running rows must fall to ELSE in both dialects) and do NOT write a literal `= 0`/`= 1` (PG errors loudly: `operator does not exist: boolean = integer`) | same CASE forms reused by `dailyStats`/`hourlyStats` — which run in the Phase 4 PG leg, so a literal here WILL turn that leg red |
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

### `UserStore` (`src/state/user-store.ts`, issue #205)

All plain CRUD — no transactions, no sql-specific SQL — so every method moves
to the query builder. Both upserts key on **stable ids** (never on `email`,
which is non-unique): `getOrCreateUserByGithub` on `github_id`,
`upsertSlackUser` on `slack_user_id` / email-match / insert. Port the
read-then-write upserts to `.onConflictDoUpdate({ target, set })` on the
unique column (mirrors the cron/workflow-override upserts), or keep the
existing find-then-update/insert shape awaited — either is portable.

| Method (line) | Port | Notes |
|---|---|---|
| `getOrCreateUserByGithub` :74 | builder find-by-`github_id` then update-or-insert, OR `.onConflictDoUpdate({ target: users.githubId, set })` | refreshes login/name/email/avatar + `last_login_at`/`updated_at`; boolean flags mapped |
| `upsertSlackUser` :130 | builder: fast-path find by `slack_user_id` → update; else `findByEmail` → `linkSlackUser` + update; else insert a Slack-only row | `email` match is a plain `eq`, NOT unique |
| `linkSlackUser` :173 | builder update | |
| `getById` :180 / `findByGithubId` :187 / `findByLogin` :195 / `findBySlackUserId` :214 | builder select limit 1 | |
| `findByEmail` :207 | builder `orderBy(asc(users.createdAt)).limit(1)` — deterministic earliest match (`email` is non-unique) | |
| `deserialize` :221 | shrink to `nullsToUndefined` — builder rows are camelCase and `is_blocked` / `email_is_placeholder` arrive as real booleans (drop the `=== 1` compares at :230-231) | boolean columns |

No transactions or raw sql, so `UserStore` needs no `dbc` parameter and no
`rows()`/`run()` usage. Its `tests/state/user-store.test.ts` folds into the
Phase 3 factory.

### `UserStore` (`src/state/user-store.ts`) — 8 methods

Added 2026-08-18; the original plan predates this store. Mostly plain
builder CRUD (`getById`, `findByGithubId`, `findByLogin`, `findByEmail`,
`findBySlackUserId`, `linkSlackUser`). Two hazards:

- `getOrCreateUserByGithub` (`:74`) and `upsertSlackUser` (`:130`) are
  **lookup-then-insert** — the same race `SessionManager.getOrCreateSession`
  has (README locked decision 11). Under async they need the identical
  treatment: catch `isUniqueViolation(err)` on the insert and re-read. There
  are three column-level `UNIQUE`s on this table (`github_id`, `login`,
  `slack_user_id`), so the violation can come from any of them.
- **`user-store.ts:155` is `COALESCE(name, ?)` — argument order REVERSED** from
  every other COALESCE in the codebase: the *existing* value wins. Porting it
  as ordinary conditional key-spreading inverts the semantics. Keep it as an
  explicit `sql` expression, or spread only when the current value is null.
- `is_blocked` / `email_is_placeholder` have **zero write sites** — never add
  them to an insert; the DDL defaults are the only writer.

### `TeamStore` (`src/state/team-store.ts`) — 8 methods

**Four of the nine transaction sites live here** (`:81` `recordResolution`,
`:183` `invalidateLogin`, `:203` `invalidateTeam`, `:224` `invalidateAll`),
none with a CAS guard — they are all-or-nothing cache rewrites across the three
`github_team_*` tables. They must go through the **same connection-scoped
serializer** as `WorkflowRunStore`'s ops (README locked decision 8), or a team
resolution can overlap a run transaction on the shared libsql client.

- `recordResolution` uses **`INSERT OR IGNORE`** ×2 (`:98`, `:103`) →
  `.onConflictDoNothing()`.
- `reposForLogin` (`:154`) reads `COALESCE(t.truncated, 0)` over a **LEFT
  JOIN** (`:167`) — the NULL comes from the join, not the column, so the
  COALESCE is load-bearing and becomes `COALESCE(…, false)` on PG. The JS side
  then does `teams.some((t) => t.truncated === 1)` (`:176`), which must become
  `=== true` under boolean mode — the same silent-inversion class as
  `consecutiveFailures`.
- `invalidateTeam`'s `SELECT` (`:199-201`) currently sits **outside** the
  transaction. Preserve that, or move it inside deliberately — don't change it
  by accident while adding `await`s.
- Note the receiver is aliased as `this.store` in
  `engine/github/team-visibility.ts` — see the codemod traps above.

### `FeedbackStore` (`src/state/feedback-store.ts`) — 15 methods

**Read the NUL-byte trap above before running any sweep over this file.**

- Two `reactor IS ?` **null-safe compares** (`:249`, `:319`) — the idempotency
  predicate for signal recording. Port as
  `reactor == null ? isNull(col) : eq(col, reactor)`. Getting this wrong
  silently forks rows instead of matching, so double-reactions accumulate.
- `upsertAnchor` (`:138`) is an `ON CONFLICT DO UPDATE` arm with **seven**
  `COALESCE(excluded.x, feedback_anchors.x)` columns (`:147-154`) — Drizzle
  `.onConflictDoUpdate({ target, set })` with `sql\`coalesce(excluded…)\``
  per column.
- `dailyScores` (`:431`) uses `date(observed_at)` ×3 (`:451,457,458`) →
  `dayBucket()`. The plan's hotspot table only listed `ExecutionStore`'s
  rollups; this one is the same port.
- `anchorsToPoll` (`:204`) orders by `last_polled_at IS NOT NULL,
  last_polled_at ASC` (`:211`) — a boolean as a sort key. Portable, but pin it
  with a test.
- The `channel = ''` sentinel is **deliberate** (see Phase 1) — `channelKey()`
  at `:530-542` maps `'' ↔ null` at the boundary. Do not let a nullable
  Drizzle column quietly reintroduce NULLs there.
- `score` is a **real integer** (−2..+2), NOT a boolean. `SUM(CASE WHEN score
  > 0 …)` fragments at `:413-416` and `:453-455` are arithmetic and need no
  boolean port.

### `CronRunStore` (`src/state/cron-run-store.ts`) — 4 methods

Small, but carries **two of the three hard PG syntax errors** in the codebase:

- `latestByCron` (`:118`) is `SELECT * FROM ( … ) WHERE rn = 1` (`:121-126`)
  with **no alias on the derived table** — PG requires one. `rn` is a
  `ROW_NUMBER()`, an integer rank, so `rn = 1` is *not* a boolean literal to
  port.
- Both `latestByCron` (`:123`) and `recentFailures` (`:156`) order by
  `started_at DESC, rowid DESC`. **`rowid` does not exist in PostgreSQL**, and
  the docstring at `:146-150` says the tiebreak is load-bearing: without it,
  `recentFailures` reports 0 for an always-failing cron whose rows share a
  timestamp. Replace with a deterministic tiebreak (the TEXT `id`), don't drop
  it.
- `recentFailures` feeds the scheduler's failure alert
  (`cron/scheduler.ts:100`), so a silent regression here turns alerting off —
  the same failure shape as `consecutiveFailures`. Pin both with tests.

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

- **`src/index.ts:144-148`**:

  ```ts
  const db = await StateDb.open(config.dbPath);
  console.log(`[state] Database: ${config.dbPath}`);
  const sessionManager = new SessionManager(db.client, db.dialect);
  ```

  (`main()` is already async.) Also reword the stale better-sqlite3 comment
  at `src/index.ts:422-430` (ProgressNotifier timing rationale) — the
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

> ### 🛑 THIS SECTION WAS WRONG — corrected 2026-08-18
>
> The struck text below described the wire format as snake_case and instructed
> you to add an `executionToWire` re-serializer. **Implementing it would break
> the dashboard.** Issue #285 (2026-08-07) already fixed the raw-row leak this
> section was written to compensate for.
>
> **Actual contract today** (`dashboard/src/api.ts:55`, `Execution`):
> **camelCase**, with `success?: boolean` — `triggerType`, `triggerId`,
> `triggeredBy`, `owner`, `repo`, `issueNumber`, `startedAt`, `finishedAt`,
> `durationMs`, `workflowRunId`.
>
> `ExecutionStore.allExecutions` / `recentExecutions` / `runningExecutions`
> (`execution-store.ts:710,738,828`) now each select an explicit
> `EXECUTION_COLUMNS` list and map through `mapExecutionRow`, and the route
> (`admin/routes.ts:1470-1474`) passes the records straight through.
>
> **So there is nothing to re-serialize.** Drizzle's mapped camelCase rows are
> already the right shape, and `integer({mode:'boolean'})` on `success`
> produces exactly the `boolean | null` the dashboard type expects — the
> migration makes this contract *more* correct, not less. Delete
> `executionToWire` from your mental model entirely.
>
> The pin test below is still worth writing; it just pins **camelCase**. See
> the corrected assertions after the struck block.

~~- **`GET /admin/api/executions`** — the dashboard types this **snake_case**
  with integer success; the route MUST re-serialize via `executionToWire`
  (`trigger_type`, `started_at`, `success: 1|0|null`, `duration_ms`, …).~~
**STRUCK — see the correction above.** The route body is unchanged by this
phase.

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
`await StateDb.open(":memory:")` instead of a fake — safe here because
`recordStart`/`recordFinish` never transact, per locked decision 12). Seed one finished
(success), one failed, and one still-running execution via
`recordStart`/`recordFinish`, then `GET /executions` and assert the exact
wire keys and values, notably:

```ts
// CORRECTED 2026-08-18 — camelCase, boolean success.
expect(body.executions[0]).toMatchObject({
  triggerType: "webhook", triggerId: "owner/repo#1",
  startedAt: expect.any(String), durationMs: 1234, success: true,
});
// failed row — proves the boolean didn't invert:
expect(failedRow.success).toBe(false);
// still-running row — proves the TRI-STATE survived (null, not false):
expect(runningRow.success).toBeNull();
expect(runningRow.finishedAt).toBeNull();
// no snake_case regression:
expect(Object.keys(body.executions[0])).not.toContain("trigger_id");
```

The tri-state assertion is the load-bearing one. `success` is nullable by
design (`null` = still in flight, `execution-store.ts:211-213`), and the single
easiest way to break this migration is to declare the column `.notNull()` or
default it to `false` — after which every in-flight row reads as a failure and
the dashboard's outcome bars turn red for healthy runs.

## ~~Dispatcher behavior change (bug fix, visible)~~ — ALREADY FIXED

> **Struck 2026-08-18.** This section described `engine/dispatcher.ts`'s
> status-report handler reading `r.startedAt` / `r.issueNumber` as `undefined`
> because `runningExecutions()` cast raw snake_case rows. **Issue #285 fixed
> that on 2026-08-07** — `runningExecutions` (`execution-store.ts:828`) selects
> `EXECUTION_COLUMNS` and maps via `mapExecutionRow`, so those fields are
> populated today. There is no behaviour change to announce and no snapshot to
> update. Expect `/status` output to be **byte-identical** before and after this
> phase; if it changes, something is wrong.

---

## Test changes

- **Construction**: `new StateDb(":memory:")` in `tests/state/db.test.ts:8`
  and `tests/state/workflow-run-store.test.ts:12` becomes
  `db = await StateDb.open(tmpDbPath())` — a per-test **temp-FILE** DB
  (`mkdtemp` under `os.tmpdir()` + a `state.db` inside it), NOT `:memory:`.
  **Locked decision 12**: the libsql client opens a fresh connection after
  every `transaction()`, and a fresh `:memory:` connection is an empty
  database — both these files exercise the five named atomic ops, so on
  `:memory:` the DB would vanish after the first committed transaction.
  `:memory:` stays correct for suites that never transact (the
  schema-equivalence test, the session-manager tests, the wire pin test).
  (These are the only two real-StateDb constructions;
  `tests/workflows/runner.test.ts`, `phase-executor.test.ts`,
  `tests/engine/dispatcher.test.ts`, `tests/admin/*.test.ts` use fakes typed
  `as unknown as StateDb` — untouched beyond what 2a already did.)
- **`workflow-run-store.test.ts` rollback test** (:65-109, "injected
  collaborator"): the raw better-sqlite3 + `migrate()` construction becomes
  a second `await StateDb.open(tmpDbPath())` (file-backed — it transacts;
  locked decision 12) whose `client` is shared:
  `new WorkflowRunStore(inner.client, { approvals: throwingApprovals })`.
  The throwing `ApprovalStore` fake **still works**: `create()` throwing
  inside the async transaction callback rejects the callback promise and
  Drizzle rolls back — assert the run is still `running` with empty
  `phaseHistory`, exactly as today. Delete the `import { migrate }` and
  `import Database` lines.
- **`tests/connectors/messaging/session-manager.test.ts`**:
  - Fresh-path fixture (:17-18): `db = await StateDb.open(":memory:")`;
    `manager = new SessionManager(db.client, "sqlite")` (`:memory:` is safe
    here — SessionManager never opens a transaction). Direct
    `db.prepare(...)` assertions (e.g. :41-45) become libsql
    `raw.execute(...)` reads or builder queries — simplest is to keep a
    handle on a raw `createClient({ url: ":memory:" })`… which `open()`
    doesn't expose. Instead, do raw reads through
    `rows(db.client, sql\`SELECT …\`)`.
  - **Legacy fixtures** (:54-84 FK-referencing messages; :103-125
    unconditional UNIQUE) rebuild on libsql and now exercise
    `legacy-sqlite.ts` end-to-end:

    ```ts
    const raw = createClient({ url: ":memory:" });
    await raw.executeMultiple(LEGACY_DDL_AND_SEED);        // fine OUTSIDE a transaction — the
                                                           // finally-rollback hazard only bites
                                                           // after an explicit BEGIN
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

1. `grep -rn better-sqlite3 src tests` (from `apps/server/`) → must return
   **empty**. Known stragglers to sweep: `src/index.ts:422-430` (comment),
   `tests/connectors/slack/connector.test.ts:4`,
   `tests/connectors/messaging/session-manager.test.ts:2`,
   `tests/state/workflow-run-store.test.ts:2`,
   `src/state/user-store.ts:1` (its `import type Database` — issue #205; the
   store's `db: Database.Database` field becomes `StateClient`), and the
   deleted `src/state/migrate.ts`.
2. `pnpm --filter lastlight-core remove better-sqlite3 @types/better-sqlite3`.
3. `pnpm --filter lastlight-core build && pnpm --filter lastlight-core test` —
   full suite green without the module installed (catches any dynamic import).

## Verification

Beyond the standard `pnpm --filter lastlight-core build &&
pnpm --filter lastlight-core test` +
`pnpm --filter @lastlight/dashboard typecheck` (admin routes touched):

### Prod-shape smoke (mandatory — this is the phase that touches prod data)

1. Get a copy of the real DB into the scratchpad dir: locally
   `cp data/lastlight.db data/lastlight.db-wal data/lastlight.db-shm <scratch>/`
   if a dev copy exists; otherwise pull from prod (data lives in the docker
   volume `lastlight_agent-data` on the prod host — see local agent memory —
   e.g. `ssh root@<prod> docker run --rm -v lastlight_agent-data:/d alpine cat /d/lastlight.db > <scratch>/lastlight.db`,
   after a `PRAGMA wal_checkpoint(TRUNCATE)` so the WAL is folded in).
2. Boot the state layer against it:

   ```bash
   # from apps/server/
   pnpm --filter lastlight-core exec tsx --eval '
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
4. Optional full boot: `DB_PATH=<copy> pnpm --filter lastlight-core dev`, open the dashboard,
   confirm the workflow-runs list, a run's phase detail, and the chat
   sessions tab all show **historical** data (this exercises the wire-format
   mapping against real rows, including pre-`workflow_run_id` legacy rows).
5. Run the smoke **twice** on the same copy — second boot must be a no-op
   (idempotence of compat + migrator).

### Concurrency probe — `tests/state/concurrency.test.ts`

Guards the libsql interactive-transaction risk. On a **file-backed** DB
(`await StateDb.open(join(tmpDir, "probe.db"))` — `:memory:` can't surface
cross-transaction contention, and is destroyed by the first transaction
anyway; locked decision 12):

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
in-process mutex serializing the transacting ops is semantically free in a
single-writer process — build it in from the start; the probe below remains
as the regression guard.

**Corrected 2026-08-18: the chain is per-CONNECTION, not per-store.** The
original snippet made `opChain` a private field on `WorkflowRunStore`, which
was correct when that was the only store that transacted. `TeamStore` now
opens four more transactions on the same libsql client, so a store-scoped
chain leaves run-op-vs-team-op races completely unguarded. Own it next to the
client and inject it:

```ts
// state/client.ts
export type OpSerializer = <T>(fn: () => Promise<T>) => Promise<T>;

export function makeOpSerializer(): OpSerializer {
  let chain: Promise<unknown> = Promise.resolve();
  return <T>(fn: () => Promise<T>): Promise<T> => {
    const next = chain.then(fn, fn);   // run regardless of the previous outcome
    chain = next.catch(() => {});      // a rejection must not poison the chain
    return next;
  };
}

// WorkflowRunStore / TeamStore both receive the SAME instance from StateDb:
//   pauseForApproval  = this.serialize(() => this.client.transaction(...))
//   recordResolution  = this.serialize(() => this.client.transaction(...))
```

`StateDb.fromClient` must create one too (Phase 4's PGlite leg gets the same
guarantee — harmless there, and it keeps the two dialects behaviourally
identical). And the concurrency probe should race a **run op against a team
op**, not just two run ops — two run ops would still pass under the old
store-scoped chain, so that version of the test proves nothing about the bug
this correction fixes.

Keep the probe test — it's the regression guard for Phase 4's PG
transactions too (where the mutex is equally harmless).

## Risk watch-items

- **libsql interactive-transaction BUSY errors** on the local file client:
  drizzle's libsql transactions are real `BEGIN`-held transactions
  (`BEGIN IMMEDIATE` under the hood); two overlapping ones on one process
  surface `SQLITE_BUSY` (verified empirically) where better-sqlite3's sync
  transactions physically couldn't interleave. Mitigations: the named-op
  mutex (shipped by design, locked decision 8 — the load-bearing one),
  `busy_timeout=5000` pragma (best-effort only: it is connection-scoped and
  the client swaps connections after each transaction — see the db.ts
  section), the concurrency probe as regression guard.
- **`:memory:` + `client.transaction()` is fatal** (locked decision 12):
  after any transaction, the libsql client's next query runs on a NEW
  lazily-opened connection — on `:memory:` that is a fresh empty database,
  so the schema and all data silently vanish (verified: one committed
  transaction, then `db.all` fails "no such table"). Nothing in production
  uses `:memory:`; in tests, every suite that exercises the five named ops
  must be file-backed. If a test inexplicably loses its tables mid-run, this
  is the first suspect.
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
  `dist/state/` (compiled) to the `apps/server/` package-root `drizzle/`.
  Verify both: `pnpm --filter lastlight-core dev` boot and
  `pnpm --filter lastlight-core build && node -e 'import("./dist/state/db.js").then(m => m.StateDb.open(":memory:"))'`
  (the `node -e` run from `apps/server/`). (npm-tarball resolution is
  Phase 5's `files` change.)
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
- [ ] All four stores (incl. `UserStore`) + SessionManager contain zero
  `better-sqlite3` types, zero manual `JSON.parse`/`stringify` for json-mode
  columns, zero `=== 0`/`=== 1` boolean compares on mapped rows (UserStore's
  `is_blocked` / `email_is_placeholder` `=== 1` compares are gone).
- [ ] The five named ops run in `client.transaction`; the trailing-`dbc`
  participants are exactly the listed methods; rollback + double-responder
  tests green.
- [ ] `/admin/api/executions` returns snake_case (pin test green);
  `/workflow-runs*` responses byte-identical in shape to before;
  `pnpm --filter @lastlight/dashboard typecheck` green with **zero dashboard
  changes**.
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
