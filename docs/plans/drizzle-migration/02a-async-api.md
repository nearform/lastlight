# Phase 2 reference appendix — the async-API ripple (formerly Phase 2a)

> **NOT A STANDALONE PHASE** (README locked decision 7, 2026-07-06): this doc
> is executed **together with [02b-engine-swap.md](02b-engine-swap.md) as one
> combined Phase 2** — 02b is the phase doc, this is its ripple reference.
> Consequences for reading this file:
> - **Skip Approach step 2 entirely** (sync twins). There is no
>   async-over-better-sqlite3 waypoint; transaction closures go straight to
>   `client.transaction(async (tx) => …)` per 02b's Transaction plumbing.
>   Landmine **L7** and risk **R5** are moot (better-sqlite3 is deleted in the
>   same phase).
> - Construction sites change per 02b (`await StateDb.open(...)`), not the
>   "constructors stay `new StateDb(path)`" framing below.
> - Risk **R1** is resolved, not deferred: `simple.ts` awaits
>   `callbacks.onRunStart` (try/catch-logged) — README locked decision 10.
> - Verification runs ONCE, at the end of the combined phase (02b's
>   Verification section). Intermediate commits need not be green.
> - Everything else here — the method inventory, consumer inventory,
>   signature flips, landmines L1–L6/L8/L9, the fire-and-forget table, the
>   floating-promise audit, and the test-change tables — remains the
>   authoritative map of the ripple. Use it while executing 02b.

Read first: [README.md](README.md) (locked decisions, hard constraints) and
[00-architecture.md](00-architecture.md). This doc maps **the ripple**:
every public method of the five state-owning classes becomes `async`.

Line references were verified against source at planning time (2026-07-06). If
one has drifted, trust the described pattern.

## Goal

- `StateDb`, `ExecutionStore`, `ApprovalStore`, `WorkflowRunStore`, and
  `SessionManager` expose a fully `Promise`-returning public API (70 methods).
- Every consumer awaits (or deliberately `void`s) those calls; no floating
  promises introduced.
- ~~Constructors, the `db.database` getter, and all private helpers stay
  sync.~~ *(Combined phase: construction becomes `await StateDb.open(...)`
  per 02b; `get database()` is deleted.)*
- ~~The five named atomic ops keep their synchronous better-sqlite3
  transaction closures.~~ *(Combined phase: they become drizzle async
  transactions per 02b — no twins.)*
- `npm run build && npx vitest run` green; evals barrel type shapes unchanged.

## Preconditions

- [ ] Phase 1 complete (README checkbox ticked): drizzle deps installed, sqlite
  schema + baseline exist, `tests/state/schema-equivalence.test.ts` green.
  The ripple touches none of those files; the combined phase must start from
  a green repo.

## Approach

1. **Flip the five classes first** (`src/state/db.ts`,
   `src/state/execution-store.ts`, `src/state/approval-store.ts`,
   `src/state/workflow-run-store.ts`,
   `src/connectors/messaging/session-manager.ts`): add `async` + `Promise<T>`
   return types to every public method listed in the inventory. Bodies are
   unchanged (better-sqlite3 calls run sync inside the async function).
2. ~~**Sync twins for transaction participants.**~~ **STRUCK (locked decision
   7)** — in the combined Phase 2 the engine swaps in the same phase, so the
   transaction closures in `WorkflowRunStore` (`finishRun` :292,
   `pauseForApproval` :409, `resolveGateAndResume` :433,
   `resolveGateAndFail` :451, `resolveReplyGateAndResume` :470) are rewritten
   directly to `client.transaction(async (tx) => …)` with the trailing-`dbc`
   participant parameters — see 02b's "Transaction plumbing". No twins are
   ever built. (`StateDb.setCronOverride` :110 internally calls
   `this.getCronOverride` — just `await` it; no transaction involved.)
3. **`npm run build` and chase compiler errors outward.** tsc finds every
   call site whose *result is used* (`.length`, `.map`, `if (x)`, property
   access on `Promise<T>`). It does NOT find statement-position calls whose
   result is discarded — those are the floating-promise audit below.
4. **Flip the three transitive interfaces** the compiler will lead you to
   (detailed under "Signature flips"): `PhaseReporter.persistPhase/failWorkflow`,
   `SessionSource.listSessionIds/exists/getFilePath`, and `getJobs`.
5. Tests last (mostly mechanical `await`; see Test changes).

## Store API inventory (what becomes async)

