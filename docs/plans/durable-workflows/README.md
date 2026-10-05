# Durable TypeScript workflows — replacing the YAML dialect

> **Status: design + spike (2026-10-03).** The spike lives on branch
> `spike/durable-workflows` and is not for merge as-is. Results and the
> go/no-go call are in [`07-spike-results.md`](07-spike-results.md).

## Problem

Last Light's workflows are a bespoke YAML dialect (`packages/workflow-engine`,
5.5k LOC, plus 8.2k LOC of server-side runner and handlers) driving 15 agent
workflows and 9 crons. The durability core is sound — it is already an
embedded step-checkpoint ledger — but **YAML has become a programming
language without being a good one**: control flow by substring match on agent
output, an expression grammar with no AND/NOT, a regex template language
spliced into shell, phase outputs that vanish on resume, and 4.3k LOC of
"generic" handlers that exist because YAML cannot express them. Overlays fork
whole files with no drift tracking. Details: [`00-current-state.md`](00-current-state.md).

## Locked decisions (2026-10-03)

1. **SQLite stays the default, zero extra infrastructure.** No Temporal, no
   sidecar engine, no mandatory Postgres.
2. **Workflows become TypeScript.** A rewrite of all YAML is acceptable.
3. **Overlays write TypeScript too** — they import built-ins and override
   parts (prompts, models, steps), or author new workflows, loaded at runtime.
4. **Graphviz DOT (Fabro) and Arazzo are out** — readability and fit.

## Recommendation

**Code-defined workflows on a small durable-step API we own as an
interface, executed by an embedded off-the-shelf durable runtime.**

```
defineWorkflow({ name, version, policy, classification, chat, run(ctx) })
  └─ WorkflowContext  ctx.agent / bash / step / approval / parallel / notify / sleep
       + library fns  reviewLoop(), iterate()            ← lastlight-workflow-engine/durable
       └─ DurableStep port  run / waitForSignal / sleep  ← 3 methods
            └─ OpenWorkflow (embedded worker, SQLite or Postgres)   ← apps/server
```

- Authoring API: [`02-authoring-api.md`](02-authoring-api.md)
- Runtime choice + the single-database path: [`03-runtime-port.md`](03-runtime-port.md)
- Options considered (and why not Temporal/Inngest/DBOS/…): [`01-options.md`](01-options.md)
- Overlays: [`04-overlays.md`](04-overlays.md)
- Migration, incl. the deterministic YAML→TS converter: [`05-migration.md`](05-migration.md)
- Evals + dashboard compatibility: [`06-evals-dashboard.md`](06-evals-dashboard.md)
- Comparison with Mastra workflows and the `~/work/mac` port: [`08-vs-mastra.md`](08-vs-mastra.md)

## What this does NOT fix

A crash in the middle of a 30-minute agent phase still re-runs that phase from
the start — durable execution checkpoints *between* steps. Resuming *inside* an
agent turn needs agent session resume (ACP `session/load`, already on the
[agent-runtimes rollout](../agent-runtimes/08-rollout.md)). The two compose:
the step boundary decides *whether* to resume, the session decides *where*.

Also out of scope but adjacent: the webhook handler acks `202` and emits on
`setImmediate`, so a crash before the run row is written loses the event
(recovered today only by sweep crons). With a durable runtime the fix is cheap
— enqueue the run (idempotency key = delivery id) *before* acking.
