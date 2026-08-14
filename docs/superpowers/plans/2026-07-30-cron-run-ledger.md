# Cron-run Ledger Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Revised 2026-08-14** alongside the design. The original five tasks assumed one
writer and left `withLedger` and the broken failure count alone; there are now
seven, adding "repoint `withLedger`" and "repair the scheduler alert (#327)".
Tasks 3 and 4 of the original are rewritten — their code substitutions no longer
match `main`, and one of them would have reopened a closed security hole.

**Goal:** Make every cron fire — scheduled or manual, workflow or handler — a
first-class persisted record at fire grain, so a zero-discovery fan-out shows as
a green "ran, scanned 14, found 0" event instead of silence, and the
consecutive-failure alert finally counts the right thing.

**Design:** [`../specs/2026-07-30-cron-run-ledger-design.md`](../specs/2026-07-30-cron-run-ledger-design.md)
**Closes:** nearform/lastlight#341, nearform/lastlight#327

**Architecture:** One `cron_runs` peer ledger table + `CronRunStore`. Two
writers — `makeCronRunner` (extracted from the inline closure in `index.ts`, for
`workflow:` crons) and `withLedger` (repointed off `executions`, for `handler:`
crons). Two readers — the scheduler's alert and `GET /crons` — both keyed on
`cron_name`, so the "which kind of cron is this" branch disappears.

**Tech Stack:** TypeScript (ESM, Node 22), better-sqlite3, Hono (admin API),
Vitest, React (dashboard), OpenTelemetry.

## Global Constraints

- Node 22 LTS, ESM only — relative imports carry `.js` extensions. Follow the
  files being edited (this package does not use the absolute-import rule).
- **Never `console.*` in runtime code.** Use `logger("cron")` /
  `logger("cron-handlers")`. Pass an `Error` as `err`; do not interpolate it.
- Migrations are idempotent: additive `CREATE TABLE IF NOT EXISTS` /
  `CREATE INDEX IF NOT EXISTS` in `src/state/migrate.ts`. No backfill.
- `WorkflowRunner` stays `(workflow, context) => Promise<void>`
  (`cron/scheduler.ts:44`) — do NOT change it.
- Status vocabulary is exactly `running` | `ok` | `partial` | `failed`. A no-op
  fire (0 discovered, 0 dispatched) is `ok`.
- OTel calls must be no-ops when telemetry is disabled.
- **Marker placement invariant:** cron YAML `context:` is spread *ahead* of the
  `_cron*` marker keys, never after. See Task 3 Step 3.
- Run tests from `apps/server`: `npx vitest run <path>`. Full gate from the repo
  root: `pnpm turbo run typecheck test build`.
- Commit after each task. Branch: `worktree-feat+cron-run-ledger` (push as
  `feat/cron-run-ledger` at PR time).

---

## Task 0: Environment baseline

**Files:** none (setup only)

- [ ] **Step 1: Install workspace deps**

The branch was rebased onto current `main` on 2026-08-14, so the worktree has no
`node_modules` yet. Run from the repo root: `pnpm install`
Expected: completes; `apps/server/node_modules` present.

- [ ] **Step 2: Establish a green baseline**

Run from the repo root: `pnpm --filter lastlight-core test`
Expected: PASS (docker/k8s ITs self-skip). If anything fails, STOP and report —
do not build on a red baseline.

---

## Task 1: `cron_runs` table + `CronRunStore`

**Files:**
- Modify: `apps/server/src/state/migrate.ts` (table + index after the
  `cron_overrides` block at :65)
- Create: `apps/server/src/state/cron-run-store.ts`
- Modify: `apps/server/src/state/db.ts` (export type + store, add
  `readonly cronRuns`, construct it)
- Test: `apps/server/tests/state/cron-run-store.test.ts`

**Interfaces produced:**

