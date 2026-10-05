# 00 — Current state: where the YAML dialect strains

Paths are relative to the repo root. Sizes as of `a1e923fa` (v0.38.2).

## Size

| Area | LOC |
|---|---|
| `packages/workflow-engine/src` (scheduler, phase executor, schema, templates, loop-eval) | 5,463 |
| `apps/server/src/workflows` (runner, resume, admission, handlers) | 8,215 |
| — of which app handlers `fanout` / `survey-units` / `post-review` | 4,308 |
| `packages/shared/src/workflow-loader.ts` | 848 |
| Workflow YAML (24 files) / prompts (34 files) | 1,785 / 3,317 |
| `apps/server/tests/workflows` (54 files) | 17,329 |

`pr-review.yaml` alone is 766 lines with 15 phases.

## The durability core is fine

`runWorkflowCore` (`packages/workflow-engine/src/core/scheduler.ts`) re-runs a
workflow from the top on resume; `ExecutionLedger.shouldRunPhase` returns
`run | running | done` per dedup key, so completed phases are skipped. Approvals
persist a `workflow_approvals` row and set the run `paused`
(`phase-executor.ts` `pauseForApproval`). That *is* step-checkpointed durable
execution — hand-rolled. Its gaps are what a real runtime fixes for free:

- **Phase outputs are not persisted.** A skipped (already-done) phase leaves
  `{{phaseOutputs}}` empty after a resume, so workflows smuggle data through
  workspace files and `scratch` (`src/workflows/CLAUDE.md`, "outputs" caveat).
- **Resume bookkeeping is per-construct.** The reviewer loop stores
  `scratch["rloop:<phase>"].pausedAtCycle` and re-reads a skipped review's
  verdict from the ledger (`phase-executor.ts` `runReviewerLoop`, ~200 lines);
  the reply gate stores `scratch[scratch_key].iteration`. Each new construct
  needs its own.
- Context is rebuilt in two places (`simple.ts` and `resume.ts` — "twin in
  simple.ts").

## Where YAML is stretched

1. **Control flow is substring matching on agent output.**
   `contains_BLOCKED` is `output.toUpperCase().includes("BLOCKED")`
   (`phase-executor.ts:1011`) — a READY line followed by "was previously
   blocked" fails the gate (pinned as a parity case in the spike).
   `until: "output.contains('outcome=pushed tried=')"` includes `tried=` only so
   a quoted earlier attempt cannot match. The PR number is regex-scraped from
   the terminal phase (`scheduler.ts:268`).
2. **The expression grammar has no AND or NOT.** `pr-review`'s `review` phase
   therefore depends on a `skipReview` flag precomputed in TypeScript
   (`runner.ts` `seedReviewTriage`), and `promoteFlakyDiagnosis` mutates the
   cached definition's `skip_if` at run time (`simple.ts:1041`). `!= true` and
   `!= 'x'` have opposite polarity on a missing key; unrecognised expressions
   silently evaluate `false` (`core/loop-eval.ts`).
3. **The template language works around itself.** A missing key renders `""`,
   so fallbacks are spelled
   `{{#if a}}{{a}}{{/if}}{{#if !a}}{{b}}{{/if}}`; JSON is spliced into shell
   heredocs; the `FACTS=` resolution line is pasted 13 times in `pr-review`.
4. **DAG semantics are fragile.** Declaring one `depends_on` turns off chain
   synthesis for the whole file; in a synthesized chain every phase is
   `all_success` on its predecessor, so one skipped phase skips everything after
   it; `pr-review` relies on declaration order for `reconcile` → `post-review`.
5. **Parallelism is a special case.** Cross-node concurrency is parked; the only
   concurrency is inside a `type: fanout` node, which cannot pause or loop.
6. **"Generic" in name only.** `fanout`, `survey-units` and `post-review` are
   4.3k LOC of app handlers dispatched by string; the phase executor knows about
   reviewer verdicts, bootstrap labels and approval URLs.
7. **Overlays fork whole files.** `lastlight fork <workflow>` copies the YAML
   plus every referenced prompt; the fork never receives core changes. The
   `default:` tolerance on `{ from: … }` budgets exists only for forks made
   before #385.
