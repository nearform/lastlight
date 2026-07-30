# Cron-run ledger — design

- **Date:** 2026-07-30
- **Status:** approved (design), pending implementation plan
- **Scope:** `lastlight-core` (`apps/server`)

## Problem

Firing a cron whose only work is code-based discovery + fan-out
(`dependabot-pr-merge` via `merge-green-dependency-prs`, and its siblings) can
complete having dispatched **zero** workflow runs — the normal steady state for a
backstop that sits behind a real-time webhook. When that happens the dashboard
shows no activity, indistinguishable from the cron having failed or never run.

The gap is four cooperating facts:

1. **No cron-run ledger exists.** The only cron table is `cron_overrides`
   (enabled/schedule *config*). Nothing records that a cron *fired* — when, by
   whom, or with what outcome.
2. **The dashboard infers cron status from the wrong tables.** `GET /crons`
   (`admin/routes.ts`) derives `lastRun` / `lastStatus` from the most recent
   `workflow_runs` row for the cron's *workflow*, and `recentFailures` from
   `executions.consecutiveFailures(workflow)`.
3. **A zero-discovery fire writes neither.** `fanOutContexts([])` returns
   `{ dispatched: 0, failures: 0 }` and dispatches nothing (`cron/fanout.ts`), so
   no `workflow_runs` row and no `executions` row are ever created. The dashboard
   columns cannot move.
4. **The outcome is computed, then discarded.** `cronRunner` (`src/index.ts`)
   already knows `repos.length`, `prs.length` (discovered), `dispatched`, and
   `failures` — it only `console.log`s them. It cannot return them either:
   `WorkflowRunner` is typed `Promise<void>` (`cron/scheduler.ts`) and the manual
   trigger is fire-and-forget (`admin/routes.ts` → `triggerCron(...).catch(...)`).

## Goal

Make every cron fire — scheduled or manual — a first-class, persisted record in
the ledger the dashboard already reads, so that a zero-discovery fire is a
visible, green "ran at HH:MM, scanned N, found 0" event rather than silence.
Additionally emit an OpenTelemetry span + counter for each fire.

## Non-goals (YAGNI)

- No unified/generic event log (cron + workflow + webhook + Slack into one
  stream). Rejected in favour of the existing per-purpose ledger-table pattern.
- No per-cron run-history drill-down view in the dashboard (rows accumulate, so
  it is a free follow-up later; not built now).
- No synchronous "Run now" discovery-count toast (the dropped Option B).
- No change to the `WorkflowRunner` signature.
- No parenting of the fanned-out `workflow.run` OTel spans under the cron span
  (see OTel section for why).

## Design

### 1. `cron_runs` table

A new peer ledger table, following the exact pattern of `executions` /
`workflow_runs` / `workflow_approvals`. Added to `src/state/migrate.ts` as an
idempotent `CREATE TABLE IF NOT EXISTS`.

| column          | type    | meaning                                                       |
| --------------- | ------- | ------------------------------------------------------------ |
| `id`            | TEXT PK | uuid                                                         |
| `cron_name`     | TEXT    | e.g. `merge-green-dependency-prs`                           |
| `workflow`      | TEXT    | e.g. `dependabot-pr-merge`                                  |
| `source`        | TEXT    | `schedule` \| `manual`                                       |
| `actor`         | TEXT    | who clicked "Run now" (null for scheduled)                  |
| `started_at`    | TEXT    | ISO timestamp                                               |
| `finished_at`   | TEXT    | ISO timestamp (null while `running`)                       |
| `status`        | TEXT    | `running` → `ok` \| `partial` \| `failed`                   |
| `repos_scanned` | INTEGER | `repos.length`                                              |
| `discovered`    | INTEGER | `prs.length`; null for non-discovery crons                 |
| `dispatched`    | INTEGER | from `FanOutResult`                                         |
| `failures`      | INTEGER | from `FanOutResult`                                         |
| `error`         | TEXT    | populated on `failed`                                       |

