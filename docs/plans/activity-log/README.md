# Activity log — design

One append-only stream of **who did what, when, and what came of it** — across
the dashboard, the CLI, Slack, GitHub and cron.

Today that question has no answer. #205 established real identity and put an
actor on every run and execution, but the actor is **scattered across five
ledgers** and several actions leave no trace at all:

| Where an actor lives today | Table / column |
|---|---|
| A run's origin | `workflow_runs.triggered_by` + `trigger_actor_type` |
| Who retried, cancelled, or ran a phase | `executions.triggered_by` |
| Who answered an approval gate | `workflow_approvals.responded_by` |
| Who changed a cron | `cron_overrides.updated_by` |
| Who flipped a workflow's kill switch | `workflow_overrides.updated_by` |

Answering *"what has this person done on this instance?"* means joining five
tables and unioning the results. Answering *"what happened in the last hour?"*
is worse, because three of those tables have no time-ordered index that spans
actors. And **login, config edits, container kills and artifact edits are not in
the list at all** — they happen and leave nothing behind.

This is the follow-up [#205](https://github.com/nearform/lastlight/issues/205)
explicitly deferred, filed as
[#206](https://github.com/nearform/lastlight/issues/206).

## The issue body is stale — read this instead

**#206 was written on 2026-07-21, before the state layer was rewritten.** Its
"High-level shape" section tells you to add DDL to `src/state/migrate.ts`'s
`db.exec` block. That file no longer exists in that form: [#351] moved the state
layer to Drizzle, and [#352] made Postgres a production runtime beside SQLite.

The issue is right about **what to build**. It is wrong about **how to change
the schema**, and following it literally would break the dual-dialect discipline
that `src/state/CLAUDE.md` exists to protect. Everything schema-shaped in this
plan follows that file and `spec/10-state.md` instead.

The same staleness affects one design instruction. The issue proposes hanging
the write on *"a small helper the actor-hardcoded admin routes already funnel
through"*. **No such funnel exists** — see decision 2.

[#351]: https://github.com/nearform/lastlight/pull/351
[#352]: https://github.com/nearform/lastlight/pull/352

## What already exists

#205 landed via PR #207 and its foundation is real in the tree. This design adds
nothing to it and re-uses all of it:

| Thing | Location |
|---|---|
| `users` table (soft join on `login`) | `src/state/schema/sqlite.ts:222` |
| `TriggerActorType` + `isTriggerActorType` | `src/state/user-store.ts:11` |
| `actorFromContext(c)` | `src/admin/auth.ts:168`, set by `authMiddleware` at `:155` |
| `triggered_by` / `trigger_actor_type` | `executions` (`:76`), `workflow_runs` (`:128`) |
| Actor derivation at the dispatch choke point | `src/index.ts:657-673` |

The nearest structural precedent is **`cron_runs`** (PR #344, issues #341/#327):
an append-only ledger table, one row per fire, with a store, an admin surface, a
dashboard panel and a spec section. Its rationale in `spec/10-state.md:374-425`
is the model for this table's, and several decisions below are the same
decisions reached again for the same reasons.

## Locked decisions

| # | Decision | Why |
|---|---|---|
| 1 | **A new table, not a widened `executions`** | Same three reasons `cron_runs` did not overload it (`spec/10-state.md:412`): `executions` has no column for a non-workflow action, its `success` flag is binary so `denied` has nowhere to live, and its `success = 0` population is dominated by DAG-cascade skips and quota deferrals that must stay `success = 0`. An audit row is written by exactly one writer and can contain neither |
| 2 | **Explicit `recordActivity()` at each action site — not middleware** | There is no seam to hang middleware on: no `app.onError`, no `app.notFound`, no shared response helper, and three `app.use` calls in the whole server — `authMiddleware` twice (`index.ts:1561`, `routes.ts:688`) and one static-file server (`admin/index.ts:62`). One could be *built*, but it would produce `POST /crons/x/toggle` rather than `cron.toggle`, and it cannot see the new value or distinguish a domain-level denial from a 200. Coverage is instead guaranteed by a **table-driven test pinning the route→verb map**, so a new mutating route added without a log line fails CI |
| 3 | **The log records user-initiated actions. System fan-out is recorded once, at its cause** | This is #206's own wording (*"Every **user-initiated** action … writes exactly one row"*) and it resolves the volume question exactly — see below. A cron fan-out dispatch is not a user action; the user action was the cron trigger, or nothing at all for a scheduled fire |
| 4 | **Keyed reads tie-break on `id`, and `id` is creation-ordered** | Straight from `cron_runs` (`spec/10-state.md:419`). Postgres has no `rowid`; a bare UUID makes a same-millisecond page boundary unstable, which silently drops or repeats rows across pages. Copy `creationOrderedId()` from `cron-run-store.ts:26` |
| 5 | **Best-effort: a store failure never fails the action** | #206 requires it, and it matches the existing posture for #205's identity capture and every read in `pr-state.ts`. Swallow, log at `warn` with `component: "activity"` |
| 6 | **`GET /admin/api/activity?target=workflow_run:<id>` serves the per-run strip** | No new route. The filter the global feed already needs is exactly the filter the strip needs |
| 7 | **The three `"admin"` literals get fixed in this plan, not deferred** | `routes.ts:1868`, `:2511`, `:2556` write `"admin"` instead of the authenticated user. They are precisely the config-edit actions this log is for; logging them while they still say `"admin"` would enshrine the bug in the audit stream rather than fix it |

## Decision 3, and the volume question it answers

The obvious place to write `workflow.trigger` is `dispatchWorkflow`
(`src/index.ts:417`) — the choke point every trigger path already funnels
through. The obvious objection is volume: the cron fan-out dispatches **once per
repo**, and `cron-triage` fires every 15 minutes.

Decision 3 makes the objection moot, and it is the same answer `cron_runs`
already reached. `spec/10-state.md:406` — *"Why it is keyed on `cron_name`"* —
records that keying a cron's history on the workflow let a hand-triggered
failure move the cron's health and vice versa. The same confusion appears here:
a cron fan-out is **one** operational event, not N user actions.

So:

- **`workflow.trigger`** is written only when the trigger has a human actor —
  `triggerActorType` in `{github, slack, cli, admin}`. The derivation already
  exists at `index.ts:660-673` and needs no new plumbing.
- **`cron.fire`** is written once per fire, beside the existing
  `db.cronRuns.start(...)` call, for both `workflow:` and `handler:` crons.

The resulting growth is bounded and checkable:

| Source | Rows/day |
|---|---|
| `cron.fire` — `cron-triage` `*/15` | 96 |
| `cron.fire` — `cron-review` `*/30` | 48 |
| `cron.fire` — `cron-dependabot-{ci-fix,merge}` daily | 2 |
| `cron.fire` — `cron-{digest,health,security}` weekly | <1 |
| `workflow.trigger` | ⊂ `workflow_runs` rows (human-triggered subset) |
| Everything else (login, toggles, approvals, cancels) | tens |

≈ **150 rows/day from crons**, ~55k/year, plus a strict *subset* of
`workflow_runs` growth. **The activity log grows more slowly than the
`workflow_runs` table already does**, which is why #206's deferral of retention
to a later issue is safe rather than optimistic.

A denied cron fan-out dispatch is therefore not recorded here. That is
deliberate — it is the normal steady state for a backstop sitting behind a
webhook, it is already visible in `cron_runs`' `dispatched` / `failures` counts,
and recording it would make the dominant row source a thing no human did.

## Consequences worth stating up front

- **`actorFromContext` returns `undefined` more often than it looks.** It is
  populated only when the token carries a `login` — GitHub OAuth, or Slack OAuth
  that matched a `users` row (`auth.ts:155`). **Password login and auth-disabled
  instances yield `undefined`**, so a fresh install with `ADMIN_PASSWORD` set
  logs `actor_login: null`, `actor_type: "admin"`. The rows are still useful
  (verb, target, outcome, time) but they do not name a person. This is inherited
  from #205, not introduced here, and it is why `actor_login` is nullable.
- **`actor_login` is free text, soft-joined to `users.login`.** No FK — the same
  additive-enrichment choice #205 made deliberately, so a row survives a user
  who never logged into the dashboard.
- **The dashboard wire type must be hand-mirrored.** `apps/server/dashboard/` has
  no import edge to core, so `ActivityRecord` is typed twice. That mirror drifted
  once before and hid three config blocks for a release, which is why
  `tests/admin/dashboard-config-mirror.test.ts` exists — this plan adds an
  equivalent pin.
- **Sixteen tables, not fifteen.** Four counts in prose and two test constants
  hardcode the number. See 00-schema.md → "The things that do not update
  themselves".

## What is deliberately not in this plan

- **Retention / rotation.** #206 defers it; the volume table above is why that
  is safe. A pruning follow-up should be filed, not built here.
- **Reading the log back into behaviour.** It is an audit stream, analytical
  only — the same posture as feedback signals (`spec/10-state.md:518`).
- **PII beyond `login`.** `detail` is a short summary, never a payload. No
  request bodies, no prompt text, no tokens.
- **Backfilling history from the five existing ledgers.** They stay where they
  are and keep their meaning (#206 non-goal 1). The log starts empty at the
  migration and is only ever appended to.
- **`POST /me/repos/resync` and `POST /route-test`.** The first is a
  self-service cache refresh, not an action on the system; the second is a
  hermetic router dry-run with no side effects. Recorded here so the omission
  reads as a decision rather than an oversight.

## Phases

Each phase is independently green, independently reviewable, and lands as its
own PR. Phase 1 changes nothing observable — it builds the table and the store.
The feature first does something in Phase 2; Phase 3 is what a person can see.

- [x] **Phase 1** — [00-schema.md](00-schema.md) — the `activity_log` table on
  both dialects, `ActivityStore`, and the six places that do not update
  themselves *(risk: medium — dual-dialect schema change, the one class of
  change this repo guards hardest)*
- [x] **Phase 2** — [01-write-seams.md](01-write-seams.md) — `recordActivity()`
  and its 22 call sites, plus the three `"admin"` literals *(risk: low —
  additive, best-effort, cannot fail an action; but touches many files)*
- [x] **Phase 3** — [02-read-surfaces.md](02-read-surfaces.md) — the admin
  endpoint, the dashboard tab + per-run strip, the `lastlight activity`
  subcommand *(risk: low — read-only)*

## Open questions for the maintainer

Both are cheap to change now and expensive once rows exist.

1. **The verb vocabulary** (00-schema.md → "Actions"). Fourteen verbs in a
   `<noun>.<verb>` shape. Worth a look before Phase 1 lands, because these
   strings become data.
2. **`config.edit` is doing double duty** — it covers both the cron schedule
   override and its deletion, distinguished only by `detail`. The alternative is
   `cron.schedule` + `cron.schedule.clear`. Recommend keeping `config.edit`
   broad, since #206 names it as one verb and the target already carries the
   `cron:<name>` specificity.

## Status

**All three phases implemented.** Written against `main` at
`0d167c01`. Each phase doc gains Execution notes as it lands, so this directory
reads as both a plan and a record.

Both open questions were **answered by @cliftonc on #364**: the verb vocabulary
is fine as-is ("simple strings that are what they say they are"), and
`config.edit` stays broad ("there is very little today that is editable"). They
are recorded here rather than removed, because the reasoning is what a future
reader needs when a fifteenth verb is proposed.
