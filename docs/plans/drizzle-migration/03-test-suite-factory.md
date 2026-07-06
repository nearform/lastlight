# Phase 3 — Shared state test-suite factory

Read together with [README.md](README.md) and [00-architecture.md](00-architecture.md).

## Goal

Restructure the state-layer tests into a **dialect-parameterized suite
factory** so Phase 4 can run the exact same behavioral suite against PGlite
with a one-line runner. Small and mechanical: **no `src/` changes**, no new
assertions dropped, no test intent weakened. The deliverable is two factory
modules plus thin runner files; the total test count is unchanged.

Why a factory and not copy-paste: the PGlite leg (Phase 4) is only a
meaningful drift guard if it runs the *identical* test bodies — rollback
semantics, compare-and-set guards, stats bucketing, upsert overrides — not a
hand-maintained subset that silently diverges.

## Preconditions

- [ ] Phase 1 done (Drizzle sqlite schema + baseline migration exist).
- [ ] Phase 2 done (the combined async-API + engine-swap phase: store API is
  async; engine is libsql + Drizzle; tests construct via
  `await StateDb.open(":memory:")`; `SessionManager` takes
  `StateClient` + dialect; the legacy messaging fixtures run on libsql
  `executeMultiple` and exercise `legacy-sqlite.ts`; the concurrency probe
  test exists in `tests/state/concurrency.test.ts`; the `getOrCreateSession`
  race-guard test exists in the session-manager tests).
- `npx vitest run` green at the phase start. Record the total test count
  before touching anything — it is the invariant.

> The line numbers and describe titles below were captured against the
> pre-Phase-2a files. Phases 2a/2b will have edited every one of these files
> (async/await, `StateDb.open`, libsql fixtures). Match tests by **intent and
> describe/it title**, not by line number.

## Design: `tests/state/store-suite.ts`

Not named `*.test.ts` — vitest's include pattern is `tests/**/*.test.ts`
(`vitest.config.ts`), so the factory module is never collected as an empty
suite. It imports production code via the `#src` alias like every other test.

```ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { StateDb } from "#src/state/db.js";

export type Dialect = "sqlite" | "postgres";

export function runStateDbSuite(
  makeDb: () => Promise<StateDb>,
  opts: { dialect: Dialect },
): void { /* describe blocks below */ }
```

Internal structure — one top-level `describe(\`state stores [${opts.dialect}]\`)`
wrapping the existing describe blocks with their current titles preserved
(reviewability: the diff should read as a move, not a rewrite):

- `workflow_runs CRUD`, `getWorkflowRunByTrigger`, `activeWorkflowRuns`,
  `recentWorkflowRuns`, `cancelWorkflowRun`, `pauseWorkflowRun`,
  `workflow_approvals CRUD`, `dailyStats`, `context JSON round-trip`,
  `recordSkippedPhase`, `node_statuses store removed (issue #94)`
  (from `tests/state/db.test.ts`);
- `pauseForApproval`, `finishRun with a terminal marker`,
  `resolveGateAndResume`, `resolveGateAndFail`,
  `resolveReplyGateAndResume`, `hasRunForTrigger`, and the Phase 2b
  concurrency probe (from `tests/state/workflow-run-store.test.ts`).

**Lifecycle.** All shared state lives *inside* `runStateDbSuite` (never at
module scope — two invocations in one process must not collide):

```ts
let db: StateDb;
beforeEach(async () => { db = await makeDb(); });
afterEach(async () => { await db.close(); });
```

Fresh DB per test, closed after. This makes the old
`dailyStats`-suite `beforeEach` hack (`DELETE FROM executions`, needed because
better-sqlite3 resolved `:memory:` to a shared file path) obsolete — **delete
the hack, keep the tests**. Helpers (`makeRun`, `insertExecution`, `daysAgo`)
move into the factory as inner functions closing over `db`.

