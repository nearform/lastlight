# 01 — Options considered

Researched 2026-10-03; maturity notes are as of that date. Constraints:
single-host docker-compose, SQLite (libsql) default, embeddable in the Node 22
process, human gates that wait days, agent steps that run 30–40 minutes.

## Durable runtimes

| Candidate | Infra | SQLite | Embedded lib | Verdict |
|---|---|---|---|---|
| **OpenWorkflow** | none | yes (`node:sqlite`) + Postgres | yes | **Chosen for the spike.** Step checkpointing, signals with timeouts, sleeps, versions, child workflows, pluggable `Backend` interface. Apache-2.0. Young (0.10.x, single maintainer). |
| DBOS Transact TS | Postgres | no (TS SQLite PR open, dev-only) | yes | Best mature library — revisit if Postgres ever becomes the default. |
| Absurd | Postgres | no | yes (~1.4k LOC SDK) | Small and readable; Postgres-only, versioning unaddressed. Good design reference. |
| Inngest (self-host) | +1 container (single binary, SQLite) | yes | no (HTTP push into the app) | Mature; SSPL server; hour-long steps fight HTTP timeouts. |
| Restate | +1 stateful binary | own store | no | Excellent semantics; BSL server; another thing to back up. |
| Temporal | server + Postgres/MySQL | dev only | no | Gold standard for versioning; far too heavy here. |
| Trigger.dev v4 / Hatchet | Postgres + engine (+Redis) | no | no | Platforms, not libraries. |
| Vercel Workflow SDK | compiler transform; Postgres/Turso "worlds" | community Turso world | yes | Nice ergonomics; build-step friction in a pnpm monorepo; self-host second-class. |
| Effect `effect/workflow` | library | yes, open lock bugs | yes | Only sensible if we adopt Effect wholesale. |
| Mastra workflows | library + libSQL store | yes | yes | Snapshot suspend/resume, not durable execution; open cross-process resume bugs; pulls in the framework. Its JSON "dynamic workflows" are the one declarative TS option. |
| LangGraph.js / XState | library | yes / BYO | yes | State-graph runtimes, not durable executors (no durable timers). |

## Declarative dialects (keep YAML, but standard)

Serverless Workflow 1.0 (TS SDK parses/validates only — no runtime), AWS Step
Functions ASL (`aws-local-stepfunctions` is in-memory, not durable), Kestra /
Windmill / Conductor (JVM or server platforms), Arazzo (API-call sequencing,
not agent orchestration), Graphviz DOT as used by Fabro (rejected for
readability). Each of these would be a better-specified YAML with the same
fundamental problem: control flow, typed results and reuse want a programming
language.

## Why "own the interface, borrow the runtime"

The thing that must stay stable for 15 workflows and N overlays is the
*authoring API* (`ctx.agent`, `ctx.approval`, `reviewLoop`, …). The thing that
is commodity — and where we are least qualified to compete — is the replay
machinery. The `DurableStep` port is three methods (`run`, `waitForSignal`,
`sleep`), which every candidate above provides; swapping OpenWorkflow for DBOS
or a home-grown backend is an adapter, not a rewrite.

Sources: openworkflow.dev, github.com/openworkflowdev/openworkflow,
dbos.dev (TS SQLite PR #1288), github.com/earendil-works/absurd,
inngest.com self-hosting docs, docs.restate.dev, temporal.io worker versioning,
workflow-sdk.dev worlds, mastra.ai dynamic workflows, serverlessworkflow.io.
