# 03 — The runtime port and OpenWorkflow

> **Decided 2026-10-10** ([`09-decisions.md`](09-decisions.md) #3, #4, #12):
> depend on OpenWorkflow at a pinned version and engage upstream (logger
> option, configurable lease, buffered signals, table prefix) instead of
> vendoring; build the Drizzle `Backend` below as a generic, upstreamable
> backend; admission stays Last Light's and OpenWorkflow only ever sees
> admitted runs.

## The port

```ts
// packages/workflow-engine/src/durable/step.ts
export interface DurableStep {
  run<T>(name: string, fn: () => Promise<T>): Promise<T>;
  waitForSignal<T>(name: string, signal: string, timeout?: string): Promise<{ data: T } | null>;
  sleep(name: string, duration: string): Promise<void>;
}
```

`createWorkflowContext(step, services, runId, input)` builds `ctx` over it.
`services` are the ports the YAML engine already uses (`AgentPort`,
`AssetLoader`, `LoggerPort`) plus `approvals` and `notify` — so
`ctx.agent` drives the existing `agent-executor` → orchestrator → sandbox path
unchanged, and the agent-runtimes work (ACP bridge) slots in underneath with no
interaction.

## OpenWorkflow adapter

`apps/server/src/workflows/durable/runtime.ts` (124 lines): registers each
`LastLightWorkflow` as an OpenWorkflow workflow (name + version), runs an
embedded polling worker in-process, and maps `resolveApproval(runId, gate,
decision)` to a run-scoped signal (`lastlight:approval:<runId>:<gate>`).

What we learned reading the source (0.10.1) and running it:

| Topic | Finding |
|---|---|
| Model | Step checkpointing; workflow fn re-invoked from the top; steps memoized **by name**. Parallel steps (`Promise.all`) supported with an execution fence. Default retry policy: 1 attempt (good — agent steps are expensive). Step limit 1,000/run. |
| Crash recovery | Lease-based: the worker heartbeats a 30 s lease. After `kill -9` the run is reclaimed when the lease lapses — **~30 s**, measured. Not configurable (constant). Fine for us; note it. |
| Parked state | A run waiting on a signal/sleep is `status: running` with `workerId: null` and a future `availableAt` — not a distinct status. The adapter exposes `isParked()`. |
| Signals | **Not buffered**: a signal sent while no step is waiting is dropped (`sendSignal` returns no run ids). Mitigated: the approval row stays the source of truth and `ctx.approval` checks `approvals.decision()` before parking. Needs a reconciler sweep for the narrow crash window between "decision recorded" and "signal sent". |
| Wait timeouts | `waitForSignal` always has a deadline (we default 30 d); expiry returns `null` → treated as rejection. |
| Versioning | Runs record the workflow version; a worker only claims runs whose (name, version) it has registered. So a deploy keeps old versions registered until their runs drain, or fails them. |
| Logging | Uses `console.error` for worker-loop errors — violates our logger contract; wrap or upstream a logger option. |
| Storage | **Own SQLite file via `node:sqlite`** (Node ≥ 22.5; stable in 24) — not libsql. Postgres backend uses `postgres.js`, not our `pg`/neon client. |

## One database, not two (production path)

OpenWorkflow's `namespace_id` is a **column** for multi-tenancy inside its own
tables — not a table prefix. Its table names are hard-coded
(`workflow_runs`, `step_attempts`, `workflow_signals`,
`openworkflow_migrations`), and `workflow_runs` collides with ours:
`CREATE TABLE IF NOT EXISTS "workflow_runs"` would silently no-op against our
table and every insert would fail. So it **cannot share `lastlight.db` as
shipped**; the spike uses `$STATE_DIR/workflows.db`.

Two files is workable but costs us: two backup surfaces, two migration
stories, two SQLite drivers, OpenWorkflow writes outside our
`sqlite-write-lock`, and no Postgres parity (different driver).

**Recommended:** implement OpenWorkflow's `Backend` interface (21 methods; the
SQLite reference is ~800 LOC) on our Drizzle client, with `ow_`-prefixed
tables declared in **both** `schema/sqlite.ts` and `schema/pg.ts` and
generated per `src/state/CLAUDE.md`. That buys: one database file, our write
lock and op serializer, Postgres via the existing `pg`/neon client, the
drizzle parity tests, and `lastlight server db migrate` copying runtime state
along with everything else. It is also the exit hatch: if OpenWorkflow stalls,
the worker/replay half (~1.1k LOC) is small enough to vendor.

The current `workflow_runs` / `executions` / `workflow_approvals` tables stay
during migration (dashboard + evals read them); the durable runtime's state is
an *additional* table set, projected into ours by the adapter's hooks (see
`06-evals-dashboard.md`).