```ts
interface CronRunRecord {
  id: string; cronName: string;
  workflow: string | null; handler: string | null;
  source: "schedule" | "manual"; actor: string | null;
  startedAt: string; finishedAt: string | null;
  status: "running" | "ok" | "partial" | "failed";
  reposEligible: number | null; reposScanned: number | null;
  discovered: number | null; dispatched: number | null; failures: number | null;
  error: string | null;
}

class CronRunStore {
  start(meta: { cronName: string; workflow?: string | null; handler?: string | null;
                source: "schedule" | "manual"; actor: string | null }): string;
  finish(id: string, result: {
    status: "ok" | "partial" | "failed";
    reposEligible?: number | null; reposScanned?: number | null;
    discovered?: number | null; dispatched?: number | null; failures?: number | null;
    error?: string;
  }): void;
  latestByCron(): Map<string, CronRunRecord>;
  recentFailures(cronName: string): number;
}
// StateDb gains: readonly cronRuns: CronRunStore
```

- [ ] **Step 1: Write the failing test**

Create `apps/server/tests/state/cron-run-store.test.ts` covering:

1. `start()` inserts a `running` row with `finishedAt: null` and the actor;
   `finish()` stamps status, `finishedAt`, and all four counts.
2. `latestByCron()` returns the newest row per cron name.
3. `recentFailures()` counts consecutive non-`ok` terminal rows newest-first and
   resets to 0 after an `ok`.
4. `recentFailures()` **ignores a still-running row** — a fire in flight is not
   a failure.
5. A handler-shaped row: `handler` set, `workflow`/`dispatched`/`failures` NULL,
   round-trips through `latestByCron()`.

