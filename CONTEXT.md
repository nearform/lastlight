# Last Light — Domain Glossary

The project's **ubiquitous language**. When an issue title, refactor proposal,
test name, or phase label names a domain concept, use the term as defined here.
This file is seeded lazily — terms are added as they get pinned down (most
recently during the `/grilling` of issue #93). It is not exhaustive.

> Orientation lives in `CLAUDE.md`; the rebuild-grade contract in `spec/`.
> This file is narrower: the words we agree to use, and the ones we avoid.

## Workflow execution

- **Workflow** — a YAML file in `workflows/` listing **phases**. The runner
  executes it; it knows nothing about "build" vs "triage".

- **Phase** — one entry in a workflow's `phases:` array. Three kinds: a
  **context phase** (a checkpoint, no agent run), an **agent phase** (one
  sandboxed agent session), and a **loop phase** (an agent phase that repeats).

- **Loop phase** — a phase with `loop:` set. A **reviewer loop** alternates a
  review with a **fix** (a different agent run, the executor with `fix_prompt`)
  up to `max_cycles`, driven by the **reviewer verdict**. A **generic loop**
  (`generic_loop:`) repeats a phase until an `until` expression passes.

- **Cycle** — one fix-then-re-review pair inside a reviewer loop. Cycle `k`
  comprises the **fix** `k` and the **recheck** `k`. (The very first review is
  the loop's initial run, before any cycle.)

- **Scheduler** — the single component that walks a workflow's phases. Every
  workflow is executed as a DAG; a **linear** workflow (no `depends_on`) is a
  degenerate **chain** (synthesized `depends_on: [previous]` edges). Phases run
  **sequentially in topological order**, one at a time. `depends_on` controls
  *ordering* and *trigger-rule skipping* — _not_ parallelism (concurrent
  execution is deferred). _Avoid_: "linear runner" vs "DAG runner" — there is
  one scheduler. (Pre-#94 the two were separate; see [[lastlight-architecture-deepening-issues]].)

- **Workspace** — the single sandbox checkout shared by every phase and loop
  iteration of one workflow invocation (`ctx.taskId`). One checkout per run;
  phases hand off through it (architect writes `plan.md`, executor reads it).

- **PhaseExecutor** — the deep module that owns every per-phase body (context /
  reviewer-loop / generic-loop / standard / approval-gate) behind one
  `execute(node, outputs) → PhaseOutcome`. The scheduler owns ordering and
  accumulation; the PhaseExecutor owns what one phase *does*.

- **Trigger rule** — per-edge condition (`all_success`, `one_success`,
  `none_failed_min_one_success`, `all_done`) deciding whether a node runs given
  its dependencies' statuses. A node whose rule can't be satisfied is
  **skipped** (recorded in the executions ledger).

- **Executions ledger** — the `executions` table is the **single source of
  truth** for "did this phase run and how did it end." It drives resume
  (`shouldRunPhase`) and the dashboard derives phase status from it. _Avoid_
  introducing parallel status stores (the dead `node_statuses` map was
  removed; `phase_history` reconciliation is tracked in #97).

## Phase-iteration naming

The runner generates a phase label for each dynamically-created iteration.
Convention (post-#93):

| Iteration | Label |
| --- | --- |
| initial review | `<phase>` (e.g. `reviewer`) |
| cycle _n_ fix | `<phase>_fix_<n>` |
| cycle _n_ re-review | `<phase>_recheck_<n>` |
| generic-loop iteration _n_ | `<phase>_iter_<n>` |

`n` is the 1-based **cycle** number; `fix_k` and `recheck_k` pair within a
cycle. _Avoid_ the legacy bare-numeric re-review form (`reviewer_2`) — it was
untagged, ambiguous with literal phase names, and inconsistent with the
`_fix_`/`_iter_` tags. These labels are a persisted/observed surface: they land
in `phase_history`, drive resume via `phaseIndexInDefinition`, and the
dashboard groups them by `<phase>_` prefix.

- **PhaseRef** — the value object that is the single authority for building and
  resolving phase-iteration labels: `{ base, kind: 'phase'|'fix'|'recheck'|'iter',
  index? }`. `format()` is the only place labels are constructed; resolution
  (`phaseIndexInDefinition`) stays **definition-aware** with exact-match-first
  ordering. Lives in `src/workflows/phase-ref.ts`.

## Reviewer verdict

- **Reviewer verdict** — a reviewer phase's outcome, `APPROVED` or
  `REQUEST_CHANGES`, parsed from a `VERDICT:` marker line in the agent output
  (with a fallback when the marker is absent). `parseReviewerVerdict` is the
  single pure parser (`src/workflows/verdict.ts`); it reports `viaFallback` so
  callers can warn when the marker was missing.
