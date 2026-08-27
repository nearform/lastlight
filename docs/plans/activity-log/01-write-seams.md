# Phase 2 — the write seams

> **Status: implemented.** See the Execution notes at the end for what actually
> happened. The steps below are the plan **as originally written**, kept
> unchanged on purpose so the notes can argue against them.

Nineteen call sites, one helper, and the three `"admin"` literals. Every write is
**best-effort**: a store failure logs and is swallowed, never propagated.

Depends on Phase 1 ([00-schema.md](00-schema.md)).

## Why explicit calls and not middleware

Decision 2 in the [README](README.md). The short version: **there is nothing to
hang middleware on.** The server has no `app.onError`, no `app.notFound`, no
shared response helper, and three `app.use` calls in total — `authMiddleware` on
`/api/*` (`index.ts:1561`) and on the admin sub-app (`routes.ts:688`), plus a
static-file server for the dashboard bundle (`admin/index.ts:62`). Every route
returns `c.json(...)` inline.

A middleware could be built, and it would guarantee coverage. But it sees a
method and a path, so it would record `POST /crons/x/toggle` rather than
`cron.toggle`; it cannot see the value a toggle moved to; and it cannot tell a
domain-level denial from a 200, which is exactly what `outcome` is for.

The coverage that middleware would have bought is bought instead by a
**table-driven test** (below) that fails when a mutating route has no log line.

## The helper

```ts
/**
 * Record one activity row. BEST-EFFORT: never throws, never rejects, and a
 * store failure must not fail the action being recorded — the same posture as
 * #205's identity capture and every read in pr-state.ts.
 */
export async function recordActivity(db: StateDb, entry: ActivityEntry): Promise<void>;

/** The Hono-flavoured wrapper: derives actor + actorType from the request. */
export async function recordActivityFor(c: Context, db: StateDb, entry: ...): Promise<void>;
```

- `recordActivityFor` reads `actorFromContext(c)` (`admin/auth.ts:168`) for
  `actorLogin` and the token's `method` for `actorType`.
- Both `catch` everything and `log.warn("activity write failed", { err })` with
  `component: "activity"`.
- Both return `Promise<void>` and are **`await`ed** at the call site.
  `lint:promises` (run by `typecheck`) is the guard against a dropped promise —
  the Drizzle migration shipped 14 such bugs through a clean compiler
  (`src/state/CLAUDE.md:180`).

Placement: the pure half beside the store; the `Context` half in
`src/admin/activity.ts`, so nothing outside `admin/` gains a Hono edge.

**Where the actor is `undefined`.** `actorFromContext` is populated only when the
session token carries a `login` — GitHub OAuth, or Slack OAuth that matched a
`users` row. Password login and auth-disabled instances yield `undefined`, and
the row is written with `actor_login: null`. Do not substitute `"admin"` in the
log the way the routes do for their `updatedBy` columns: a null actor is a true
statement, and `"admin"` in an audit stream reads as a person.

## Admin routes

`src/admin/routes.ts`. All fifteen mutating routes, verified against
`grep -n 'app\.\(post\|put\|delete\|patch\)('`. **Place the call after the action
resolves**, so `outcome` reflects what happened rather than what was attempted.

| Line | Route | `action` | `target` | Notes |
|---|---|---|---|---|
| 968 | `POST /login` | `login` | — | `outcome: "denied"` on a bad password. **Actor is null here by construction** — the token does not exist yet |
| 1034 | `GET /oauth/slack/callback` | `login` | — | `actorType: "slack"`; actor is the matched `users.login`, else null |
| 1151 | `GET /oauth/github/callback` | `login` | — | `actorType: "github"`. `outcome: "denied"` on the org-membership rejection |
| 1429 | `DELETE /containers/:name` | `container.kill` | `container:<name>` | |
| 1649 | `POST /workflow-runs/:id/cancel` | `workflow.cancel` | `workflow_run:<id>` | already reads the actor |
| 1769 | `POST /workflow-runs/:id/retry` | `workflow.retry` | `workflow_run:<id>` | already reads the actor |
| 1858 | `POST /workflows/:name/toggle` | `workflow.toggle` | `workflow:<name>` | **fix the `"admin"` literal at `:1868`**; `detail: { enabled }` |
| 2261 | `PUT /artifacts/:owner/:repo/:key/:doc` | `artifact.edit` | `repo:<owner>/<repo>` | `detail: { key, doc }` |
| 2328 | `POST /approvals/:id/respond` | `approval.approve` \| `approval.reject` | `approval:<id>` | already reads the actor |
| 2501 | `POST /crons/:name/toggle` | `cron.toggle` | `cron:<name>` | **fix the `"admin"` literal at `:2511`**; `detail: { enabled }` |
| 2538 | `POST /crons/:name/schedule` | `config.edit` | `cron:<name>` | **fix the `"admin"` literal at `:2556`**; `detail: { schedule }` |
| 2570 | `DELETE /crons/:name/override` | `config.edit` | `cron:<name>` | `detail: { cleared: true }` |
| 2601 | `POST /crons/:name/trigger` | `cron.trigger` | `cron:<name>` | already reads the actor |
| 2688 | `POST /prs/:owner/:repo/:number/retry` | `pr.retry` | `pr:<owner>/<repo>#<n>` | already reads the actor; `detail: { note }` |
| 787 | `POST /me/repos/resync` | — | — | **deliberately not logged** — a self-service cache refresh |
| 996 | `POST /token/refresh` | — | — | **deliberately not logged** — a session slide, not an action |
| 888 | `POST /route-test` | — | — | **deliberately not logged** — hermetic dry-run, no side effects |

