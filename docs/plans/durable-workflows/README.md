# Durable TypeScript workflows — replacing the YAML dialect

> **Status: design reviewed (2026-10-10), go.** The spike lives on branch
> `spike/durable-workflows` and is not for merge as-is. Results are in
> [`07-spike-results.md`](07-spike-results.md); the review's 15 decisions are
> in [`09-decisions.md`](09-decisions.md), which wins wherever an earlier doc
> disagrees.

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
3. ~~**Overlays write TypeScript too**~~ — **deferred** by the 2026-10-10
   review ([`09-decisions.md`](09-decisions.md) #9): no overlay has ever forked
   a workflow, so overlay TS workflows are a follow-up issue. Prompts, skills,
   agent-context and config keep their per-file layering.
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
- **Review decisions (2026-10-10)** — runtime, backend, versioning, typed
  outcomes, cut-over, E2E gate, graph extraction, snapshots/fork, admission,
  crons, rollback: [`09-decisions.md`](09-decisions.md)

## What this does NOT fix

A crash in the middle of a 30-minute agent phase still re-runs that phase from
the start — durable execution checkpoints *between* steps. Resuming *inside* an
agent turn needs agent session resume (ACP `session/load`, already on the
[agent-runtimes rollout](../agent-runtimes/08-rollout.md)). The two compose:
the step boundary decides *whether* to resume, the session decides *where*.

Also out of scope but adjacent: the webhook handler acks `202` and emits on
`setImmediate`, so a crash before the run row is written loses the event
(recovered today only by sweep crons). The fix is a transactional inbox —
persist the delivery (keyed on `X-GitHub-Delivery`) *before* acking — which
needs no durable runtime, so it ships as its own issue and PR
([`09-decisions.md`](09-decisions.md) #14).