Index: `idx_cron_runs_name_started ON cron_runs(cron_name, started_at DESC)`
to make "latest per cron" and "recent failures per cron" cheap under the
dashboard's 10s poll.

**Status semantics:**

- `ok` — the fire ran cleanly, **including a legitimate no-op** (0 discovered,
  0 dispatched). This is the case that turns today's invisible silence into a
  green row.
- `partial` — the fire ran but one or more dispatches failed (`failures > 0`).
- `failed` — discovery or the runner threw before completing.

### 2. `CronRunStore`

A small store (peer of `ExecutionStore`), constructed on the shared
`Database` connection like the others:

- `start({ cronName, workflow, source, actor }): string` — inserts a `running`
  row, returns its id.
- `finish(id, { status, reposScanned, discovered, dispatched, failures, error })`
  — stamps `finished_at` + terminal fields.
- `latestByCron(): Map<string, CronRunRow>` — most recent row per cron name.
- `recentFailures(cronName): number` — consecutive non-`ok` terminal rows,
  newest-first (mirrors `executions.consecutiveFailures`).

Exposed on `StateDb` as `db.cronRuns`.

### 3. Wiring — one choke point

Both the scheduled path (`CronScheduler.register` → `this.runner(...)`) and the
manual path (`admin/routes.ts` → `triggerCron` → `cronRunner`) funnel through
`cronRunner` in `src/index.ts`. That is the single write site:

- On entry: `const id = db.cronRuns.start({ cronName, workflow, source, actor })`.
- In a `finally`: `db.cronRuns.finish(id, { status, ...counts, error })` — so a
  crash mid-fire leaves a visible `running`/`failed` row rather than silence.
- `status` is derived: threw → `failed`; `failures > 0` → `partial`; else `ok`.

`cronRunner` receives `void`; it does not need to *return* the outcome because
it *writes* it. `WorkflowRunner` stays `Promise<void>`.

**source / actor plumbing.** The manual endpoint already builds
`sender: actorFromContext(c)`; it will additionally stamp an explicit
`source: "manual"` marker on the context. The scheduled path carries no such
marker, so `cronRunner` defaults `source` to `schedule` and `actor` to null.
`cronName` must reach `cronRunner`: today it receives `(workflow, context)`. The
cron name will be threaded via the context (the scheduler and the trigger
endpoint both know it), read back in `cronRunner`, and stripped from the
dispatched per-run contexts.

### 4. Dashboard surfacing

`GET /crons` (`admin/routes.ts`) reads `lastRun` / `lastStatus` /
`recentFailures` from `db.cronRuns` instead of `workflow_runs` / `executions`,
and adds `discovered` / `dispatched` / `reposScanned` to each row. The dashboard
`CronsList` row renders the counts (e.g. "scanned 14 · found 0 · dispatched 0")
and the status badge from the cron-run row. No new view; the existing table
gains columns.

### 5. OpenTelemetry

Around the `cronRunner` body, emit:

- A span `lastlight.cron.fire` (INTERNAL) with attributes `cron.name`,
  `cron.workflow`, `cron.source`, `cron.repos_scanned`, `cron.discovered`,
  `cron.dispatched`, `cron.failures`, `cron.status`.
- A counter `lastlight.cron.fire` incremented once per fire, mirroring the
  existing `lastlight.workflow.run.started` counter, with `cron.name` /
  `cron.status` attributes.

Both are no-ops when telemetry is disabled (the existing `meter()` / `tracer()`
return no-ops), so this is safe on a no-OTel homelab.

**Out of scope — span parentage.** The fanned-out `workflow.run` spans are NOT
parented under the cron span. Dispatched runs execute asynchronously via the
admission queue (possibly minutes later), so the cron-span's context will not be
live when they run. They remain independent trace roots, correlated by the
`cron.name` attribute rather than by span parentage.

### 6. Logging

One structured completion line per fire, in **logfmt** so Loki's `| logfmt`
parses the fields directly:

```
[cron] cron=<name> workflow=<wf> source=<schedule|manual> status=<ok|partial|failed> \
       scanned=<N> discovered=<M|-> dispatched=<K> failures=<F> \
       trace_id=<hex> span_id=<hex>
```

