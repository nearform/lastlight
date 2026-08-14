# Cron-run ledger — design

- **Date:** 2026-07-30 — **revised 2026-08-14**
- **Status:** approved (design), pending implementation plan
- **Scope:** `lastlight-core` (`apps/server`)
- **Closes:** [#341](https://github.com/nearform/lastlight/issues/341),
  [#327](https://github.com/nearform/lastlight/issues/327)

## Revision note (2026-08-14)

The original design was parked on 2026-07-30 pending somewhere to verify its
OTel signals against. `main` has since moved 110 commits and two issues were
filed covering the same ground from production evidence. This revision folds
them in and reverses two decisions. What changed:

1. **`cron_runs` now covers EVERY cron, not just workflow crons.** `withLedger`
   (`cron/handlers.ts:81`, shipped with #333) gave *handler* crons a per-tick
   record by overloading `executions`. Rather than run two ledgers, `withLedger`
   is repointed at `cron_runs` and `lastHandlerTick()` is deleted. See §3.
2. **The scheduler's consecutive-failure alert is repaired here** (§4), closing
   #327. It was out of scope in the original; it is in scope now because this
   design moves the table its query reads.
3. **§7 Logging is rewritten.** The original specified logfmt via
   `console.log`/`warn`/`error` and argued against JSON. The app-wide structured
   logging migration landed in #258 — `console.*` is now banned in runtime code
   and `src/cron/` has none. The logfmt rationale is void; most of what it built
   by hand now comes free.
4. **`repos_scanned` is split in two** (§1). Issue #180's per-repo cron
   participation landed after the original, so there are now two repo counts
   where there was one.

Superseded rationale is retained in §9 with the evidence that overturned it.

## Problem

A **workflow** cron that fans out over managed repos records nothing about the
tick as a unit. The fan-out result is computed and then discarded, so a weekly
scan across 19 repos leaves no answer to "did it run, over how many repos, and
did they all succeed?"

Five cooperating facts:

1. **No cron-fire ledger exists.** The only cron table is `cron_overrides`
   (enabled/schedule *config*). Nothing records that a workflow cron *fired* —
   when, by whom, or with what outcome.
2. **A zero-discovery fire writes nothing at all.** `fanOutContexts([])` returns
   `{ dispatched: 0, failures: 0 }` and dispatches nothing (`cron/fanout.ts:118`),
   so no `workflow_runs` row and no `executions` row is created. For a backstop
   sitting behind a real-time webhook this is the *normal* steady state.
3. **A successful fan-out writes nothing either.** `cronRunner`
   (`src/index.ts:1319-1404`) knows `candidates.length`, `repos.length`,
   `prs.length`, `dispatched` and `failures` — and logs them only when
   `failures > 0`. A fully successful weekly fan-out over 19 repos emits one
   line: `{"level":"info","component":"cron","job":"weekly-security-scan","msg":"Running"}`.
   On `security-review` a clean scan files no issue by design, so there is no
   GitHub-side evidence either.
4. **The dashboard shows an arbitrary child, not the tick.**
   `GET /crons` (`admin/routes.ts:2484-2486`) derives a workflow cron's
   `lastRun`/`lastStatus` from `db.runs.listRecent(50).find(...)` — whichever of
   the 19 dispatched runs happens to come first in that list.
5. **The failure count is measuring something else.** `recentFailures` is
   `db.executions.consecutiveFailures(def.workflow ?? def.name)`
   (`admin/routes.ts:2481`), and `execution-store.ts:721` matches
   `executions.skill` exactly while every phase row is written as
   `"<workflow>:<phase>"`. For the six workflow crons the predicate can never
   match, so the count is permanently `0` and the scheduler's alert
   (`cron/scheduler.ts:89-91`) is unreachable. Where it *would* match it would be
   wrong anyway: keyed on the workflow name, it counts runs dispatched by
   `/api/run` or a GitHub comment too, so a hand-triggered failure inflates the
   cron's health.

Handler crons already have (1)–(4) via `withLedger`. The asymmetry is
unintended: `cron/handlers.ts:25-34` makes the case for the handler half, and
that reasoning applies unchanged to workflow crons.

## Goal

Make every cron fire — scheduled or manual, workflow or handler — a
first-class persisted record at **fire grain**, so that:

- a zero-discovery fire is a visible, green "ran at 09:00, scanned 14, found 0"
  event rather than silence;
- "did Monday's scan run, and over how many repos?" is answerable from one row;
- the consecutive-failure alert counts *fires* of *this cron*, so `maxFailures`
  means the same thing for every cron and manual dispatches cannot skew it.

Additionally emit an OpenTelemetry span + counter per fire.

## Non-goals (YAGNI)

- No unified/generic event log (cron + workflow + webhook + Slack in one
  stream). Rejected in favour of the existing per-purpose ledger-table pattern.
- No per-cron run-history drill-down view. Rows accumulate, so it is a free
  follow-up later; not built now.
- **No per-tick roll-up digest** ("19 scanned, 3 filed issues, 16 clean" — the
  nice-to-have in #341). The tick record is the prerequisite; the roll-up is a
  separate feature that reads from it.
- No delivery mechanism for the consecutive-failure alert. `scheduler.ts:92`
  carries a `// TODO: send alert (Slack webhook, email, etc.)` and it stays a
  TODO — this design makes the branch *reachable*, not wired.
- No change to the `WorkflowRunner` signature (`cron/scheduler.ts:44`).
- No parenting of fanned-out `workflow.run` spans under the cron span (§6).
- No backfill of historical `executions` rows written by `withLedger` (§3).

## Design

### 1. `cron_runs` table

A new peer ledger table following the pattern of `executions` /
`workflow_runs` / `workflow_approvals`. Added to `src/state/migrate.ts` as an
idempotent `CREATE TABLE IF NOT EXISTS`, after the `cron_overrides` block
(`migrate.ts:65`).

| column             | type    | meaning                                                     |
| ------------------ | ------- | ----------------------------------------------------------- |
| `id`               | TEXT PK | uuid                                                        |
| `cron_name`        | TEXT    | e.g. `merge-green-dependency-prs` — the key, always          |
| `workflow`         | TEXT    | dispatched workflow; NULL for a `handler:` cron              |
| `handler`          | TEXT    | handler name; NULL for a `workflow:` cron                    |
| `source`           | TEXT    | `schedule` \| `manual`                                       |
| `actor`            | TEXT    | who clicked "Run now"; NULL for scheduled                    |
| `started_at`       | TEXT    | ISO timestamp                                                |
| `finished_at`      | TEXT    | ISO timestamp; NULL while `running`                          |
| `status`           | TEXT    | `running` → `ok` \| `partial` \| `failed`                    |
| `repos_eligible`   | INTEGER | managed repos the tick considered, before #180 narrowing     |
| `repos_scanned`    | INTEGER | repos that actually participated, after narrowing            |
| `discovered`       | INTEGER | `prs.length`; NULL for a non-discovery cron                  |
| `dispatched`       | INTEGER | from `FanOutResult`; NULL for a handler cron                 |
| `failures`         | INTEGER | from `FanOutResult`; NULL for a handler cron                 |
| `error`            | TEXT    | populated on `failed`                                        |

Index: `idx_cron_runs_name_started ON cron_runs(cron_name, started_at DESC)` —
makes "latest per cron" and "recent failures per cron" cheap under the
dashboard's 10s poll.

**Why two repo counts.** Issue #180 gave every repo a `.lastlight/` cron
opt-in/opt-out, resolved at tick time (`index.ts:1347-1363`). There are now two
honest answers to "over how many repos?": what the tick *considered*
(`repos_eligible`) and what it *worked* (`repos_scanned`). Recording only the
second makes an all-opted-out tick indistinguishable from an empty managed list;
recording only the first overstates the work. The dashboard renders
`repos_scanned` alone when they agree and "14 of 19" when they do not.

**Status semantics:**

- `running` — inserted on entry; a crash mid-fire leaves this visible rather
  than leaving silence.
- `ok` — ran cleanly, **including a legitimate no-op** (0 discovered, 0
  dispatched). This is the case that turns today's invisible silence green.
- `partial` — ran, but one or more dispatches failed (`failures > 0`).
- `failed` — discovery or the runner threw before completing.

### 2. `CronRunStore`

A small store (peer of `ExecutionStore`) on the shared `Database` connection,
exposed as `db.cronRuns`:

- `start(meta): string` — inserts a `running` row, returns its id.
- `finish(id, result): void` — stamps `finished_at` + terminal fields.
- `latestByCron(): Map<string, CronRunRecord>` — most recent row per cron name.
- `recentFailures(cronName): number` — consecutive non-`ok` **terminal** rows,
  newest-first; `running` rows are ignored, an `ok` resets the count.

`recentFailures` deliberately mirrors the shape of
`executions.consecutiveFailures` so the scheduler's call site changes key and
table but not logic.

### 3. Wiring — two writers, one table

The original design assumed one choke point. There are two, because `handler:`
crons fire through `config.runCronHandler` (`admin/routes.ts:2650`) rather than
`triggerCron`. Both write the same table:

**Workflow crons** — `cronRunner` (`src/index.ts:1319`) is extracted into a
testable `makeCronRunner` factory in a new `src/cron/runner.ts`. It records on
entry, and stamps terminal fields in a `finally`. `status` derives as: threw →
`failed`; `failures > 0` → `partial`; else `ok`. `cronRunner` still returns
`void` — it *writes* the outcome rather than returning it, so `WorkflowRunner`
stays `Promise<void>`.

The factory's deps must include a `resolveRepos` seam (defaulting to
`resolveCronRepos`), because the closure being extracted now performs #180's
per-repo narrowing inline and that must stay both present and testable.

**Handler crons** — `withLedger` (`cron/handlers.ts:81`) keeps its position and
contract (wrap at the registry so admin "Run now" is covered; re-throw on
failure) and switches its write from `db.executions` to `db.cronRuns`, with
`handler` set and `workflow`/`dispatched`/`failures` NULL.

Its **repo counts are NULL too**, and deliberately so: `repo-digest` narrows its
own list (`cron/repo-digest.ts:90`) *inside* the handler, and `CronHandler`
returns `Promise<void>` (`cron/handlers.ts:45`), so the wrapper cannot observe
the counts without changing that signature. Widening `CronHandler` to return a
result is a reasonable follow-up once a second handler cron exists to justify
it; with one handler cron it is speculative. A handler row therefore answers
"did it run, when, for whom, and did it throw" — which is the whole of what
`withLedger` answers today — and nothing is lost in the move.

**Marker plumbing.** `_cronName` already reaches both paths — `CRON_NAME_KEY`
(`cron/repo-crons.ts:52`), injected by `cron/jobs.ts:144` and
`admin/routes.ts:2646`. This design adds `_cronSource` (`schedule` | `manual`)
and `_cronActor`; the manual path already computes the actor as `sender`
(`routes.ts:2647`).

> **Invariant — the markers are injected, never spread.** `jobs.ts:140-144` and
> `routes.ts:2642-2648` deliberately place the cron YAML's own `context:` spread
> *ahead* of the marker keys, so operator YAML cannot spoof `_cronName` and make
> `resolveCronRepos` apply another cron's participation rules to this tick. New
> markers follow the same placement. A change that spreads `def.context` last
> reopens the hole.

**Migration.** Existing `executions` rows written by `withLedger` are left in
place as history; nothing reads them once `lastHandlerTick()` is deleted. No
backfill — a fresh `cron_runs` table simply starts empty and fills on the next
tick.

### 4. Cron alerting, repointed (closes #327)

`cron/scheduler.ts:89-90` becomes:

```ts
const failures = this.db.cronRuns.recentFailures(job.name);
```

This is the fix #327 asks for, one grain finer than its own suggestion. #327
recommends run-level counting over phase-level; fire-level is better still for
this caller, and its three arguments carry over intact:

1. **A fire is the unit a cron alert cares about.** Phase-level counting makes
   `maxFailures: 3` mean something different per workflow (a failed 5-phase run
   can read as 5 consecutive failures, a 1-phase run as 1). Fire-level makes it
   mean the same thing everywhere.
2. **It sidesteps the `executions.success` population problem by
   construction.** #327 measured 251 quota-deferral / cascade-skip rows in one
   day against 0 real failures. A cron-fire row is written by exactly one writer
   and cannot contain either.
3. **It removes a reader of `executions.success` rather than adding one** —
   #327's own stated preference.

It also fixes the contamination #341 identified: keyed on `cron_name`, a run
dispatched by `/api/run` or a GitHub comment can no longer move a cron's health.

`MAX_CONSECUTIVE_FAILURES` (`scheduler.ts:35`) keeps its value and finally has
meaning. The `// TODO: send alert` at `scheduler.ts:92` is explicitly out of
scope (see Non-goals).

### 5. Dashboard surfacing

`GET /crons` (`admin/routes.ts`) reads **one** ledger for both kinds of cron:

```ts
const latest = db.cronRuns.latestByCron();
// per def:
const last = latest.get(def.name) ?? null;
const recentFailures = db.cronRuns.recentFailures(def.name);
```

`lastHandlerTick()` (`admin/routes.ts:611`) and the `def.workflow ?? def.name` /
`def.workflow ? … : …` branches are deleted — the whole point of keying on
`cron_name` is that the branch disappears.

`CronInfo` (`dashboard/src/api.ts:1086`) gains `reposEligible`, `reposScanned`,
`discovered`, `dispatched`, all `number | null`. It also gains `handler: string
| null` and its `workflow` widens to `string | null` — the server has returned
both since #333 and the hand-maintained mirror never caught up.

`CronsList.tsx` renders a compact counts line under the existing "Last run"
cell (`CronsList.tsx:198`), shown only once a fire has been recorded:
`scanned 14 · found 0 · dispatched 0`, with `scanned 14 of 19` when the two repo
counts differ.

### 6. OpenTelemetry

Around the fire body:

- Span `lastlight.cron.fire` (INTERNAL) with `cron.name`, `cron.workflow` or
  `cron.handler`, `cron.source`, `cron.repos_eligible`, `cron.repos_scanned`,
  `cron.discovered`, `cron.dispatched`, `cron.failures`, `cron.status`.
- Counter `lastlight.cron.fire` incremented once per fire, mirroring the
  existing `lastlight.workflow.run.started` counter
  (`src/telemetry/index.ts:296`), with `cron.name` / `cron.status` attributes.

Both are no-ops when telemetry is disabled (`meter()` / `tracer()` return
no-ops), so a deployment without a collector loses the two signals and nothing
else.

Both are verifiable end-to-end on a self-hosted Kubernetes deployment running
the `kubernetes` sandbox backend, where an OpenTelemetry Collector has been in
place since 2026-07-31 with all three pipelines wired — traces to Tempo, metrics
through `prometheus_remote_write` to a kube-prometheus-stack, logs to Loki — and
the harness already exports to it over OTLP/HTTP, with a `CiliumNetworkPolicy`
rule opening that egress on an otherwise default-deny pod.

Verification is nonetheless a release-checklist item rather than an
implementation gate: the SQLite ledger is what the dashboard reads, and it must
keep working with OTel off. That ordering is the lesson of this document's own
history — it was parked on 2026-07-30 pending a collector that turned out to
land the next day, then sat a fortnight on a blocker that had already cleared
and was never a dependency of the part that mattered.

**Out of scope — span parentage.** Fanned-out `workflow.run` spans are NOT
parented under the cron span. Dispatched runs execute asynchronously via the
admission queue (possibly minutes later), so the cron span's context will not be
live. They stay independent trace roots, correlated by the `cron.name`
attribute.

### 7. Logging

One structured completion line per fire, through the harness logger
(`logger("cron")`) — **never `console.*`**, which is banned in runtime code:

```ts
log.info("Cron fire complete", {
  cron, workflow, handler, source, status,
  reposEligible, reposScanned, discovered, dispatched, failures,
});
```

Level tracks status: `info` for `ok`, `warn` for `partial`, `error` for `failed`
(passing the `Error` as `err`, not interpolated). This subsumes #341's suggested
cheap first step — logging the *successful* outcome, not only the failing one —
and replaces the current `failures > 0`-only line at `index.ts:1401-1403`.

`trace_id`/`span_id` are emitted automatically by the logger inside an active
span, so the Tempo↔Loki correlation the original design hand-rolled as logfmt
fields now comes free. The pre-dispatch discovery line (`index.ts:1373`) is
retained for progress visibility before the fan-out.

## Testing (TDD)

- **`CronRunStore` unit tests:** `start` inserts `running`; `finish` stamps
  terminal fields; `latestByCron` returns newest per name; `recentFailures`
  counts consecutive non-`ok` newest-first, ignores a `running` row, resets on
  an `ok`.
- **`makeCronRunner` tests** (fake store + fake dispatcher):
  - empty discovery → one `ok` row, `discovered: 0`, `dispatched: 0`;
  - a dispatch failure → `partial`, `failures > 0`;
  - discovery throws → `failed` with `error` set and `finished_at` stamped;
  - `source`/`actor` recorded from a manual context, defaulted for scheduled;
  - repo narrowing recorded as `repos_eligible` ≠ `repos_scanned`;
  - `_cron*` markers stripped from the dispatched per-repo contexts.
- **`withLedger` tests:** a handler tick writes one `cron_runs` row with
  `handler` set and `dispatched`/`failures` NULL; a throwing handler writes
  `failed` and re-throws.
- **Scheduler test:** three consecutive `failed` fires make
  `recentFailures(job.name)` reach `MAX_CONSECUTIVE_FAILURES` and log the ALERT
  line — the branch #327 showed was unreachable. **This test must fail against
  today's code**, which is what distinguishes it from the existing stubs
  (`tests/cron/control-keys.test.ts:108` et al. fake `consecutiveFailures: () =>
  0`, the exact value the real implementation always returns, so no existing
  test could tell the bug from the fix).
- **`GET /crons`:** returns ledger-derived `lastRun`/`lastStatus`/
  `recentFailures` + the four counts, for a workflow cron **and** a handler
  cron — the latter guarding against regressing #333.
- Baseline: full `pnpm turbo run typecheck test build` green.

## Rationale / alternatives considered

- **Overload `executions` instead of a new table** — rejected, and the evidence
  is now stronger than when this was first written. This is the suggested fix in
  #341, on the reasoning that `withLedger` proved it works and that
  `consecutiveFailures` / `recentExecutions` / the dashboard count "start
  working for free". Three things overturn it. (a) It is not free: `executions`
  (`migrate.ts:18-35`) has no column for the four counts and no JSON blob, so it
  needs `ALTER TABLE` × 4 cron-only nullable columns on the schema's most-read
  table. (b) `success` is a binary INTEGER, so `partial` — the status a 19-repo
  fan-out most needs — has nowhere to live. (c) What you inherit "for free" is
  the bug: #327 measured `executions.success` as unusable for cron health, and
  its preferred remedy is to *remove* readers of that column, which overloading
  does the opposite of.
- **Extend `withLedger` to workflow crons, keep `executions`** — same objection
  as above, plus it leaves `lastHandlerTick()` and the `def.workflow ?? def.name`
  branch in place permanently.
- **Two ledgers — `cron_runs` for workflow crons, `executions` for handler
  crons** — rejected. It is the smallest diff and regresses nothing, but it
  leaves `GET /crons` branching on cron kind forever to answer one question, and
  contradicts the house rule against parallel implementations of one concept.
- **Unified event log** — rejected for this scope. The system already has
  several partial event representations (`EventEnvelope`, `executions`,
  `workflow_runs.phase_history`, the OTel span tree); a generic event substrate
  would be an N+1 standard for one concrete need.
- **OTel-only** — insufficient alone: the dashboard reads SQLite, and a
  deployment with no OTel backend would still be blind. OTel complements the
  ledger; it does not replace it.
- **Fix `consecutiveFailures` with `skill LIKE ? || ':%'`** — rejected, and
  #327 shows it is *worse than the current bug*: the alert would then count
  DAG-cascade skips and quota deferrals as failures and fire near-constantly.
  Fire-grain counting needs neither the LIKE nor #325's classification.
- **JSON vs logfmt log lines** — moot. The original chose logfmt over JSON on
  the grounds that a lone JSON line would be unreadable among freeform text and
  that JSON was only right "as an app-wide structured-logging migration". That
  migration shipped (#258); the harness now emits JSON everywhere and bans
  `console.*`, so §7 follows the house logger and the question does not arise.
- **OTLP logs signal** — still rejected. Its one real benefit, trace↔log
  correlation, is already delivered by the logger's automatic
  `trace_id`/`span_id` inside an active span.