Everything below gains `async` + `Promise<...>`. Return types keep their inner
type (e.g. `markStaleAsFailed(): number` → `Promise<number>`).

### StateDb — `src/state/db.ts` (9 methods)

| Method | Line |
|---|---|
| `getCronOverride` | :85 |
| `getAllCronOverrides` | :93 |
| `setCronOverride` | :110 (awaits `getCronOverride` internally) |
| `clearCronOverride` | :132 |
| `isWorkflowEnabled` | :152 |
| `getWorkflowOverride` | :160 |
| `getAllWorkflowOverrides` | :167 |
| `setWorkflowEnabled` | :179 |
| `close` | :207 (flip now — Phase 2b's libsql `close()` is async) |

Stays sync: constructor (:66), `get database()` (:203 — a getter can't be
async and SessionManager still takes the raw handle this phase), both private
`deserialize*` helpers.

### ExecutionStore — `src/state/execution-store.ts` (24 methods)

`recordStart` :68, `recordSessionId` :89, `recordOutputText` :100,
`getExecutionOutput` :105, `getPhaseOutput` :118, `recordFinish` :131,
`recordSkippedPhase` :199, `listChatThreads` :234, `getChatThread` :289,
`isRunning` :342, `isCompleted` :352, `shouldRunPhase` :369,
`markStaleAsFailed` :393, `markAllStaleForTrigger` :411,
`markLatestAsFailed` :427, `recentExecutions` :445, `consecutiveFailures` :455,
`allExecutions` :472, `searchErrors` :487, `getExecutionsForWorkflowRun` :542,
`runningExecutions` :603, `executionStats` :612, `dailyStats` :652,
`hourlyStats` :721.

### ApprovalStore — `src/state/approval-store.ts` (9 methods)

`create` :41, `resolveReplyGate` :77, `getPendingReplyGateByTrigger` :97,
`getById` :111, `getPendingForWorkflow` :117, `getPendingByTrigger` :125,
`listForWorkflow` :142, `listPending` :150, `respond` :165. `create` /
`respond` / `resolveReplyGate` / `getById` are transaction participants —
they gain the trailing `dbc` parameter per 02b's Transaction plumbing (no
sync twins; Approach step 2 is struck).

### WorkflowRunStore — `src/state/workflow-run-store.ts` (19 methods)

`createRun` :82, `mergeScratch` :111, `appendPhase` :134, `getRun` :146,
`getByTrigger` :152, `hasRunForTrigger` :168, `listActive` :178,
`listRecent` :186, `list` :203, `distinctNames` :261, `finishRun` :275,
`cancelRun` :309, `setPaused` :317, `setRunning` :325,
`incrementRestartCount` :338, `pauseForApproval` :403,
`resolveGateAndResume` :432, `resolveGateAndFail` :450,
`resolveReplyGateAndResume` :463. Private `flipFinished` (:298) and
`deserialize` (:350) stay private. The five named atomic ops become async
drizzle transactions (`client.transaction(async (tx) => …)`) whose
participants take the trailing `dbc` parameter — see 02b's Transaction
plumbing (no sync twins; Approach step 2 is struck).

### SessionManager — `src/connectors/messaging/session-manager.ts` (9 methods)

`getSession` :136, `getOrCreateSession` :142, `setAgentSessionId` :190,
`touchSession` :197, `deactivateSession` :206, `addMessage` :211,
`getHistory` :219, `hasActiveThread` :238, `cleanupStaleSessions` :250.
Stays sync: constructor (:15), private `migrate` (:20) and
`rebuildWithoutTableUnique` (:89) — they run in the constructor, which cannot
await; internals are still better-sqlite3 so this is fine until 2b.

## Consumer inventory

~124 direct production call sites (100 `db.runs./.executions./.approvals.`,
12 StateDb-own-method, 12 SessionManager), plus 7 `SessionSource` call sites
and 17 `PhaseReporter` callback sites affected by signature flips. Per file:

