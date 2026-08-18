# Drizzle ORM migration — implementation plan index

Migrate Last Light's state layer from direct `better-sqlite3` to **Drizzle ORM**
with an **async store API** and **dual-dialect** (SQLite via libsql, Postgres)
support, so other databases become possible without a second rewrite.

This directory is the executable plan. Each phase doc is self-sufficient: an
agent with no prior context should be able to execute its phase from that doc
plus this README alone.

> **Reconciled 2026-08-18 (v0.25.9).** The plan was written 2026-07-06 and last
> revised 2026-07-24 at **v0.21.8**; the state layer roughly doubled in between.
> Phase 0 below re-derived every inventory against current `main`. The headline
> corrections — read these before anything else:
>
> | Previously stated | Corrected |
> |---|---|
> | 7–8 tables, 12–15 indexes | **15 tables, 25 named indexes** (+ `cron_runs`, `feedback_anchors`, `feedback_signals`, `github_teams`, `github_team_repos`, `github_team_members`, `github_visibility_sync`) |
> | 3 stores | **7 stores** (+ `UserStore`, `TeamStore`, `FeedbackStore`, `CronRunStore`); `state/` is ~4,700 LOC |
> | "the five named atomic ops" | **9 transaction sites** — 5 in `workflow-run-store.ts`, **4 in `team-store.ts`** |
> | `migrate.ts` DDL only | **530 lines including ordered DATA backfills** — see locked decision 14 |
> | *(unmentioned)* | **`packages/workflow-engine` owns a synchronous `WorkflowStateStore` port** — a second published package is in scope; see locked decision 13 |
> | `/admin/api/executions` is snake_case; re-serialize it | **Inverted — the wire format is camelCase with `success?: boolean`.** See "Hard constraints" |
>
> Baseline on the merged branch: **203 test files, 3,115 tests passing.**

## Status / todo list

Execute strictly in this order — each phase depends on the previous one and
each must leave the repo green before the next starts.

- [x] **Phase 0** — reconcile the branch and this plan with `main`: merge (not
  rebase — locked decision 6), verify green, and re-derive every schema /
  consumer / test inventory in the phase docs against current source.
- [ ] **Phase 1** — [01-schema-baseline.md](01-schema-baseline.md) — deps,
  Drizzle sqlite schema, idempotent baseline migration, schema-equivalence test
  *(risk: low)*
- [ ] **Phase 2** — [02b-engine-swap.md](02b-engine-swap.md) — async API flip
  **+** libsql/Drizzle engine swap, executed as ONE phase (locked decision 7).
  [02a-async-api.md](02a-async-api.md) is its reference appendix (consumer
  inventory, landmines, signature flips, fire-and-forget table, test tables) —
  not a standalone phase; its sync-twin scaffolding is struck. *(risk: HIGH —
  the crux)*
- [ ] **Phase 3** — [03-test-suite-factory.md](03-test-suite-factory.md) —
  shared state test-suite factory *(risk: low)*
- [ ] **Phase 4** — [04-postgres-pglite.md](04-postgres-pglite.md) — Postgres
  schema (jsonb), schema-parity test, PGlite test leg *(risk: medium)*
- [ ] **Phase 5** — [05-config-packaging-release.md](05-config-packaging-release.md)
  — config slot, Dockerfile, docs-sync, prod cutover runbook, npm release
  *(risk: low-medium)*
- [ ] **Phase 6 — DEFERRED, not in this PR** —
  [06-prod-postgres.md](06-prod-postgres.md) — **activate the
  production Postgres runtime**: driver-selectable PG pool (node-postgres default
  **or** Neon serverless via `drizzle-orm/neon-serverless`) + `pg` /
  `@neondatabase/serverless` runtime deps (lazy per-driver), `open()` builds a
  real PG client instead of throwing, full state suite green against a real
  Postgres server, `database.driver` slot, credential redaction, deploy docs +
  release. Amends locked decision 3 (test-only → operator-selectable). *(risk:
  medium)*

Architecture reference (read before any phase):
[00-architecture.md](00-architecture.md).

## How to work a phase

1. Read this README and [00-architecture.md](00-architecture.md), then your
   phase doc end-to-end before touching code.