Use `new StateDb(":memory:")` in `beforeEach` and `db.close()` in `afterEach`.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/state/cron-run-store.test.ts`
Expected: FAIL — `db.cronRuns` is undefined / table missing.

- [ ] **Step 3: Add the table to `migrate.ts`**

Inside the `db.exec(\`…\`)` template, immediately after the `cron_overrides`
block:

```sql
    CREATE TABLE IF NOT EXISTS cron_runs (
      id TEXT PRIMARY KEY,
      cron_name TEXT NOT NULL,
      workflow TEXT,
      handler TEXT,
      source TEXT NOT NULL,
      actor TEXT,
      started_at TEXT NOT NULL,
      finished_at TEXT,
      status TEXT NOT NULL DEFAULT 'running',
      repos_eligible INTEGER,
      repos_scanned INTEGER,
      discovered INTEGER,
      dispatched INTEGER,
      failures INTEGER,
      error TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_cron_runs_name_started
      ON cron_runs(cron_name, started_at DESC);
```

- [ ] **Step 4: Create `CronRunStore`**

Create `apps/server/src/state/cron-run-store.ts` implementing the interface
above, modelled on `ExecutionStore`. Notes:

- `start()` generates the uuid (`randomUUID`) and returns it.
- `latestByCron()` joins against
  `SELECT cron_name, MAX(started_at) AS m FROM cron_runs GROUP BY cron_name`.
- `recentFailures()` selects `status` `WHERE cron_name = ? AND finished_at IS
  NOT NULL ORDER BY started_at DESC LIMIT 10`, then counts the leading run of
  non-`ok` statuses. Mirror the shape of `ExecutionStore.consecutiveFailures`
  (`execution-store.ts:721`) so the scheduler's call site changes key and table
  but not logic.
- Module docstring: state that this is the ONLY record a zero-discovery fire
  leaves, and that it is keyed on the CRON name — never the workflow — so manual
  dispatches of the same workflow cannot skew it.

- [ ] **Step 5: Wire into `StateDb`**

In `apps/server/src/state/db.ts`: add the import, re-export `CronRunRecord` and
`CronRunStore` beside the others, declare `readonly cronRuns: CronRunStore`, and
construct it on the shared connection alongside the other stores.

- [ ] **Step 6: Run test to verify it passes**

Run: `npx vitest run tests/state/cron-run-store.test.ts` → PASS.

- [ ] **Step 7: Commit**

```bash
git add apps/server/src/state/migrate.ts apps/server/src/state/cron-run-store.ts \
        apps/server/src/state/db.ts apps/server/tests/state/cron-run-store.test.ts
git commit -m "feat(state): add cron_runs ledger + CronRunStore"
```

---

## Task 2: `makeCronRunner` factory + telemetry helper

**Files:**
- Modify: `apps/server/src/telemetry/index.ts` (add `recordCronFire` after
  `recordWorkflowRunStart` at :296)
- Create: `apps/server/src/cron/runner.ts`
- Test: `apps/server/tests/cron/runner.test.ts`

**Interfaces produced:**

```ts
type CronDiscoverer = (repos: string[], gh: GitHubClient,
                       opts: { log?: (m: string) => void }) => Promise<DependencyPr[]>;

interface CronRunnerDeps {
  db: StateDb;
  github: GitHubClient | null;
  discoverers: Record<string, CronDiscoverer>;
  dispatch: CronDispatcher;
  /** Seam for issue #180 narrowing. Defaults to the real `resolveCronRepos`. */
  resolveRepos?: typeof resolveCronRepos;
}

function makeCronRunner(deps: CronRunnerDeps): WorkflowRunner;
function recordCronFire(attrs?: TelemetryAttributes): void;
```

> **Why `resolveRepos` is a dep:** the closure being extracted performs #180's
> per-repo narrowing inline (`index.ts:1347-1363`). Extracting it verbatim would
> either drop that narrowing or leave it untestable. It must stay, behind a seam.

- [ ] **Step 1: Write the failing test**

Create `apps/server/tests/cron/runner.test.ts` covering, with a real
`StateDb(":memory:")` and a fake dispatcher:

1. **Empty discovery** → one `ok` row, `discovered: 0`, `dispatched: 0`,
   `reposScanned` = the repo count, dispatcher never called.
2. **A dispatch failure** → `partial`, `failures: 1`, `discovered` set.
3. **Discovery throws** → `failed`, `error` contains the message, `finishedAt`
   stamped, and the runner **re-throws**.
4. **Non-discovery cron** → fans out per repo, `discovered` stays NULL,
   `source`/`actor` recorded from `_cronSource`/`_cronActor`, and the `_cron*`
   markers are **stripped** from each dispatched per-repo context.
5. **Repo narrowing** → with a stub `resolveRepos` returning a subset,
   `reposEligible` is the input count and `reposScanned` the narrowed count.
6. **`github: null`** → discoverer not called, `discovered: 0`, status `ok`.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/cron/runner.test.ts`
Expected: FAIL — `#src/cron/runner.js` has no export `makeCronRunner`.

- [ ] **Step 3: Add the telemetry helper**

In `apps/server/src/telemetry/index.ts`, after `recordWorkflowRunStart` (:296):

```ts
export function recordCronFire(attrs: TelemetryAttributes = {}): void {
  if (enabled) {
    meter().createCounter("lastlight.cron.fire").add(1,
      safeMetricAttributes({ ...attrs, surface: "cron" }));
  }
}
```

- [ ] **Step 4: Create the factory**

Create `apps/server/src/cron/runner.ts`. Move the body of the inline closure
(`src/index.ts:1319-1404`) across **unchanged** — including the #180 narrowing
and the existing `log.debug` / `log.info` discovery lines — then wrap it:

- On entry: `const id = db.cronRuns.start({ cronName, workflow, source, actor })`,
  reading `_cronName` (`CRON_NAME_KEY`), `_cronSource` (default `"schedule"`)
  and `_cronActor` (default `null`) off the context.
- Wrap the body in `withSpan("lastlight.cron.fire", …)`, setting the `cron.*`
  attributes from design §6, and call `recordCronFire`.
- In a `finally`: `db.cronRuns.finish(id, { status, ...counts, error })`.
  Derive `status`: threw → `failed`; `failures > 0` → `partial`; else `ok`.
- Emit the completion log line (design §7) at `info`/`warn`/`error` by status.
  This **replaces** the `failures > 0`-only warn at `index.ts:1401-1403`.
- Strip the `_cron*` markers from the per-repo / per-PR contexts before dispatch.
- Return `void`. Do not change `WorkflowRunner`.

**A fire with no `_cronName`** (a caller that built its own context) writes no
row and logs at `debug` — matching how `resolveCronRepos` already treats a
missing name as "use the list verbatim".

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run tests/cron/runner.test.ts` → PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/server/src/cron/runner.ts apps/server/src/telemetry/index.ts \
        apps/server/tests/cron/runner.test.ts
git commit -m "feat(cron): add makeCronRunner factory recording a cron_runs row per fire"
```

---

## Task 3: Integrate the factory + thread source/actor

**Files:**
- Modify: `apps/server/src/index.ts` (replace the inline closure)
- Modify: `apps/server/src/cron/jobs.ts` (add `_cronSource: "schedule"`)
- Modify: `apps/server/src/admin/routes.ts` (trigger endpoint stamps
  `_cronSource: "manual"` + `_cronActor`)
- Test: `apps/server/tests/admin/routes.test.ts`

> `_cronName` is **already threaded** on both paths (`cron/repo-crons.ts:52`,
> `cron/jobs.ts:144`, `admin/routes.ts:2646`) — issue #180 added it. Only
> `_cronSource` and `_cronActor` are new. Do not re-add `_cronName`.

- [ ] **Step 1: Write the failing test**

In `apps/server/tests/admin/routes.test.ts`, inside the
`POST /crons/:name/trigger` describe, assert the fired context carries
`_cronSource === "manual"` and has `_cronActor` present. Follow the file's
existing `makeConfig` / `request` helpers.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/admin/routes.test.ts -t "_cronSource"` → FAIL.

- [ ] **Step 3: Stamp the markers — PRESERVING SPREAD ORDER**

In `admin/routes.ts` the context is built at :2643-2648. Add the two new keys
**after** the `...defContext` spread, alongside the existing `CRON_NAME_KEY`:

```ts
const actor = actorFromContext(c);
const context = {
  repos: getManagedRepos(),
  ...defContext,                 // ← YAML first
  [CRON_NAME_KEY]: def.name,     // ← markers injected LAST
  _cronSource: "manual",
  _cronActor: actor ?? null,
  sender: actor,
};
```

> **DO NOT** move `...defContext` after the markers. The current order is
> deliberate — see the comment at :2637-2641 and `jobs.ts:140-143`. It stops a
> cron YAML's `context:` spoofing `_cronName` and making `resolveCronRepos`
> apply another cron's per-repo participation rules to this tick. The previous
> version of this plan proposed spreading `def.context` last, which would have
> reopened that hole.

Apply the same rule in `cron/jobs.ts`: add `_cronSource: "schedule"` beside the
existing `[CRON_NAME_KEY]: def.name` at :144, inside the same injected-last
block.

- [ ] **Step 4: Replace the inline runner**

In `src/index.ts`, replace the whole
`const cronRunner: WorkflowRunner = async (workflowName, context) => { … };`
block (:1319-1404) with:

```ts
const cronRunner: WorkflowRunner = makeCronRunner({
  db,
  github,
  discoverers: PR_DISCOVERERS,
  dispatch: dispatchWorkflow,
});
```

Add `import { makeCronRunner } from "./cron/runner.js";`. Then run
`rg -n "fanOutContexts|dispatchCronWorkflow|resolveCronRepos" src/index.ts` and
remove any import that is now unused. `PR_DISCOVERERS` (:1282) already matches
`Record<string, CronDiscoverer>`.

- [ ] **Step 5: Run tests + typecheck**

Run: `npx vitest run tests/admin/routes.test.ts tests/cron/` → PASS.
Run: `pnpm --filter lastlight-core typecheck` → no errors.

- [ ] **Step 6: Commit**

```bash
git add apps/server/src/index.ts apps/server/src/cron/jobs.ts \
        apps/server/src/admin/routes.ts apps/server/tests/admin/routes.test.ts
git commit -m "feat(cron): wire makeCronRunner and thread cron source/actor through both fire paths"
```

---

## Task 4: Repoint `withLedger` at the cron ledger

**Files:**
- Modify: `apps/server/src/cron/handlers.ts`
- Test: `apps/server/tests/cron/handlers.test.ts` (extend if present, else create)

- [ ] **Step 1: Write the failing test**

Assert that invoking a wrapped handler writes one **`cron_runs`** row with
`handler` set, status `ok`, and `workflow` / `dispatched` / `failures` /
`reposEligible` / `reposScanned` all NULL; and that a throwing handler writes
`failed` with the message in `error` **and re-throws** — the row is a record,
not a swallow.

> The repo counts are NULL by design, not by omission: `repo-digest` narrows its
> own list *inside* the handler and `CronHandler` returns `Promise<void>`
> (`cron/handlers.ts:45`), so the wrapper cannot see them. Do NOT widen
> `CronHandler` to fix this — see design §3.

- [ ] **Step 2: Run test to verify it fails** — it still writes `executions`.

- [ ] **Step 3: Repoint the writer**

In `withLedger` (`cron/handlers.ts:81`) swap `db.executions.recordStart` /
`recordFinish` for `db.cronRuns.start` / `finish`, passing
`{ cronName, handler: cronName, source, actor }`. Read `_cronSource` /
`_cronActor` off the context exactly as Task 2 does, defaulting to
`schedule` / `null`.

Keep everything else: the wrap stays at the registry (so admin "Run now" is
covered), and it still re-throws so the scheduler counts and the admin route
surfaces the error.

Update the module docstring (:19-34) — the ledger is now `cron_runs`, keyed on
the cron name for both kinds of cron. Keep the "revoked Slack token on Monday"
rationale; it is still exactly why this exists.

- [ ] **Step 4: Run tests** → PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/cron/handlers.ts apps/server/tests/cron/handlers.test.ts
git commit -m "refactor(cron): repoint withLedger from executions to the cron_runs ledger"
```

---

## Task 5: Repair the consecutive-failure alert (closes #327)

**Files:**
- Modify: `apps/server/src/cron/scheduler.ts`
- Test: `apps/server/tests/cron/scheduler.test.ts` (extend if present, else create)

- [ ] **Step 1: Write the failing test**

Three consecutive `failed` fires of one cron must make the scheduler log the
`ALERT: job has failed consecutively` line; two must not.

> **This test MUST fail against today's code.** #327 showed the branch is
> unreachable because `consecutiveFailures` always returns 0 — and that every
> existing test stubs it with `consecutiveFailures: () => 0`
> (`tests/cron/control-keys.test.ts:108`,
> `tests/admin/cron-participation.test.ts:120`,
> `tests/admin/crons-opted-in.test.ts:88`) — the exact value the real
> implementation always returns. The fake and the bug agree, so no existing test
> could tell them apart. Do NOT stub the store here; seed real rows.

- [ ] **Step 2: Run test to verify it fails** — the ALERT never logs.

- [ ] **Step 3: Repoint the query**

In `cron/scheduler.ts:89-90` replace:

```ts
const ledgerKey = job.workflow ?? job.name;
const failures = this.db.executions.consecutiveFailures(ledgerKey);
```

with:

```ts
const failures = this.db.cronRuns.recentFailures(job.name);
```

Update the surrounding comment: counting is now at **fire grain**, keyed on the
cron, so `MAX_CONSECUTIVE_FAILURES` means the same thing for every cron, a run
dispatched by `/api/run` or a GitHub comment cannot move it, and quota
deferrals / DAG-cascade skips are excluded by construction. Cite #327.

Leave the `// TODO: send alert` (:92) exactly as it is — delivery is explicitly
out of scope.

- [ ] **Step 4: Update the stale stubs**

The three test files above stub `executions.consecutiveFailures`. Point them at
`cronRuns.recentFailures`, or drop the stub where the test does not exercise
failure counting, so nothing depends on the removed call.

- [ ] **Step 5: Run tests** → PASS. Then `npx vitest run tests/cron/`.

- [ ] **Step 6: Commit**

```bash
git add apps/server/src/cron/scheduler.ts apps/server/tests/cron/
git commit -m "fix(cron): count consecutive failures per cron fire, making the alert reachable (#327)"
```

---

## Task 6: One read path on the dashboard

**Files:**
- Modify: `apps/server/src/admin/routes.ts` (`GET /crons`; delete
  `lastHandlerTick`)
- Modify: `apps/server/dashboard/src/api.ts` (`CronInfo`)
- Modify: `apps/server/dashboard/src/components/CronsList.tsx`
- Test: `apps/server/tests/admin/routes.test.ts`

- [ ] **Step 1: Write the failing test**

Seed a `cron_runs` row and assert `GET /crons` returns ledger-derived
`lastRun` / `lastStatus` / `recentFailures` plus `reposEligible` /
`reposScanned` / `discovered` / `dispatched`. **Assert it for a handler cron as
well as a workflow cron** — that case is the guard against regressing #333.

- [ ] **Step 2: Run test to verify it fails.**

- [ ] **Step 3: Rewire `GET /crons`**

Before the `defs.map(...)`, add
`const latestCronRuns = db.cronRuns.latestByCron();`. Inside the map, replace
the `recentFailures` line (:2481) and the
`def.workflow ? … : lastHandlerTick(…)` branch (:2484-2486) with:

```ts
const last = latestCronRuns.get(def.name) ?? null;
const recentFailures = db.cronRuns.recentFailures(def.name);
```

and return `lastRun: last?.startedAt ?? null`,
`lastStatus: last?.status ?? null`, `recentFailures`, plus the four counts.

Then **delete `lastHandlerTick()`** (:611-620) and its now-unused imports. The
whole point of keying on `cron_name` is that the branch disappears.

Note the status vocabulary the dashboard receives changes for workflow crons —
`ok` / `partial` / `failed` / `running` rather than
`succeeded` / `failed` / `running`. Step 5 must handle it.

- [ ] **Step 4: Extend `CronInfo`**

In `dashboard/src/api.ts:1086` add:

```ts
  handler: string | null;
  reposEligible: number | null;
  reposScanned: number | null;
  discovered: number | null;
  dispatched: number | null;
```

and widen `workflow` to `string | null`. The server has returned
`workflow: … ?? null` and `handler: … ?? null` since #333; this hand-maintained
mirror never caught up.

> **Widening this surfaces a live bug — expect breakage and fix it, don't
> suppress it.** `CronInfo.workflow: string` has been a lie since #333: the one
> handler cron (`repo-digest`) already receives `null` at runtime. Two
> consequences are in production right now, not introduced by this plan:
> the tooltips render "Run null now", and — because `lastHandlerTick` already
> populates `lastRun` (`routes.ts:2486`) while the button is only
> `disabled={!cron.lastRun}` — the open-runs button is **enabled** for
> `repo-digest` and calls `onOpenRuns(null)` when clicked.
>
> Six sites in `CronsList.tsx` read `cron.workflow`; only two of them fail to
> compile, because `${null}` is valid TypeScript. Step 5 handles all six. Do NOT
> reach for `!`, `as string`, or `?? ""` to quiet the compiler — that re-hides
> the bug this widening exists to expose.

- [ ] **Step 5: Render it, and handle a null `workflow` at all six sites**

`CronsList.tsx` reads `cron.workflow` at :125, :126, :130, :194, :196 and :228.
Only :125 and :194 break the build (`onOpenRuns` takes `string`, :27); the other
four are template interpolations that compile fine and print `null`. Fix all
six:

- **:125 and :194 — the "open runs" buttons.** A handler cron dispatches no
  workflow, so it has no `workflow_runs` to open; the button has nothing to show
  and must be **disabled** when `cron.workflow === null`, not passed a
  fallback. Guard the click (`cron.workflow && onOpenRuns(cron.workflow)`) so
  the narrowing is real rather than asserted, and extend the existing
  `disabled={!cron.lastRun}` at :195 to `disabled={!cron.lastRun ||
  !cron.workflow}`.
- **:126 and :228 — the `title` tooltips.** Use the cron's own name for a
  handler cron. Introduce one local at the top of `CronRow`:
  `const label = cron.workflow ?? cron.handler ?? cron.name;` and interpolate
  `label` at both.
- **:196 — the disabled button's tooltip.** It must say *why* it is disabled,
  and the two reasons differ. `"no runs yet"` is right for `!cron.lastRun` but
  wrong for a handler cron, which has fired plenty — it simply has no
  `workflow_runs` to open. Three-way it:

  ```tsx
  title={
    !cron.workflow ? `${label} runs in-process — no workflow runs to open`
    : cron.lastRun ? `Open recent runs of ${cron.workflow}`
    : "no runs yet"
  }
  ```
- **:130 — the subtitle line.** Render `label` too, so a handler cron shows its
  handler rather than a blank cell.

Then extend the status-badge colour map for `ok` and `partial` (`ok` reads as
success, `partial` as warning), and add a counts line under the "Last run" cell
(:198), shown only once a fire has been recorded:

```tsx
{cron.reposScanned !== null && (
  <div className="text-2xs text-base-content/40">
    scanned {cron.reposScanned}
    {cron.reposEligible !== null && cron.reposEligible !== cron.reposScanned
      && ` of ${cron.reposEligible}`}
    {cron.discovered !== null && ` · found ${cron.discovered}`}
    {cron.dispatched !== null && ` · dispatched ${cron.dispatched}`}
  </div>
)}
```

- [ ] **Step 6: Run tests + dashboard typecheck**

Run: `npx vitest run tests/admin/routes.test.ts` → PASS.
Run: `pnpm --filter @lastlight/dashboard typecheck` → no errors.

- [ ] **Step 7: Commit**

```bash
git add apps/server/src/admin/routes.ts apps/server/dashboard/src/api.ts \
        apps/server/dashboard/src/components/CronsList.tsx \
        apps/server/tests/admin/routes.test.ts
git commit -m "feat(dashboard): read one cron ledger for both cron kinds, surfacing fire counts"
```

---

## Task 7: Full gate + docs

**Files:**
- Modify: `apps/server/CLAUDE.md` (the `state/db.ts` table list, the State
  directory listing, and the `cron/handlers.ts` entry)
- Modify (maybe): `apps/server/spec/10-state.md`

- [ ] **Step 1: Run the full CI gate**

Run from the repo root: `pnpm turbo run typecheck test build`
Expected: all green. Fix anything red before proceeding.

- [ ] **Step 2: Update the dev guide**

`apps/server/CLAUDE.md` enumerates the DB tables in two places — the
`state/db.ts` entry under "Repo layout" and the `data/lastlight.db` entry under
"State directory". Add `cron_runs` to both: "one row per cron fire, scheduled or
manual, for workflow and handler crons alike".

Also correct the `cron/handlers.ts` entry, which currently states that
`withLedger` wraps handlers "in ONE `executions` row per invocation
(`trigger_type: \"cron\"`, `skill` = the cron's name)". That stops being true at
Task 4.

- [ ] **Step 3: Check the docs-sync hook**

The `docs-check` pre-commit hook maps changed source files to doc surfaces. Run
`prek run` and address anything it flags — `src/state/`, `src/cron/` and
`src/admin/routes.ts` are all in its map, and `apps/server/spec/10-state.md`
likely needs the new table too.

- [ ] **Step 4: Commit**

```bash
git add apps/server/CLAUDE.md apps/server/spec/
git commit -m "docs: record the cron_runs ledger and the repointed withLedger"
```

---

## Verification before PR

- [ ] `pnpm turbo run typecheck test build` green from the repo root.
- [ ] Manually fire a workflow cron via the dashboard's "Run now" and confirm a
      `cron_runs` row appears with `source: manual` and the actor set.
- [ ] Confirm a zero-discovery fire lands as `ok` with `discovered: 0`, and that
      the dashboard shows it green rather than blank.
- [ ] Confirm `repo-digest` (the one handler cron) still shows a last run and a
      failure count — the #333 regression guard, on real data.
- [ ] **Verify both OTel signals end-to-end.** A collector is available and the
      harness already exports to it, so this is not deferrable: confirm the
      `lastlight.cron.fire` span reaches Tempo and the counter reaches
      Prometheus (through the collector's `prometheus_remote_write` exporter),
      both carrying `cron.name` and `cron.status`.
- [ ] Confirm the ledger still fills with `LASTLIGHT_OTEL_ENABLED` unset — the
      dashboard must not depend on telemetry being on.