`POST /token/refresh` deserves the explicit note: it looks like an auth event,
but it fires on a timer from the dashboard and would drown the `login` rows it
sits next to.

## The three `"admin"` literals

`grep -n '"admin"' src/admin/routes.ts` gives eight hits. Five are the correct
`actorFromContext(c) ?? "admin"` fallback (`:1659`, `:1781`, `:2336`, `:2714`)
plus the logger name at `:105`. Three are the bug:

```
:1868   await db.setWorkflowEnabled(name, next, "admin");
:2511   await db.setCronOverride(name, { enabled: nextEnabled, updatedBy: "admin" });
:2556   await db.setCronOverride(name, { schedule, updatedBy: "admin" });
```

Each becomes `actorFromContext(c) ?? "admin"`, matching the four routes that
already do it. This is #205 work, but it belongs here (decision 7): these are the
config-edit actions this log exists to record, and logging them while they still
say `"admin"` would enshrine the bug in the audit stream instead of fixing it.

Their `updatedBy` columns keep the `?? "admin"` fallback — that is an existing
wire contract the dashboard renders. Only the **activity row** carries a null
actor when there is no login.

## Non-HTTP seams

**`workflow.trigger` — `src/index.ts`, inside `dispatchWorkflow` (`:417`).**
Write it after the actor is derived at `:657-673` and after the guards pass, so
a row exists only when a run does. **Gate on the actor type** (decision 3):

```ts
if (triggerActorType !== "cron" && triggerActorType !== "system") { … }
```

That one condition covers CLI `/api/run` + `/api/build`, the GitHub webhook,
Slack chat and PR fix — and excludes the cron fan-out, whose per-repo dispatches
are not user actions and would otherwise be the dominant row source. The
fan-out is recorded once, at its cause, by `cron.fire`.

**`approval.approve` / `approval.reject` — `src/engine/dispatcher.ts`,
`handleApprovalResponse` (`:991`).** This is the **Slack + GitHub approval choke
point**: a Slack button click and a `@bot approve` comment both land here, having
been routed at `:371`. One call covers both external routes and complements the
dashboard route at `routes.ts:2328`. It already has `decision`, `sender` and
`reason` in scope, and `deps.db` (`DispatchDeps.db`, `:76`).

`actorType` is `slack` when `envelope.type === "message"`, else `github` —
matching the derivation `dispatchWorkflow` already uses.

**`cron.fire` — `src/cron/runner.ts:119` and `src/cron/handlers.ts:101`.** Both
already call `db.cronRuns.start({ cronName, source, actor })` with exactly the
fields this row needs. Write beside each:

- `actorType: "cron"` and `actorLogin: null` for `source === "schedule"`;
- the real login (already on `_cronActor`, threaded from `routes.ts:2629`) with
  `actorType: "admin"` for `source === "manual"`.

A manual fire therefore writes **two** rows — `cron.trigger` at the route and
`cron.fire` at the runner — which is correct: they are the request and the
execution, they can disagree (a trigger that never fires is the interesting
case), and `cron_runs` already models the same pair.

> **Known gap, not introduced here.** Issue #346 records that `registerDirect`
> crons (`sandbox-sweep`, `feedback-poll`) write no `cron_runs` row. They will
> likewise write no `cron.fire` row. Fixing that is #346's job; this plan
> inherits its scope rather than widening.

## Tests

`tests/admin/activity-write.test.ts`, on the harness from
`tests/admin/feedback-routes.test.ts:1-78` — the `vi.mock` of `#src/logging/logger.js`
and `#src/admin/docker.js` (required: `routes.ts` pulls docker helpers at import
time), `makeTestDb()`, `createAdminRoutes(...)`, and `app.fetch` against a plain
`Request`. For authenticated cases use the `build(config)` + `createToken(SECRET, …)`
pattern from `tests/admin/me-repos.test.ts:41-58`.

