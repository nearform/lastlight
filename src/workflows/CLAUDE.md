# Workflow runner

This is where the harness actually executes agent work. Everything that runs
more than one agent call — build cycles, triage scans, health reports, PR
reviews — goes through here. The design goal is that adding a new workflow
should require **only a YAML file** in `workflows/`, no runner changes.

## Files

| File | Role |
|---|---|
| `schema.ts` | Zod schema for `AgentWorkflowDefinition`, `PhaseDefinition`, `PhaseLoop`, `GenericLoop`, `CronWorkflowDefinition`. Source of truth for what a YAML file is allowed to contain. |
| `loader.ts` | Reads `workflows/*.yaml`, validates against the schema, caches parsed definitions. `getWorkflow(name)` is the only lookup the rest of the code uses. |
| `templates.ts` | Mustache-ish template engine. Handles `{{branch}}`, `{{issueDir}}`, `{{contextSnapshot}}`, `{{models.architect}}`, `{{phaseOutputs.guardrails.output}}`, list iteration, and `unless_*` clauses. |
| `simple.ts` | Top-of-stack entry: `runSimpleWorkflow(workflowName, request, …)`. Picks the trigger id, builds the template context, creates or reuses a `workflow_runs` row, then calls `runWorkflow`. |
| `runner.ts` | The actual executor — linear walk over `definition.phases`, dispatches to DAG runner when dependencies are declared, handles loops and approval gates. Contains `runPhase`, `runWorkflow`, `runDagWorkflow`, `nextPhaseAfter`, `isTerminated`. |
| `dag.ts` | Pure graph logic: `buildDag`, `evaluateTriggerRule`, `getReadyNodes`, `topoSort`. No IO. `runDagWorkflow` in `runner.ts` uses it for dependency-aware scheduling. |
| `loop-eval.ts` | Expression evaluator for `generic_loop.until` conditions (`output.contains('PASS')`, `verdict == 'APPROVED'`). |
| `resume.ts` | Startup orphan recovery + approval-gate resume entry point. Called both on harness boot (recover `running` / `paused` runs) and when a user responds to an approval gate. |

## Call graph

```
EventEnvelope
  → src/engine/router.ts           (decides which workflow to run)
    → src/workflows/simple.ts
      → runSimpleWorkflow()
        → loader.getWorkflow(name)   loads + validates YAML
        → db.createWorkflowRun()     or reuses an existing paused/running row
        → runWorkflow()              [src/workflows/runner.ts]
          ├─ runPhase()              per phase: context / agent / loop
          │    └─ executeAgent()     [src/engine/opencode-executor.ts]
          │         └─ spawns a docker sandbox, runs `opencode run --format json`,
          │           parses the event stream + writes the dashboard shim jsonl
          └─ runDagWorkflow()        invoked when any phase has depends_on
```

Approval-gate resumption bypasses the router and re-enters via
`src/workflows/resume.ts → resumeOrphanedWorkflows / resumeWorkflowRun →
runSimpleWorkflow`. The runner's `nextPhaseAfter(definition, currentPhase)`
derives the resume point from the YAML alone — no per-workflow branching.

## Phase types

A phase is one entry in the `phases:` array of a workflow YAML.

```yaml
phases:
  - name: phase_0
    label: Context
    type: context          # no agent run; just marks a checkpoint for the dashboard

  - name: guardrails
    label: Guardrails
    prompt: prompts/guardrails.md    # renders this template, runs an agent
    model: "{{models.guardrails}}"
    variant: "{{variants.guardrails}}"  # reasoning-effort, e.g. minimal/high
    on_output:
      contains_BLOCKED:
        action: fail
        unless_label: "lastlight:bootstrap"
      contains_READY:
        action: continue

  - name: reviewer
    label: Reviewer
    prompt: prompts/reviewer.md
    model: "{{models.reviewer}}"
    variant: "{{variants.reviewer}}"
    approval_gate: post_reviewer     # pause before moving on
    loop:                             # iterate on REQUEST_CHANGES
      max_cycles: 3
      on_request_changes:
        fix_prompt: prompts/executor.md
        fix_model: "{{models.fix}}"
        fix_variant: "{{variants.fix}}"
        re_review_prompt: prompts/reviewer-rereview.md
```