2. Verify the phase's **preconditions** (previous phases' checkboxes ticked).
3. Execute the steps. The phase docs cite file paths and line numbers that were
   accurate when written — if a reference has drifted, trust the described
   pattern over the line number and note the drift.
4. Run the phase's **verification** section. Every phase must end with
   `pnpm --filter lastlight-core build && pnpm --filter lastlight-core test`
   green (plus `pnpm --filter @lastlight/dashboard typecheck` where admin
   routes are touched).
5. Tick the checkbox above, and record any deviations from the doc (what and
   why) in a short **Deviations** section appended to the phase doc itself.
6. Commit the phase as one or more focused commits; do not start the next phase
   in the same commit.

## Locked decisions (do not relitigate)

1. **Async store API** — sync-preserving would not enable other databases;
   the ripple (~15 consumer files, ~10 test files) is accepted.
2. **SQLite driver: libsql** (`drizzle-orm/libsql` + `@libsql/client`) —
   natively async so SQLite and PG code paths share one shape (including async
   transactions); prebuilt binaries let us drop `python3 make g++` from the
   Dockerfile; reads the existing `lastlight.db` via `file:` URL.
3. **PG scope**: working `pgTable` schema + dialect-ported SQL, state test suite
   green on PGlite in CI. **No prod PG deployment, no sqlite→pg data migration.**
   *(2026-08-18: Phase 6 would lift the first half, but it is **deferred out of
   this PR** — see decision 6. Through Phase 5, `StateDb.open()` throws on a
   `postgres://` URL and `pg` stays out of runtime deps. The "no sqlite→pg data
   migration" half holds permanently for now.)*
4. **Real JSON columns on Postgres** — `jsonb` (paired with sqlite
   `text({mode:'json'})`), not text-blob JSON.
5. Pin the latest **stable** drizzle-orm / drizzle-kit (the finius reference
   uses a v1 RC — do not copy that pin).

*Added after the 2026-07-06 plan grilling:*

6. **Feature branch until Phase 5, landing as ONE PR** — all phases land on the
   long-lived `drizzle-migration` branch; `main` stays deployable on
   better-sqlite3 for hotfixes throughout. The branch merges to `main` only as
   part of Phase 5 (immediately before the cutover runbook), so prod never meets
   the new engine via an incidental `lastlight server update`. Every phase must
   leave the **branch** green.
   *(2026-08-18 amendment: **merge `main` into the branch at the start of each
   session — do NOT rebase.** The original instruction was to rebase, but the
   diff fully rewrites `execution-store.ts` and `workflow-run-store.ts` (~1,000
   LOC each), so a rebase replays every migration commit over new state-layer
   work and re-resolves the same conflicts every time; a merge resolves each
   conflict once. Squash on final merge so the PR reads clean. Paired with a
   **soft freeze on `apps/server/src/state/**` and `migrate.ts` on `main`** —
   including the agent's own PRs — for the duration. **Phase 6 is out of scope
   for this PR.**)*
7. **Phases 2a+2b are ONE phase** ("Phase 2"). The intermediate
   async-over-sync state never ships, so the sync-twin scaffolding is
   deleted from the plan: transaction closures go straight to
   `client.transaction(async (tx) => …)`. 02a survives as the reference
   appendix for the ripple (inventories, landmines, fire-and-forget table);
   02b is the executable phase doc. The repo-green gate applies at the END of
   the combined phase — intermediate commits on the branch need not be green.
8. **The in-process mutex serializing the named atomic ops ships in
   Phase 2 by design**, not as a probe-failure fallback. The concurrency
   probe test remains as the regression guard.
   *(2026-08-18 correction: the mutex must be **connection-scoped, not
   store-scoped**. As originally written it was a `private opChain` field on
   `WorkflowRunStore` covering its five named ops — but Phase 0 found
   **`TeamStore` opens four more transactions** (`recordResolution`,
   `invalidateLogin`, `invalidateTeam`, `invalidateAll`) on the **same libsql
   client**. Two overlapping `client.transaction()` calls are hazardous
   regardless of which store started them, so a per-store chain would leave
   run-op-vs-team-op races completely unguarded. Own the chain next to the
   client — hand the same serializer to every store that transacts — and make
   the concurrency probe race a run op against a team op, not just two run
   ops.)*
9. **`StateDb.open(pathOrUrl)` normalizes both forms**: `:memory:` as-is,
   `file:` URLs as-is, `postgres(ql)://` throws (Phase 4), anything else is
   treated as a filesystem path (`resolve` + `file:` prefix). Callers —
   including Phase 5's `open(config.database.url ?? config.dbPath)` — never
   build `file:` URLs themselves. `close()` is `async (): Promise<void>`.
10. **`simple.ts` awaits `callbacks.onRunStart`** (try/catch-logged) before
    dispatching, killing the notifier-setup race (02a's R1) at the source.
11. **`SessionManager.getOrCreateSession` catches unique violations**
    (`isUniqueViolation` from `dialect.ts`) on the insert and re-reads —
    concurrent creates for the same key are now possible under the async
    engine and must resolve to the same session.

*Added after the 2026-07-09 pre-execution source + library re-verification:*

12. **Transaction-exercising tests use per-test temp-FILE DBs, never
    `:memory:`.** The libsql local client hands its single connection to each
    `client.transaction()` and lazily opens a NEW connection for the next
    query — on `:memory:` that new connection is a fresh, empty database, so
    the whole DB silently vanishes after the first committed transaction
    (verified empirically on `@libsql/client` 0.17). Same root cause:
    connection-scoped pragmas (`busy_timeout`) do not survive the first
    transaction, so the named-op mutex (decision 8) is the load-bearing
    concurrency defense, not the pragma. `:memory:` remains correct for
    suites that never run `client.transaction()` (schema-equivalence,
    session-manager, the wire pin test).

*Added after the 2026-08-18 Phase 0 reconciliation (v0.25.9):*

13. **The workflow-engine's `WorkflowStateStore` port flips to hard
    `Promise<T>`.** `packages/workflow-engine/src/ports/ports.ts` declares
    `RunStore` + `ExecutionLedger` synchronously; `StateDb` satisfies them
    structurally, fenced by
    `apps/server/tests/workflows/state-store-contract.test.ts`. An async
    `StateDb` breaks that, so **a second published package
    (`lastlight-workflow-engine`) is in scope.** No `Awaitable<T> = T |
    Promise<T>` compatibility shim: the package is public but consumed only
    inside this repo, so we take the clean break. `await` at all 23 engine call
    sites (18 in `core/phase-executor.ts`, 5 in `core/scheduler.ts`) and rewrite
    `test-support/fakes.ts`'s `InMemoryStateStore` async. Consequence: the
    release bumps cascade across **all five** published packages.

14. **The `migrate.ts` DATA backfills become journaled one-shot migrations**
    (`0001_backfill_*.sql`, …), not per-boot statements. `0000_baseline.sql`
    stays the idempotent no-op over prod's existing schema; the backfills run
    ONCE and are recorded in `__drizzle_migrations`. Their **ordering is
    load-bearing** — `workflow_runs`' owner/repo split must precede the
    `executions` one, which reads `workflow_runs.owner` back out. On a fresh DB
    they run against zero rows. This is the payoff of
    [issue #345](https://github.com/nearform/lastlight/issues/345): today they
    re-execute on every boot, idempotent only by hand-maintained convention.
    Because `0001+` are the first migrations that really WRITE to production
    data, the pre-cutover smoke against a real DB copy is mandatory.

15. **One shared test fixture.** There are **37 DB-touching test files with 44
    `new StateDb(":memory:")` sites and no shared helper** — each hand-rolls its
    own `beforeEach`/`afterEach`. Phase 3 adds
    `apps/server/tests/helpers/state-db.ts` exporting `makeTestDb()` (per-test
    `mkdtemp` + `StateDb.open()` + registered cleanup) and converts **every**
    site, transacting or not. One seam, so decision 12's hazard has exactly one
    place to be handled.

16. **Sub-agent strategy: exemplar first, then fan out.** The seam
    (`client.ts` / `dialect.ts` / `schema/`) and ONE hand-ported store
    (`ApprovalStore` — smallest, has both compare-and-set guards, is a
    transaction participant) are written serially to establish the conventions
    (`dbc` parameter, `changes()`, `nullsToUndefined`, raw-vs-builder). Only
    then do the remaining 6 stores fan out to parallel agents. The consumer
    ripple and the engine-port flip stay **serial** — they are a single
    compiler chase and do not parallelize.

## Hard constraints (verified against source at planning time)

> Path/tooling note: the state layer, tests, and `drizzle/` live in the
> **`apps/server/`** package (npm package name `lastlight-core`); the repo is
> **pnpm + Turborepo**. Source paths below read `apps/server/src/…`, tests
> `apps/server/tests/…`, and build/test/install commands are
> `pnpm --filter lastlight-core …` (see each phase doc). `package-lock.json`
> is now the repo-root `pnpm-lock.yaml` (one lockfile for the whole workspace).

- **evals barrel** (`src/evals-api.ts`) exports no DB types; `runWorkflow`'s
  `db?: StateDb` param is type-erased. Do NOT change the exported shapes of
  `ExecutorConfig` / `RunnerCallbacks` / `WorkflowResult` / `TemplateContext` /
  `WorkflowAssetConfig`. The workflow-execution path IS touched, so an **npm
  release is required at the end** (Phase 5).
- Prod runs a live, journal-less `lastlight.db` (+ WAL files). The baseline
  migration must be a **no-op on existing databases** and safe on fresh ones.
- `result.changes === 1` compare-and-set guards are the concurrency backbone
  of the approval/reply-gate lifecycle — rows-affected semantics must be
  preserved exactly (via the `changes()` helper).
- The long-running sandbox dispatch is deliberately **outside** DB
  transactions — keep it that way.
- **Dashboard wire contract — CORRECTED 2026-08-18, the old text was inverted
  and would have broken the dashboard.** `/admin/api/executions` returns
  **camelCase** with `success?: boolean` — `dashboard/src/api.ts:55` types
  `triggerType` / `triggerId` / `startedAt` / `durationMs` / `success?: boolean`.
  Issue #285 (2026-08-07) already fixed the raw-row leak: `allExecutions` now
  selects an explicit `EXECUTION_COLUMNS` list and maps through
  `mapExecutionRow`, and the route (`admin/routes.ts:1470`) passes the records
  straight through. **Do NOT write the `executionToWire` snake_case
  re-serializer 02b specifies** — Drizzle's camelCase mapped rows are already
  the correct shape, and boolean-mode `success` matches the dashboard type
  exactly. The pin test still gets written, but it pins **camelCase**: assert
  `success` is a boolean (and `null`/absent while running) and that no
  `trigger_id`-style key leaks. The dashboard itself must not need changes.
- CLI (`src/cli/*`) is HTTP-only — untouched. `src/state/build-assets.ts` is
  filesystem-only — untouched. Sandbox containers never open the state DB.

## Known bugs this migration fixes (do not "preserve" them)

- ~~`recentExecutions` / `allExecutions` / `runningExecutions` do `SELECT *` and
  cast raw snake_case rows to `ExecutionRecord`; `src/engine/dispatcher.ts`
  (status-report handler) reads `r.startedAt` / `r.issueNumber` — **undefined
  at runtime today**.~~ **ALREADY FIXED by #285 (2026-08-07)** — those methods
  now select an explicit `EXECUTION_COLUMNS` list and map via
  `mapExecutionRow`. Nothing to fix here; see the corrected wire-contract note
  above, which this bug's existence used to justify.
- **Still live:** `consecutiveFailures()` checks `row.success === 0`
  (`apps/server/src/state/execution-store.ts:731`); under boolean column mode
  this must become `=== false`. Pin it with a test — a silent inversion here
  turns every cron-failure alert off.

## Portability landmines found in Phase 0 (not in the original phase docs)

Two **exported raw-SQL string fragments** are concatenated into queries by their
callers, and both hardcode integer-boolean comparisons that PostgreSQL rejects
outright (`operator does not exist: boolean = integer`):

- `EXECUTION_OUTCOME_COLUMNS` (`apps/server/src/state/execution-store.ts:220`) —
  a `SUM(CASE WHEN success = 1 …)` / `success = 0` rollup consumed by **three**
  aggregations. It is deliberately held as one fragment so the three cannot
  disagree; keep that property when porting it to a `SQL` template with bound
  `${true}` / `${false}` params.
- `qualifiedRepoSql` (`apps/server/src/state/repo-ref.ts:101`).

Neither appears in 02b's porting table. Both must go through `dialect.ts`.