| File | Sites | Nature |
|---|---|---|
| `src/admin/routes.ts` | 27 store + 10 StateDb-own + 7 SessionSource | ~14 sync GET handlers flip to `async (c)`; two landmines (L5, L6) |
| `src/engine/dispatcher.ts` | 20 store + 3 sessionManager (:98, :776, :793) | all handlers already async; one `.then`-chain landmine (L8) |
| `src/workflows/phase-executor.ts` | 15 store | all in async methods; `onSessionId` landmine (L1); 17 `reporter.persistPhase/failWorkflow` sites (L4) |
| `src/workflows/resume.ts` | 10 store (:167, :258, :259, :311, :313, :320, :342, :354, :366, :370) | async fns; `persist` closure landmine (L3) |
| `src/workflows/simple.ts` | 8 store + `isWorkflowEnabled` :211 | `runSimpleWorkflow` / `handleExistingRun` already async — plain awaits (:261, :293, :470, :472, :480, :515, :525, :532) |
| `src/workflows/runner.ts` | 7 store (:163, :249, :256, :307, :322, :365, :439) | inside async `runWorkflow`; `persistPhase`/`failWorkflow` closures :241/:254 flip (L4) |
| `src/admin/chat-session-reader.ts` | 5 store (:40, :44, :48, :71, :86) | 3 methods flip sync→async → SessionSource interface change (L6) |
| `src/index.ts` | 4 store (:441, :443, :444, :655) + sessionManager :795 + `getJobs` :863 | `notifierOnRunStart` landmine (L2); construction :142/:146 **unchanged** |
| `src/engine/router.ts` | 3 store (:143, :173, :440) | `routeEvent` is async — plain awaits |
| `src/cron/scheduler.ts` | 1 (`consecutiveFailures` :59) | inside async Cron callback — plain await |
| `src/cron/jobs.ts` | 1 (`getAllCronOverrides` :28) | `getJobs` itself is sync → becomes async (L9) |
| `src/engine/chat/chat-runner.ts` | 6 sessionManager (:256, :260, :288, :394, :396, :398) | all in async `doTurn` — plain awaits |
| `src/connectors/messaging/base.ts` | 2 sessionManager (:58, :82) | `handleIncomingMessage` is async; :58 becomes `!(await …)` inside the condition |
| `src/admin/sessions.ts` | 0 store, but `SessionSource` :72-79 + `SessionReader` impls flip | **not in the original ripple list — discovered transitive file** (L6) |
| `src/engine/chat/chat.ts` | 0 | `_sessionManager` param :125 is unused — no edits |
| `src/connectors/messaging/index.ts` | 0 | re-export barrel — no edits |
| `src/connectors/slack/connector.ts` | 0 | passes sessionManager to `super()` :73-74 — no edits |
| `src/admin/index.ts` | 0 | wiring only (:18, :22) — no edits |

### Signature flips (sync functions whose type must change)

- **`PhaseReporter.persistPhase` / `.failWorkflow`**
  (`src/workflows/phase-executor.ts:92-94`): `void` → `Promise<void>`. The
  implementations are the sync closures in `runner.ts` :241 (`persistPhase`)
  and :254 (`failWorkflow`) — make them async and await
  `db.runs.appendPhase` / `db.runs.finishRun`. Then `await` all 17 call sites
  in phase-executor.ts: `persistPhase` at :481, :509, :750, :800, :837, :872,
  :1104, :1108, :1182, :1186, :1307, :1367; `failWorkflow` at :530, :767,
  :854, :974, :1266. All sit in async `PhaseExecutor` methods — mechanical.
- **`SessionSource.listSessionIds` / `.exists` / `.getFilePath`**
  (`src/admin/sessions.ts:72-79`): sync → `Promise<string[]>` /
  `Promise<boolean>` / `Promise<string | null>`, because
  `ChatSessionReader`'s implementations (:37, :43, :85) now await
  `db.executions.listChatThreads` / `getChatThread`. The fs-backed
  `SessionReader` (same file, :81+) gets `async` labels on its (still-sync)
  bodies. Consumers: `mountSessionRoutes` in `src/admin/routes.ts` — :231
  (`listSessionIds`), :258 (drop the now-redundant `Promise.resolve(...)`
  wrapper), :293, :305, :322 (`exists`), :326 (`getFilePath`) — plus the
  log-search handler :829 (`listSessionIds`). All already inside async
  handlers/closures.
- **`getJobs`** (`src/cron/jobs.ts:18`): `CronJob[]` →
  `Promise<CronJob[]>` (awaits `opts?.db?.getAllCronOverrides()` :28 —
  `await undefined` is fine, keep the `?? new Map()`). Sole caller:
  `src/index.ts:863` (`const jobs = await getJobs({ webhooksEnabled, db })`),
  already in the async boot function.

### Landmines — sync contexts that cannot simply await

