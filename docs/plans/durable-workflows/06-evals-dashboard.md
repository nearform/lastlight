# 06 — Evals and dashboard compatibility

## Evals (`apps/evals`)

Today evals load the real YAML and call the frozen 9-argument `runWorkflow`
(`apps/server/src/evals-api.ts`; `evals-contract.test.ts` pins its arity and
`RunnerCallbacks`), usually with no store and gates off.

With durable workflows:

- Add `runDurableWorkflow(workflow, input, services, { store? })` to the evals
  barrel. Default store: an OpenWorkflow SQLite `:memory:` (or temp-file)
  runtime driven by `tick()` — exactly what the spike tests do, no DB to set up.
- `onPhaseStart` / `onPhaseEnd` map onto `services.hooks.onStepStart/End`,
  which fire for every `agent`/`bash` step with its name — evals keep
  attributing sessions to phases (`bucketSessionsByPhase`).
- Gates: evals pass `gates: {}` (all off) exactly as today.
- Chained re-review cases (`rereview-node.ts`) carry a review ledger across
  rounds in run scratch; in TS that is the previous run's *output*, passed into
  the next round's input — simpler than scratch.
- Keep the old `runWorkflow` export until the last YAML workflow is gone; the
  contract test stays green throughout.

## Dashboard

The dashboard hand-mirrors run shapes (`dashboard/src/api.ts`) and groups
executions by `PhaseRef` labels (`_fix_N`, `_iter_N`, `_branch_<name>`) in
`WorkflowPipeline.tsx`.

- Keep writing `workflow_runs` / `executions` / `workflow_approvals` rows from
  the durable adapter (the hooks above + approval service), so every existing
  view keeps working during migration.
- Step names replace generated labels: `reviewer:fix:1`, `reviewer:recheck:1`,
  `site:<id>:1`. They are already hierarchical (`:`-separated), so grouping
  becomes "prefix before the first `:`" instead of a longest-prefix label match.
- `WorkflowDefinitionDiagram` can no longer render a static phase graph from
  YAML. Replace with the **recorded step trace** of a run (the OpenWorkflow
  `step_attempts` list is exactly that), plus an optional declared `steps`
  array on `defineWorkflow` for the definition page.
