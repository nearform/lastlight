# 05 — Migration

## The deterministic YAML → TS converter

`apps/server/scripts/yaml-to-ts.mjs <workflow.yaml|dir> <outDir>` emits one
`defineWorkflow` module per agent workflow. Design rules:

- **Literal, not pretty.** It reproduces the YAML engine's semantics exactly,
  through `y*` compat helpers (`packages/workflow-engine/src/durable/compat.ts`):
  chain synthesis and trigger rules via an explicit phase-status table
  (`yTrigger`), the substring BLOCKED rule (`yBlocked`), the `!= 'x'` vs
  `!= true` missing-key polarity (`yNeq` / `yBool`), unparseable expression ⇒
  `false`. Every helper call is a marked place to simplify by hand later.
- **Loud, never lossy.** Anything it cannot translate becomes a
  `TODO(convert): …` comment, and untranslatable *behaviour* becomes a step that
  throws at run time — nothing is silently dropped.
- **Deterministic.** Same input → same bytes (verified by hashing two runs).
- Crons (`kind: cron`) are skipped — they are trigger config, not workflows.

Results on the 15 packaged agent workflows (all typecheck):

| Status | Workflows |
|---|---|
| Clean | answer, dependabot-pr-merge, issue-comment, issue-triage, pr-comment, repo-health, security-feedback, security-review |
| Checklist reporter only | build, explore |
| + `requires_sandbox` skip, `final_message` | demo, qa-test, verify |
| + `scratch.fixMarkers` reads (writer lives in core's `fix-harvest.ts`) | pr-fix, dependabot-ci-fix |
| 21 TODOs: `survey-units` / `fanout` / `post-review` handlers, `scratch.reviewTriage` | pr-review |

The `scratch.*` TODOs are the important finding: those values are written by
core-side `onPhaseEnd` harvests, invisible in the YAML. In TS they become an
explicit `ctx.step("diagnose:markers", () => parseFixMarkers(diagnose.output))`
— the dependency is in the workflow instead of in a hook.

**Parity is tested, not asserted:** `tests/workflows/durable/yaml-parity.test.ts`
runs the converter fresh, then drives the YAML engine and the generated TS with
the *same* scripted agent across 14 scenarios (happy paths, BLOCKED, bootstrap
bypass, the substring quirk, reviewer cycle caps, missing markers, `until_bash`)
and asserts identical agent call sequences and outcomes. All 14 match.

## Order

1. **Land the foundation** (no behaviour change): `durable/` API in the engine,
   the Drizzle `Backend` (both dialects), the runtime wired into `index.ts`
   boot/shutdown, dispatch able to route a workflow to either engine by name
   (`durable: true` list in config), approvals endpoints resolving both kinds.
2. **Convert the clean eight** with the converter, ship them behind the flag,
   compare in evals, flip the default per workflow.
3. **build / explore / verify / qa-test / demo**: port the checklist reporter
   onto `ctx.notify` + hooks, then hand-simplify (drop `y*` helpers).
4. **pr-fix / dependabot-ci-fix**: move the fix-marker harvest into explicit
   steps.
5. **pr-review last**: port the three handlers into library functions
   (`surveyUnits`, `fanoutSites` = `ctx.parallel`, `postReview`), then retire
   `seedReviewTriage` and `promoteFlakyDiagnosis` — both exist only because
   YAML can't compute.
6. **Delete the dialect**: `schema.ts`, `templates.ts` (prompt rendering stays),
   `loop-eval.ts`, `dag.ts`, `scheduler.ts`, `phase-executor.ts`, `PhaseRef`
   labels, `resume.ts`'s re-run-from-top, and the overlay `fork` path for YAML.

## In-flight runs across the cut-over

A run started on the YAML engine finishes on the YAML engine (it is keyed by
its `workflow_runs` row); only new dispatches route to the durable engine. For
later code changes, `version` pins replay: keep the old version registered
until its runs drain, or fail them with a "re-trigger" message. Approval gates
that wait days are the main reason to keep N-1 registered.