- **L1 — `onSessionId` callback, `src/workflows/phase-executor.ts:318-322`.**
  `runPhaseWithDedup` hands `run()` a callback typed
  `(sessionId: string) => void`, invoked by the sandbox orchestrator
  mid-stream (sync context). It calls `db.executions.recordSessionId`. Do NOT
  flip the callback type (it threads through the executor stack). Instead:
  ```ts
  const result = await run((sessionId) => {
    void db.executions.recordSessionId(executionId, sessionId).catch((err) => {
      console.warn(`[runner] Failed to persist session id mid-run for ${phaseName}:`, err);
    });
  });
  ```
  Note the existing `try/catch` no longer catches — the handler must move to
  `.catch()`. Intentional fire-and-forget (mid-run best-effort update).
- **L2 — `notifierOnRunStart` + `persist`, `src/index.ts:439-467`.**
  `notifierOnRunStart` is declared `(runId: string): void` and its body reads
  `db.runs.getRun(runId)` (:441); the nested `persist` closure (:442-445)
  does a getRun + mergeScratch read-modify-write and is handed to the
  transports as `save: (id) => persist(...)` (:455, :466) — and the transport
  `save` type is sync (`src/notify/transports/github.ts:17`,
  `slack.ts:17`, invoked from :36/:37). Fix:
  - Make `notifierOnRunStart` async (`(runId: string): Promise<void>`); the
    wrapper at `src/index.ts:503-511` awaits it
    (`await notifierOnRunStart(runId)`). `RunnerCallbacks.onRunStart` is
    already `(runId) => Promise<void>` (`runner.ts:57`) — no exported-type
    change.
  - Make `persist` async; keep the transports' `save` type sync and call it
    fire-and-forget: `save: (id) => { void persist({ githubCommentId: id }).catch(() => {}); }`.
    Persisting the comment id is best-effort (a lost id only means a fresh
    status comment after a restart) — `void` is the right call here.
  - See risk watch-item R1 for the ordering caveat this introduces.
- **L3 — boot-recovery `persist`, `src/workflows/resume.ts:257-267`.** Same
  pattern as L2 inside `resumeSimpleRun` (async fn): sync `persist` closure
  (:257-260) calling `getRun` + `mergeScratch`, wired as
  `save: (id) => persist({ githubCommentId: id })` (:267). Same fix: async
  `persist`, `void`-with-catch at the `save` site.
- **L4 — `PhaseReporter` flip** — see Signature flips above.
- **L5 — `/crons` handler `.map` callback, `src/admin/routes.ts:1298-1330`.**
  `defs.map((def) => { … consecutiveFailures(def.workflow) …
  db.runs.listRecent(50).find(…) … })` calls two store methods inside a sync
  `.map` callback. Convert to a `for … of` loop building the array (do NOT
  `Promise.all(defs.map(async …))` — keep it serial and simple). While there,
  hoist `const recentRuns = await db.runs.listRecent(50);` above the loop —
  today it re-queries per definition.
- **L6 — `SessionSource` flip** — see Signature flips. The subtle part is that
  it drags `src/admin/sessions.ts` (not on the original consumer list) into
  the phase.
- **L7 — ~~transaction closures~~ MOOT** in the combined phase (no
  better-sqlite3 by phase end; closures are async drizzle transactions).
