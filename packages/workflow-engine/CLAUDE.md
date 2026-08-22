# lastlight-workflow-engine

The published **`lastlight-workflow-engine`** package — the runtime-agnostic core
of Last Light's workflow execution. It knows how to schedule and run a DAG of
phases; it knows *nothing* about GitHub, sandboxes, Docker, or the database.
Those live behind **ports** the server implements.

**Dependency invariant:** this is the base of the workspace graph. It depends only
on `zod` — **no edge back to `lastlight-shared` or `lastlight-core`** (enforced by
`scripts/lint-import-boundaries.mjs`, run from this package's `typecheck`).
That script replaced dependency-cruiser when the workspace moved to TypeScript 7
— dep-cruiser refuses to parse TS ≥ 7 and *exits 0 anyway*, so the old gate went
green while seeing nothing. Everything else
depends on it.

## Seams (`src/`)

```
core/
  scheduler.ts       The one scheduler — every workflow is a DAG. Drives phase
                     order, readiness, and loop iteration. Runs ONE ready node
                     at a time, in declaration order; concurrency across nodes
                     is parked (see the review-evidence-pipeline plan).
  dag.ts             DAG construction + topological readiness. `getReadyNodes`
                     and `topoSort` are concurrency-correct and return every
                     ready node — the scheduler is what takes `ready[0]`.
  phase-executor.ts  Executes a single phase against the injected ports. Owns
                     the generic kinds (context / agent / bash / script / the
                     two loop shapes) and dispatches anything else through
                     `EnginePorts.handlers` — the seam an app registers
                     `post-review` and `fanout` on, so the engine core needs no
                     knowledge of GitHub or sandboxes to support them.
  phase-ref.ts       THE authority for generated ledger labels — loop iterations
                     (`_fix_`/`_recheck_`/`_iter_`) and fan-out branches
                     (`_branch_<name>`, `_retry`, `_check`) — and for parsing
                     them back. Anything that formats such a label by hand will
                     drift from `parse()`.
  loop-eval.ts       Loop condition evaluation (max_cycles, on_request_changes, …).
  templates.ts       The `{{…}}` template engine used for prompts/models/variants.
                     `lookupContextKey` is the one dotted-path walk over a run
                     context; both `{{a.b}}` and the budget resolver below use it.
  templated-number.ts  A phase budget that may be READ FROM THE RUN CONTEXT:
                     `timeout_seconds` / `generic_loop.max_iterations` accept
                     `{ from: <ctx path>, default: N }` as well as a plain
                     integer. `default` is the workflow's packaged value and is
                     used (with a warning) whenever `from` resolves to nothing
                     usable — see the module header for why that beats a bare
                     `"{{…}}"` string.
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
pnpm --filter lastlight-workflow-engine typecheck   # tsc + the import-boundary gate
```