`trace_id`/`span_id` come from the active `lastlight.cron.fire` span
(`span.spanContext()`), so a Grafana **derived field** on the Loki datasource
links the log line straight to the Tempo span — the one real benefit of OTLP
logs, without adopting an OTLP logs signal. Both fields are omitted when
telemetry is disabled (no active span). Free-text values (the `error=` field)
are `JSON.stringify`'d so a message with spaces/quotes stays a single logfmt
token.

Level tracks status: `console.log` for `ok`, `console.warn` for `partial`,
`console.error` for `failed` (with `error=<message>`). The `[cron]` prefix keeps
grep parity with the existing cron lines; `status=` is the query key, so
severity querying does not depend on stream/level. The pre-dispatch discovery
line (`[cron] <wf>: N green-dependency-prs across M repo(s)`) is retained for
progress visibility before the fan-out.

This is plain `console` output — it reaches Loki through the cluster's stdout
log agent (Grafana Alloy / promtail / the collector's filelog receiver), **not**
via an OTLP logs signal (the harness does not emit OTLP log records). The three
signals therefore route: span → Tempo, counter → Prometheus, log line → Loki,
all keyed by `cron.name` / `cron.status` for cross-signal correlation.

## Testing (TDD)

- `CronRunStore` unit tests: `start` inserts `running`; `finish` stamps terminal
  fields; `latestByCron` returns newest per name; `recentFailures` counts
  consecutive non-`ok` newest-first and resets on an `ok`.
- `cronRunner` tests (with a fake store + fake dispatcher):
  - empty discovery → one `ok` row, `discovered: 0`, `dispatched: 0`.
  - a dispatch failure → `partial` row, `failures > 0`.
  - discovery throws → `failed` row with `error` set, `finished_at` stamped.
  - `source`/`actor` recorded from a manual context; defaulted for scheduled.
- `GET /crons` returns the ledger-derived `lastRun` / `lastStatus` /
  `discovered` / `dispatched` fields.
- Baseline: full `turbo typecheck test build` gate green.

## Rationale / alternatives considered

- **Overload `executions` instead of a new table** — rejected. `executions`
  rows are agent-phase runs (skill / turns / duration / session id) and drive
  `executions.consecutiveFailures(workflow)` plus the dashboard session views. A
  cron fire has none of that shape and would pollute those queries.
- **Unified event log** — rejected for this scope. The system already has
  several partial event representations (`EventEnvelope`, `executions`,
  `workflow_runs.phase_history`, the OTel span tree); a brand-new generic event
  substrate would be an N+1 standard for one concrete need. The per-purpose
  ledger-table pattern is the established convention.
- **OTel-only** — insufficient alone: the dashboard reads SQLite, and a homelab
  with no OTel backend would still be blind. OTel is added as a complement, not
  the primary surface.
- **JSON log lines instead of logfmt** — rejected for this feature. The harness
  logs freeform human text everywhere; a lone JSON line would be unreadable in
  `kubectl logs` (the resilient stdout floor this design leans on) *and* still
  un-`| json`-able as a pod-wide pipeline because every other line is text.
  logfmt is human-readable, Loki-parseable (`| logfmt`), and consistent with the
  existing lines; the one free-text field (`error=`) is `JSON.stringify`'d to
  stay a single token. JSON becomes the right call only as an app-wide
  structured-logging migration (pino/winston + a `| json`-everywhere pipeline) —
  a separate, cross-cutting decision, not cron-scoped.
- **OTLP logs signal (app → collector → Loki)** — rejected for this feature.
  Its one real benefit, trace↔log correlation, is achieved cheaply by emitting
  `trace_id`/`span_id` as logfmt fields + a Grafana derived field. OTLP-only logs
  would forfeit the stdout floor (`kubectl logs`, survival of a collector
  outage) and, done for cron alone, be inconsistent with the rest of the
  harness. Revisit only as an app-wide logging migration.
