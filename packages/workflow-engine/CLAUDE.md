# lastlight-workflow-engine

The published **`lastlight-workflow-engine`** package — the runtime-agnostic core
of Last Light's workflow execution. It knows how to schedule and run a DAG of
phases; it knows *nothing* about GitHub, sandboxes, Docker, or the database.
Those live behind **ports** the server implements.

**Dependency invariant:** this is the base of the workspace graph. It depends only
on `zod` — **no edge back to `lastlight-shared` or `lastlight-core`** (enforced by
the dep-cruiser gate in `typecheck` → `.dependency-cruiser.cjs`). Everything else
depends on it.

## Seams (`src/`)

```
core/
  scheduler.ts       The one scheduler — every workflow is a DAG. Drives phase
                     order, readiness, and loop iteration.
  dag.ts             DAG construction + topological readiness.
  phase-executor.ts  Executes a single phase against the injected ports.
  phase-ref.ts       Phase identity/reference resolution (incl. loop-iteration names).
  loop-eval.ts       Loop condition evaluation (max_cycles, on_request_changes, …).
  templates.ts       The `{{…}}` template engine used for prompts/models/variants.
  schema.ts          Zod schema for a workflow YAML definition — the parse contract.
  verdict.ts         Reviewer verdict parsing (APPROVE / REQUEST_CHANGES).
  types.ts           Shared engine types.
ports/
  ports.ts           The port interfaces the engine depends on (agent execution,
                     persistence, clock, …). lastlight-core supplies concrete
                     implementations; test-support supplies fakes.
test-support/
  fakes.ts           In-memory fakes for the ports — used by both this package's
                     tests and consumers testing workflow behaviour.
```

## How it's used

`lastlight-core`'s server-side runner (`apps/server/src/workflows/`) wires the real
ports (sandbox execution, SQLite persistence, GitHub tokens) into this engine and
drives it phase-by-phase. For the runner-side story — phase types, linear vs DAG,
loop iteration naming, approval gates, resume, taskId scoping — see
[`apps/server/src/workflows/CLAUDE.md`](../../apps/server/src/workflows/CLAUDE.md).

## Commands

```bash
pnpm --filter lastlight-workflow-engine build
pnpm --filter lastlight-workflow-engine typecheck   # tsc + dep-cruiser boundary gate
```