`model:` resolves through `OPENCODE_MODELS` (or the `default` fallback);
`variant:` resolves through `OPENCODE_VARIANTS` (or `OPENCODE_VARIANT`).
Both are optional — omit the YAML entry and the runner uses the env-level
default, omit env-level too and OpenCode picks its built-in default
(model: `OPENCODE_MODEL`, variant: no `--variant` flag passed).

Three kinds of phase the runner recognises:

- **context** (`type: context`) — no agent execution. Runner persists a
  phase-history entry and moves on. Used for `Context` / `complete` markers
  so the dashboard pipeline shows a checkpoint.
- **agent** (`type: agent`, default) — runs one agent session via
  `executeAgent`. `prompt:` and `skill:` are mutually exclusive:
  - `prompt: prompts/architect.md` renders a template file and passes the
    result as the user prompt.
  - `skill: issue-triage` loads `skills/<name>/SKILL.md` and prepends a
    canonical `"Follow these skill instructions:\n\n<SKILL.md>\n\nContext:\n<ctx>"`
    wrapper. Used by single-phase skill workflows (triage, review, health).
- **loop-phase** — any phase with `loop:` set. Always executes as an
  agent phase internally, but repeated in `reviewer → fix → reviewer`
  pairs up to `max_cycles`. See loop iteration naming below.

`generic_loop` is a second, newer loop mechanism with an `until`
expression (evaluated by `loop-eval.ts`) instead of fixed review/fix
cycles. Used for custom "retry until X" phases.

## Per-phase egress policy

Any phase can declare `unrestricted_egress: true` to bypass the sandbox
HTTP egress allowlist for that phase only. Default (field absent or
`false`) runs with the allowlist from `src/sandbox/egress-allowlist.ts` —
GitHub, LLM provider hosts, public package registries. When `true`:

- **gondolin**: agentic-pi receives `allowedHttpHosts: ["*"]` (wildcard
  allow-all). The QEMU-layer block is bypassed but private-IP rules at
  lower layers still apply.
- **docker**: the sandbox container's `--dns` flag points at
  `coredns-open` (172.30.0.11) instead of `coredns-strict`. That coredns
  resolves any hostname to `nginx-egress-open`'s IP, which tunnels
  whatever SNI it sees. Cloud-metadata literals (`169.254.169.254`,
  `metadata.google.internal`) are still NXDOMAIN'd by coredns-open as
  a hard SSRF floor.

Use sparingly — this is the exfil control the allowlist exists to enforce.
Typical use case is an `explore` phase that needs to search third-party
documentation. The setting is propagated by `phaseConfigFor()` in
`runner.ts`, which overlays `phase.unrestricted_egress` onto the
`ExecutorConfig` before each `runPhase` call.

## Linear vs DAG runner

`runWorkflow` checks `hasDependencies(definition)`. If any phase has
`depends_on`, it hands off to `runDagWorkflow`; otherwise it walks
`definition.phases` in declaration order.

- **Linear runner** shares one `taskId` across all phases of the run. The
  sandbox workspace persists between phases (architect writes `plan.md`,
  executor reads it). This is the default for build / triage / review.
- **DAG runner** gives each phase its own phase-scoped taskId
  (`${taskId}-${phaseName}`) so concurrent phases can't race on the
  workspace. Uses `buildDag` + `getReadyNodes` from `dag.ts` to dispatch
  ready nodes in parallel.

Loop iterations always run serially (even in the DAG path) because each
fix cycle reads the previous reviewer verdict.

## Loop iteration naming

The dashboard's pipeline diagram and the approval gate state machine both
rely on predictable phase names for dynamically-created iterations.