- **L8 — build dispatch `.then` chain, `src/engine/dispatcher.ts:449-470`.**
  `deps.dispatchWorkflow(…).then((result) => { deps.db.executions.recordFinish(…); … }).catch(…)`
  is a deliberate fire-and-forget (the handler returns while the build runs).
  Keep the chain un-awaited, but make the callback async and await inside:
  `.then(async (result) => { await deps.db.executions.recordFinish(…); … })`
  — the trailing `.catch` (:465) then also covers recordFinish rejections
  (which it silently didn't need to before). Same file, `runChatTurn`
  (:769-819) is a plain async fn — its recordStart/recordFinish sites
  (:781, :796, :816) take plain awaits.
- **L9 — `getJobs`** — see Signature flips.

### Fire-and-forget decision table

Every site where a store call's promise is deliberately not awaited must carry
an explicit `void …(…).catch(…)` (or feed an existing `.catch`), so the
floating-promise audit greps clean:

| Site | Decision |
|---|---|
| phase-executor.ts:318 `recordSessionId` (L1) | `void` + `.catch` — best-effort mid-run |
| index.ts:455/:466 + resume.ts:267 `save:` → `persist` (L2/L3) | `void` + `.catch` — best-effort handle persistence |
| dispatcher.ts:449 `.then` chain (L8) | chain stays un-awaited; `await` inside the async callback |
| simple.ts:321 `callbacks.onRunStart(workflowId).catch(…)` | **awaited** with try/catch-log (locked decision 10 — notifier setup must complete before the first reporter call) |
| Everything else | `await` |

### Evals barrel check (`src/evals-api.ts`)

No exported shape changes: `runWorkflow` is already `async` (:21 re-export;
`runner.ts:140`); its `db?: StateDb` parameter is type-erased at the barrel;
`RunnerCallbacks` fields were Promise-returning already (`runner.ts:43-57`);
`WorkflowResult` / `ExecutorConfig` / `TemplateContext` /
`WorkflowAssetConfig` untouched. Verify by diffing
`npx tsc --emitDeclarationOnly` output for `evals-api` before/after, or simply
confirm no edits land in the files behind those five exports' type shapes.

## Floating-promise audit

`tsc` does **not** flag a statement-position `db.runs.finishRun(…)` whose
promise is dropped — the phase's one real hazard. After the compiler is green,
run:

```bash
# store calls not preceded by await/void/return on the same line
grep -rnE '(db|stateDb)\??\.(runs|executions|approvals)\.[a-zA-Z]+\(' src --include='*.ts' \
  | grep -v 'src/state/' | grep -vE '(await|void|return|=>)\s+[a-zA-Z._?]*db\??\.' \
  | grep -vE '(await|void|return) '
# SessionManager calls
grep -rnE '(sessionManager|this\.sessionManager|deps\.sessionManager)\.[a-zA-Z]+\(' src --include='*.ts' \
  | grep -v session-manager.ts | grep -vE '(await|void|return) '
# StateDb own methods
grep -rnE '\bdb\.(get|set|clear)[A-Za-z]*Override|db\.isWorkflowEnabled|db\.setWorkflowEnabled|db\.close\(' src --include='*.ts' \
  | grep -v 'src/state/' | grep -vE '(await|void|return) '
```

Review every hit by hand against the fire-and-forget table — the greps
over-match (multi-line calls, awaits on the previous line), but the review is
minutes, not hours. Optionally run a one-off
`@typescript-eslint/no-floating-promises` pass (needs `parserOptions.project`;
a scratch eslint config in the scratchpad dir is fine — don't commit lint
infra in this phase).

## Test changes

`await` of a non-promise value works at runtime, so **untyped** mocks
(`vi.fn(() => …)` inside an object cast `as unknown as StateDb` / `as any`)
need no changes. Only **typed** mock surfaces break compilation.

| File | Change |
|---|---|
| `tests/state/db.test.ts` | 34 tests, ~82 real-StateDb call sites: mechanical `await` + `async ()` test callbacks; `db.close()` in teardown gains await |
| `tests/state/workflow-run-store.test.ts` | 17 tests, ~45 sites: awaits, plus 6 throw assertions flip to `await expect(…).rejects.toThrow(…)` — :101, :160, :176, :196, :292, :312 |
| `tests/connectors/messaging/session-manager.test.ts` | awaits on `manager.*` (:26-27, :33-35, :151, …). The legacy-rebuild fixtures and `expect(() => …).toThrow(/FOREIGN KEY|UNIQUE/)` at :98, :133, :159 wrap **raw better-sqlite3 statements** — unchanged. `new SessionManager(legacy)` (:87, :136) stays sync — unchanged |
| `tests/connectors/slack/connector.test.ts` | constructs a real `SessionManager` (:64) but never calls it directly — expect compile-only/no edits; re-run to confirm event-emission timing (base.ts now awaits before `emit`) |
| `tests/admin/routes.test.ts` | `mockDb` (:41-57) is cast `as unknown as StateDb` — no edits needed; handlers exercised via `await app.request(…)` already |
| `tests/admin/log-search.test.ts` | `makeDb` (:16-21) and `makeSessions` (:29-35) are casts — no edits; the SessionSource mock's `listSessionIds: vi.fn(() => ids)` keeps working under `await` |
| `tests/admin/server-logs.test.ts` | empty store stub (:35) — compile-only |
| `tests/admin/sessions.test.ts` | calls `SessionReader.listSessionIds()` directly — :46, :58, :72, :84 (+ any later) gain `await` and async test callbacks |
| `tests/workflows/runner.test.ts` | `makeMockDb` (:415) is a cast — vi.fn impls fine. **Typed** `vi.mocked(db.executions.shouldRunPhase)` sites :680, :1278, :1334 need `mockImplementation(async …)` (or `mockResolvedValue`); :1289 reads `.mock.calls` — unchanged |
| `tests/workflows/phase-executor.test.ts` | `makeMockDb` (:121-148) cast — fine. Typed sites: :272, :285 `mockReturnValue("running"/"done")` → `mockResolvedValue(…)`; :469, :472 `mockImplementation` → async impl |
| `tests/engine/dispatcher.test.ts` | `mockDb()` factory (:31+) built from untyped `vi.fn().mockReturnValue(…)` and injected `as any` — no mock edits. Watch assertions that run after `dispatch()` resolves but depend on the L8 `.then` chain — they already flush today; re-run and fix any that newly race with an extra `await vi.waitFor` only if needed |

Rule of thumb: chase the compiler in tests too; then eyeball assertions on
now-async return values (`expect(db.runs.getRun(id)).toBeNull()` compiles
against a Promise and always fails — tsc catches most of these via
`toEqual` type-checking, but `toBeNull`/`toBeDefined` on a Promise does NOT
error — grep tests for `expect((db|manager)\.` without `await` as a final
sweep).

## Verification

```bash
npm run build            # zero errors — the compiler is the primary tool
npx vitest run           # full suite green, same test count as before
cd dashboard && npx tsc -b   # admin routes touched (handler asyncification);
                             # wire shapes unchanged, this is the proof
```

Optional prod-shape sanity (cheap, recommended): `npm run dev` against a
scratch `STATE_DIR`, hit `GET /admin/api/executions` and
`GET /admin/api/workflow-runs` and confirm snake_case rows still flow (this
phase must not change the wire format — that contract is pinned in 2b).

## Risk watch-items

- **R1 — notifier setup ordering — RESOLVED (locked decision 10).**
  `simple.ts:320-325` currently fire-and-forgets `callbacks.onRunStart`, and
  the comment at `index.ts:505-507` relies on `notifierOnRunStart` doing its
  setup *synchronously* before `reporter.start()` fires — a guarantee that
  dies with the sync engine. Fix in the combined phase: `simple.ts` awaits
  `onRunStart` in a try/catch (log the failure, continue the run) before
  dispatching, so notifier state exists before the first reporter call.
  Reword the `index.ts:403-406` comment accordingly (02b already notes this).
- **R2 — dedup check-then-act window.** `shouldRunPhase` → `recordStart`
  (`phase-executor.ts:288-306`) was one sync block; it now has microtask
  yields between the check and the insert. Concurrent same-phase dispatch is
  already guarded upstream (`dispatcher.ts:122` isRunning + workflow-run
  scoping), so this is theoretical in 2a — but note it in the commit message;
  it becomes 2b's concurrency-probe territory.
- **R3 — error paths moving out of try/catch.** Every L1/L2/L3 `void` site
  moves failure handling from an enclosing `try/catch` to a `.catch()` —
  verify each has one (the audit greps treat a bare `void x()` without
  `.catch` as a finding).
- **R4 — do not touch** the dashboard, `src/cli/*`, or
  `src/state/build-assets.ts`. (`src/state/migrate.ts` IS deleted and
  construction DOES become `await StateDb.open(...)` — but per 02b's specs,
  not ad hoc; the combined phase supersedes this item's old "stays
  `new StateDb(path)`" framing.)
- **R5 — MOOT** (see L7; combined phase uses async drizzle transactions).

## Done criteria

> **Done criteria below are folded into 02b's** — verify there, once, at the
> end of the combined phase. The twin criterion is struck (locked decision 7).

- [ ] All 70 public methods across the five classes return `Promise<…>`.
- [ ] ~~Sync twins…~~ struck — transaction closures are async drizzle
      transactions (02b).
- [ ] `PhaseReporter`, `SessionSource`, and `getJobs` signatures flipped;
      all transitive callers await.
- [ ] Fire-and-forget table implemented verbatim (`void` + `.catch` at L1,
      L2/L3 save sites; async callback inside the L8 chain).
- [ ] Floating-promise greps reviewed; every un-awaited store call is on the
      fire-and-forget table.
- [ ] `src/evals-api.ts` untouched; no exported type shape changed.
- [ ] `npm run build && npx vitest run` green; `cd dashboard && npx tsc -b`
      green; test count unchanged.
- [ ] Covered by README.md's single **Phase 2** checkbox (ticked via 02b's
      done criteria); deviations (if any) appended to 02b's Deviations section.