**Fixed-timestamp rule (load-bearing for Phase 4).** Every time-sensitive
assertion uses **fixed ISO-8601 strings**: a timestamp is materialized once as
a string, inserted, and the expected bucket key is derived by slicing *that
same string* (`iso.slice(0, 10)` daily / `iso.slice(0, 13)` hourly — matching
the `dayBucket()`/`hourBucket()` `substr` ports). Never re-format through
`new Date()` a second time, never compare against DB-generated clock values.
Nuance: `dailyStats(days)`/`hourlyStats(hours)` filter relative to wall-clock
now, so absolute literals rot out of the window — keep the `daysAgo(n)` helper
but pin it to **12:00:00.000Z UTC** (as today) from a single captured `Date`
per test, then treat its `.iso`/`.key` outputs as the fixed strings. This
guarantees byte-identical bucket keys on both dialects (Phase 4 asserts
exactly that). While moving, fix the one rotted case: `dailyStats` › "orders
results by date ascending" hardcodes `2026-04-08…10`, which already fall
outside the 30-day window (the assertion has degraded to ordering zero-filled
rows) — replace with `daysAgo(1..3)` values. That is an assertion
*strengthening*, which is allowed; weakening is not.

**Dialect-portable assertions.** Two current idioms need portable forms:

- *Unique-violation matching*: don't match `/UNIQUE/` (sqlite wording; PG says
  `duplicate key … 23505`). Assert via the `isUniqueViolation(err)` helper
  from `src/state/dialect.ts` (Phase 2b), or `expect(p).rejects.toSatisfy(isUniqueViolation)`.
- *Raw-SQL peeks*: any direct row inspection uses the Drizzle query builder on
  `db.client` (schema-typed, dialect-neutral), not raw dialect SQL strings.