```
First reviewer pass       → reviewer
  approves                → workflow continues
  requests changes
    Fix cycle 1           → reviewer_fix_1   (runs the executor with fix_prompt)
    Re-review             → reviewer_2       (runs reviewer again)
    …
    Fix cycle 2           → reviewer_fix_2
    Re-review             → reviewer_3
```

General rule: `${parentPhaseName}` for the first run, `${parentPhaseName}_${n+1}`
for the nth re-run, `${parentPhaseName}_fix_${n}` for the nth fix cycle.
Generic loops use `${parentPhaseName}_iter_${iteration}`.

The dashboard's `WorkflowPipeline.tsx` uses a longest-prefix match to
group these under the declared parent (`reviewer_fix_1` → belongs to
`reviewer`) and stacks them vertically below that column in the pipeline
diagram.

## Approval gates

Any phase can declare `approval_gate: <name>` (or `loop.approval_gate:
<name>`). When the runner reaches one it:

1. Calls `persistPhase(phaseName, …)` so the `phase_history` records it.
2. Writes a row to `workflow_approvals` with status `pending`.
3. Sets the workflow run status to `paused` and returns
   `{ success: true, paused: true, phases }`. The dispatch path in
   `src/index.ts` swallows this as a non-failure.

The user then resolves the gate via one of:

- **GitHub comment**: `@last-light approve` / `@last-light reject <reason>`.
  Router classifies it and dispatches the `approval-response` skill.
- **Slack slash**: `/approve [workflowRunId]`, `/reject [id] [reason]`.
- **Dashboard**: approve/reject button on the workflow detail page.

All three paths funnel into the same `resumeWorkflowRun(run, sender)`
callback wired in `src/index.ts`. It updates `workflow_approvals`,
flips the run back to `running`, and re-enters `runSimpleWorkflow`. The
runner's `nextPhaseAfter(definition, run.currentPhase)` skips already-
completed phases, so the re-entry picks up exactly where it paused.

## taskId scoping

Linear and DAG runs compute the taskId once in `simple.ts` and store it
on `workflow_runs.context.taskId`:

```
${repo}-${issueNumber}-${workflowName}-${runId.slice(0, 8)}
```

- Includes the run id suffix so two parallel runs against the same
  issue can't collide on the sandbox workspace.
- Linear runner passes this exact taskId to every `runPhase` call →
  all phases share one workspace.
- DAG runner uses `${taskId}-${phaseName}` for parallel phases →
  concurrent writes are isolated.
- Loop iterations use the linear taskId (fixes read the reviewer's
  output from the same workspace).

`resume.ts` reconstructs the taskId from the stored `context.taskId` so
a resumed run lands in the same sandbox dir the original started in.

## Templates

`templates.ts` renders phase prompts, approval-gate messages, and
notification strings. Variables come from two places:

- **Run-scoped context** built in `simple.ts`: `owner`, `repo`,
  `issueNumber`, `issueTitle`, `issueBody`, `issueLabels`, `commentBody`,
  `sender`, `branch`, `taskId`, `issueDir`, `contextSnapshot`, plus the
  `models` map and `...request.extra`.
- **Phase-scoped context** assembled inside `runPhase`: `phaseOutputs`
  (a map keyed by declared `output_var` in each phase), `fixCycle`
  (loop only), and the most recent `previousOutput`.

Loop phases render the `fix_prompt` and `re_review_prompt` through the
same engine, so they can reference `{{phaseOutputs.reviewer.output}}`
and similar.

## Testing

Unit tests for every non-trivial piece live alongside the source:

- `runner.test.ts` — 1000+ lines, covers linear and DAG paths, context
  phases, loop cycles, approval gates, resume, guardrails bypass, and
  the nextPhaseAfter / isTerminated helpers.
- `dag.test.ts` — pure graph scheduling.
- `loader.test.ts` — YAML validation.
- `templates.test.ts` — variable substitution and `unless_*`.
- `loop-eval.test.ts` — expression evaluator.

Run them with `npx vitest run src/workflows/` from the repo root.