Four things to prove:

1. **Exactly one row per action** — #206's acceptance criterion, asserted as a
   count, not a "contains".
2. **The right actor on the three de-hardcoded routes** — a token carrying
   `login: "someone"` produces `actor_login: "someone"`, not `"admin"`, on both
   the activity row and the `updatedBy` column.
3. **`outcome: "denied"`** on a rejected action (a bad password at `/login`, a
   failed org check at the GitHub callback).
4. **A store failure does not fail the action.** Stub `db.activity.record` to
   reject; assert the route still returns 200 and the underlying state change
   still happened. This is decision 5, and it is the test most likely to catch a
   regression later.

Plus the **route→verb pin**: enumerate the mutating routes (the same
`app.post|put|delete|patch` set this doc tabulates) and assert each is either in
the verb map or in an explicit `NOT_LOGGED` allowlist with a reason. That test is
what replaces middleware's coverage guarantee, and it is why the three
deliberate omissions above are written down rather than merely skipped.

`tests/cron/runner.test.ts` and `tests/cron/handler-crons.test.ts` already exist
and cover the `cron_runs` write; extend them for the paired `cron.fire` row.

## Verify

```bash
pnpm --filter lastlight-core test tests/admin tests/cron
pnpm --filter lastlight-core typecheck   # lint:promises catches a dropped await
```

## Done when

- All fifteen mutating routes either write a row or are in `NOT_LOGGED`.
- The three `"admin"` literals are gone.
- A scheduled cron fire writes one `cron.fire` and zero `workflow.trigger` rows,
  however many repos it fans out to.
- Stubbing the store to throw breaks no test but the one asserting it throws.

## Execution notes (27 Aug 2026)

Phase 2 landed. `pnpm turbo run typecheck test build` is green — 25/25 tasks,
3855 core tests. Five things the plan did not anticipate:

- **The helper had to split in two, and the plan put it in the wrong place.**
  It said "the `Context` half in `src/admin/activity.ts`", which is right, but
  the *pure* half cannot live there either: `engine/dispatcher.ts` and
  `cron/runner.ts` both write, and `engine/ → admin/` is the wrong direction.
  `recordActivity` therefore sits at **`src/activity.ts`**, a peer of
  `managed-repos.ts`, with `admin/activity.ts` holding only the Hono wrapper.
  `lint:boundaries` does not currently police that direction — this was caught
  by reading, not by the gate.

- **`actorFromContext` was not enough.** It surfaces the login but not *how* the
  person authenticated, and `actor_type` needs the latter. `authMiddleware` now
  also sets `actorMethod`, with a new `actorTypeFromContext()` beside the
  existing seam mapping `password → admin`, `github → github`, `slack → slack`.
  Additive, and it keeps the "one place reads the token" property #205
  established.

- **Nineteen call sites is really twenty-two**, because six routes write on
  *both* their success and their refusal path — a denied login, a locked
  artifact, a refused PR retry, a failed container kill. Those denials are a
  large part of what an audit stream is read for, so the extra rows are the
  feature rather than overhead. Still fifteen distinct actions.

- **`workflow.trigger` belongs in `onRunStart`, not at the top of
  `dispatchWorkflow`.** The plan said "after the guards pass", which is correct
  but underspecified: the run **id** does not exist until `runSimpleWorkflow`
  creates the row, and `onRunStart` is the callback that fires the moment it
  does. Writing earlier would have meant either no target or a row for a
  dispatch that was later refused.

- **A seventh thing that does not update itself, and it is not in the state
  layer.** `scripts/lint-floating-promises.mjs` carries an `ALLOWED` set keyed
  by **`file:line`** — two deliberately-unfixed `stream.writeSSE` calls in
  `routes.ts`. Adding two import lines shifted them from 452/458 to 454/460, so
  the gate failed pointing at SSE code this change never touched. The entries
  are updated and a comment now warns about the coupling. Deliberately **not**
  re-keyed on expression text: that file's own comment says to fix its contents
  in a change that is about SSE, and re-designing a gate as a drive-by is the
  same mistake in a different direction. Worth a maintainer's decision.

One thing the plan got right and is worth restating, because it looks like a
bug: a manual cron fire writes **two** rows — `cron.trigger` from the route and
`cron.fire` from the runner — and a PR retry likewise writes `pr.retry` plus a
`workflow.trigger` from the dispatch it starts. Those are the request and the
execution. They can disagree (a trigger that never fires, a retry the gate
refuses), and that disagreement is the interesting case.