**The throwing-approvals rollback fake** (currently `pauseForApproval` › "rolls
back the phase-history append when the approval store throws") **goes in the
factory** — it is the transaction-rollback proof and must run on PG too.
Post-2b it constructs a second `WorkflowRunStore` over the **same client** the
`StateDb` under test owns (use `db.client` / `db.dialect` and the store's
Phase 2b constructor shape) with a fake `ApprovalStore` whose `create()`
throws; assert the run is still `running` with empty `phaseHistory` after the
rejected `pauseForApproval`. Same pattern for the `resolveReplyGateAndResume`
BigInt-poison rollback test.

**The concurrency probe** (added in Phase 2b) also moves in: fire two
overlapping gate resolutions via `Promise.allSettled`, assert exactly one
fulfilled and one rejected, and that the DB lands in the single-winner state.
Dialect-neutral by construction (the compare-and-set + rollback contract).

## Design: `tests/connectors/messaging/session-manager-suite.ts`

`SessionManager` is not reachable through `StateDb` — post-2b it is
constructed from a `StateClient` + dialect (wired in `src/index.ts`). The
portable suite therefore takes its own context factory:

```ts
import type { StateClient } from "#src/state/client.js";
import type { SessionManager } from "#src/connectors/messaging/session-manager.js";

export interface SessionSuiteCtx {
  manager: SessionManager;
  client: StateClient;        // for direct-row assertions (audit trail, dup insert)
  close(): Promise<void>;
}

export function runSessionManagerSuite(
  makeCtx: () => Promise<SessionSuiteCtx>,
  opts: { dialect: Dialect },
): void;
```

Same lifecycle rule: fresh ctx per test in `beforeEach`, `close()` in
`afterEach`, no module-scope state. Portable tests inside (current titles):

- "returns the same active session for the same key" (get-or-create identity);
- "creates a new session after the old one is deactivated" — the audit-trail
  peek (two rows, one active) ports from raw `db.prepare(...)` to a Drizzle
  select on `ctx.client`;
- "partial unique index still prevents two active rows for the same key" —
  the duplicate insert goes through the query builder; the violation is
  asserted with `isUniqueViolation`, not `/UNIQUE/`;
- the Phase-2 `getOrCreateSession` race-guard test (two concurrent calls for
  the same fresh key resolve to the same session id) — dialect-neutral, moves
  into the portable set.

Worth adding while here (cheap, closes a gap the split exposes): a
message-append/`getHistory` round-trip test — `addMessage` twice,
`getHistory` returns both in order. New portable test; +1 to the count,
called out in Verification.

The two **legacy-rebuild tests** ("migrates a legacy schema with
FK-referencing messages…", "migrates a legacy table that has the old
unconditional UNIQUE constraint") are inherently sqlite-only — they build
legacy DDL fixtures and exercise the `legacy-sqlite.ts` pre-step. They move to
a separate file and are **not** parameterized.

## Test inventory

Counts are the pre-Phase-2 baseline (Phase 2 adds the concurrency probe,
the `getOrCreateSession` race test, the executions-wire pin test, and a
`consecutiveFailures` case; it doesn't change counts otherwise). Destinations:

| Current file › describe (tests) | Intent | Destination |
|---|---|---|
| db.test.ts › workflow_runs CRUD (6) | create/get, appendPhase, finishRun | factory |
| db.test.ts › node_statuses store removed (1) | API-shape regression (#94) | factory |
| db.test.ts › recordSkippedPhase (1) | skip rows re-evaluated by shouldRunPhase | factory |
| db.test.ts › getWorkflowRunByTrigger (4) | active-run lookup semantics | factory |
| db.test.ts › activeWorkflowRuns (1) | status filtering | factory |
| db.test.ts › recentWorkflowRuns (1) | limit + DESC ordering | factory |
| db.test.ts › cancelWorkflowRun (1) / pauseWorkflowRun (1) | status flips | factory |
| db.test.ts › workflow_approvals CRUD (10) | approval lifecycle reads/writes | factory |
| db.test.ts › dailyStats (6) | **stats bucketing** (fixed-ISO rule applies) | factory |
| db.test.ts › dailyStats `beforeEach` DELETE hack | shared-file workaround, not a test | deleted (obsolete) |
| db.test.ts › context JSON round-trip (2) | JSON column round-trip | factory |
| workflow-run-store.test.ts › pauseForApproval (2) | atomic op + **rollback via throwing fake** | factory |
| workflow-run-store.test.ts › finishRun w/ terminal marker (2) | marker append + error context | factory |
| workflow-run-store.test.ts › resolveGateAndResume (3) | **compare-and-set guards** (stale/unknown) | factory |
| workflow-run-store.test.ts › resolveGateAndFail (3) | reject path + stale guard + fallback error | factory |
| workflow-run-store.test.ts › resolveReplyGateAndResume (3) | reply gate, double-reply guard, poison rollback | factory |
| tests/state/concurrency.test.ts › probe (1, from Phase 2) | overlapping ops, single winner | factory (file deleted after move) |
| session-manager tests › getOrCreateSession race (1, from Phase 2) | concurrent create, one session | session factory |
| workflow-run-store.test.ts › hasRunForTrigger (4) | per-workflow trigger memory | factory |
| session-manager.test.ts › same-key identity (1) | get-or-create | session factory |
| session-manager.test.ts › new session after deactivation (1) | active-session uniqueness + audit trail | session factory |
| session-manager.test.ts › partial unique index (1) | two-active-rows rejection | session factory |
| *(new)* message append round-trip (1) | addMessage/getHistory ordering | session factory (added) |
| session-manager.test.ts › legacy FK migration (1) | legacy-sqlite.ts rebuild | sqlite-only legacy file |
| session-manager.test.ts › legacy UNIQUE rebuild (1) | legacy-sqlite.ts rebuild | sqlite-only legacy file |
| tests/state/schema-equivalence.test.ts (Phase 1/2b) | DDL proof artifact | untouched, sqlite-only |
| tests/state/build-assets.test.ts | filesystem-only store | untouched |

Nothing is deleted-as-duplicate; the only deletion is the non-test DELETE
hack. Other DB-touching suites (`tests/admin/routes.test.ts`,
`tests/engine/dispatcher.test.ts`, `tests/workflows/*.test.ts`, …) test their
own layers against a sqlite `StateDb` and are out of scope — do not move them.

## The thin runners

- **`tests/state/db.test.ts`** becomes the single sqlite runner (~6 lines):

  ```ts
  import { runStateDbSuite } from "./store-suite.js";
  import { StateDb } from "#src/state/db.js";

  runStateDbSuite(() => StateDb.open(":memory:"), { dialect: "sqlite" });
  ```

- **`tests/state/workflow-run-store.test.ts`** is **deleted** — its bodies
  live in the factory and run via the runner above. (Two runners both calling
  `runStateDbSuite` would double-run the suite.)
- **`tests/connectors/messaging/session-manager.test.ts`** becomes the thin
  sqlite runner for `runSessionManagerSuite`: its `makeCtx` opens a fresh
  in-memory client through the same construction path Phase 2b gave
  `src/index.ts` (migrated client → `new SessionManager(client, "sqlite")`),
  with `close()` closing the client.
- **`tests/connectors/messaging/session-manager.legacy.test.ts`** (new file):
  the two legacy-rebuild tests, verbatim as Phase 2b left them (libsql
  `executeMultiple` fixtures + `legacy-sqlite.ts`). Sqlite-only, no factory.

Phase 4 will add `tests/state/db.pg.test.ts` calling both factories with
PGlite-backed `makeDb`/`makeCtx` — nothing in this phase anticipates it beyond
the signatures above. Vitest's default per-file worker isolation (no `pool`
override in `vitest.config.ts`) means the two dialect runner files share no
module state; the factories' no-module-scope-state rule covers same-file reuse.

## Escape hatch: per-dialect skips

A test that genuinely cannot run on one dialect guards on `opts.dialect`:

```ts
// SQLITE-ONLY: exercises libsql PRAGMA behavior with no PG analogue.
const itSqlite = opts.dialect === "sqlite" ? it : it.skip;
itSqlite("…", async () => { … });
```

Rules: use `it.skip` (visible in output), never silent `return`; every use
carries a comment naming the reason; expected count of uses **in this phase:
zero** (anything sqlite-only belongs in the legacy/equivalence files, not the
factory). The hatch exists for Phase 4 discoveries, sparingly.

## Verification

```bash
npm run build && npx vitest run
```

- All green. Total test count = pre-phase count **+1** (the added
  message-append test) — no other delta. Compare `vitest run` summary lines
  before/after and paste both into the Deviations section.
- `git diff --stat` touches only `tests/` — **zero `src/` changes**.
- Grep-audit that no assertion got weakened in the move: the factory still
  contains the strings `not pending`, `approval insert failed`,
  `rejects` (rollback + guard tests), and the `phaseHistory).toEqual([])`
  post-rollback assertions.
- Run the state files twice in a row (`npx vitest run tests/state
  tests/connectors/messaging`) to confirm no cross-test leakage from the
  lifecycle change.

## Risk watch-items

- **Accidentally weakening assertions during the move** — the classic failure
  mode of test refactors. Move test bodies verbatim wherever possible; the
  only sanctioned edits are the mechanical portability ports listed above
  (unique-violation matcher, query-builder peeks, fixed-timestamp helper,
  rotted date literals). Anything else is a red flag in review.
- **Shared state between suite runs** — module-scope `let db` in a factory
  breaks the moment two invocations share a process (Phase 4 may co-locate
  legs). All mutable state inside the factory function; fresh DB per test.
- **Double-running the suite** — keep exactly one sqlite runner per factory.
- **Losing the rollback/concurrency tests to "sqlite-only" by reflex** — they
  are the point of the factory; they must be in the parameterized set.
- **`store-suite.ts` accidentally matching the test glob** — keep the
  `-suite.ts` suffix (not `.test.ts`), or vitest collects an empty file.

## Done criteria

- [ ] `tests/state/store-suite.ts` exports `runStateDbSuite(makeDb, opts)`;
      all mutable state function-scoped; fresh-DB-per-test lifecycle.
- [ ] `tests/connectors/messaging/session-manager-suite.ts` exports
      `runSessionManagerSuite(makeCtx, opts)` with the `SessionSuiteCtx` shape.
- [ ] Rollback fake, poison-scratch rollback, compare-and-set stale guards,
      concurrency probe, stats bucketing, and upsert/override coverage all
      live in the parameterized factory.
- [ ] Fixed-ISO timestamp rule applied to every stats/bucketing assertion;
      rotted `2026-04-*` literals replaced.
- [ ] Thin runners in place; `workflow-run-store.test.ts` deleted;
      `session-manager.legacy.test.ts` holds the two sqlite-only tests.
- [ ] Zero `opts.dialect` skips introduced.
- [ ] `npm run build && npx vitest run` green; count = before + 1; no `src/`
      diff.
- [ ] README checkbox ticked; deviations (incl. before/after test counts)
      appended to this doc.
