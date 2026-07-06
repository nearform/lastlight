# Drizzle ORM migration — implementation plan index

Migrate Last Light's state layer from direct `better-sqlite3` to **Drizzle ORM**
with an **async store API** and **dual-dialect** (SQLite via libsql, Postgres)
support, so other databases become possible without a second rewrite.

This directory is the executable plan. Each phase doc is self-sufficient: an
agent with no prior context should be able to execute its phase from that doc
plus this README alone.

## Status / todo list

Execute strictly in this order — each phase depends on the previous one and
each must leave the repo green before the next starts.

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
   `npm run build && npx vitest run` green (plus `cd dashboard && npx tsc -b`
   where admin routes are touched).
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
3. **PG scope**: working `pgTable` schema + dialect-ported SQL, state test
   suite green on PGlite in CI. **No prod PG deployment, no sqlite→pg data
   migration.**
4. **Real JSON columns on Postgres** — `jsonb` (paired with sqlite
   `text({mode:'json'})`), not text-blob JSON.
5. Pin the latest **stable** drizzle-orm / drizzle-kit (the finius reference
   uses a v1 RC — do not copy that pin).

*Added after the 2026-07-06 plan grilling:*

6. **Feature branch until Phase 5** — all phases land on a long-lived
   `drizzle-migration` branch; `main` stays deployable on better-sqlite3 for
   hotfixes throughout. The branch merges to `main` only as part of Phase 5
   (immediately before the cutover runbook), so prod never meets the new
   engine via an incidental `lastlight server update`. Rebase the branch onto
   `main` before starting each phase; every phase must leave the **branch**
   green.
7. **Phases 2a+2b are ONE phase** ("Phase 2"). The intermediate
   async-over-sync state never ships, so the sync-twin scaffolding is
   deleted from the plan: transaction closures go straight to
   `client.transaction(async (tx) => …)`. 02a survives as the reference
   appendix for the ripple (inventories, landmines, fire-and-forget table);
   02b is the executable phase doc. The repo-green gate applies at the END of
   the combined phase — intermediate commits on the branch need not be green.
8. **The in-process mutex serializing the five named atomic ops ships in
   Phase 2 by design**, not as a probe-failure fallback. The concurrency
   probe test remains as the regression guard.
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

## Hard constraints (verified against source at planning time)

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
- Dashboard wire contract: `/admin/api/executions` returns **snake_case** rows
  today (`dashboard/src/api.ts` types `trigger_id`, `started_at`,
  `duration_ms`). Drizzle returns camelCase — the admin route must
  re-serialize to snake_case. The dashboard itself must not need changes.
- CLI (`src/cli/*`) is HTTP-only — untouched. `src/state/build-assets.ts` is
  filesystem-only — untouched. Sandbox containers never open the state DB.

## Known bugs this migration fixes (do not "preserve" them)

- `recentExecutions` / `allExecutions` / `runningExecutions` do `SELECT *` and
  cast raw snake_case rows to `ExecutionRecord`; `src/engine/dispatcher.ts`
  (status-report handler) reads `r.startedAt` / `r.issueNumber` — **undefined
  at runtime today**. Drizzle's mapped rows fix this for free.
- `consecutiveFailures()` checks `row.success === 0`; under boolean column
  mode this must become `=== false`.
