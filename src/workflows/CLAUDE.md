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
| `runner.ts` | The **scheduler**. One sequential walk over a chain-synthesized DAG — no separate linear/DAG paths. Owns the `phases[]`/`outputs{}` accumulation, node status, cancel/skip handling, and the terminal `set_phase`/PR wrap-up. Delegates each node's body to `PhaseExecutor`. Also: `gitAccessProfileForWorkflow`, `gitSandboxAccessForWorkflow`. Re-exports `isTerminated`. |
| `phase-executor.ts` | `PhaseExecutor` — owns every per-phase body (context / standard agent / reviewer-loop / generic-loop, plus approval & reply gates) behind `execute(node, outputs) → PhaseOutcome`. Constructed once per run from three collaborators: run-scoped data, a `PhaseReporter`, a `PhaseResolver`. Also home to `runPhase`, `buildPhasePrompt`, `phaseConfigFor`, `isTerminated`. Unit-tested with fakes (`phase-executor.test.ts`). |
| `dag.ts` | Pure graph logic: `buildDag(phases, { chainIfNoDeps })`, `evaluateTriggerRule`, `getReadyNodes`, `getNodesToSkip`, `isComplete`, `topoSort`. No IO. `chainIfNoDeps` synthesizes a previous-phase chain when no phase declares `depends_on`. |
| `phase-ref.ts` | `PhaseRef` value object — the single authority for building loop-iteration labels (`format()`) and parsing them back (`parse()` → base + kind). No IO. |
| `verdict.ts` | `parseReviewerVerdict(output) → { verdict, viaFallback }` — the one pure parser for a reviewer phase's `VERDICT:` marker (with the fallback heuristic). Both runner verdict sites call it. |
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
        → runWorkflow()              [src/workflows/runner.ts] — the scheduler
          └─ PhaseExecutor.execute()  [src/workflows/phase-executor.ts]
               └─ runPhase()          per node: context / agent / loop
                    └─ executeAgent()  [src/engine/agent-executor.ts]
                         └─ spawns a docker sandbox, runs the agent,
                           parses the event stream + writes the dashboard shim jsonl
```

Approval-gate resumption bypasses the router and re-enters via
`src/workflows/resume.ts → resumeOrphanedWorkflows → runWorkflow` (boot
recovery) or `runSimpleWorkflow` (a fresh trigger on a paused/running run).
Resume is **ledger-driven**: the runner always re-runs from the top and the
`executions` table (via `shouldRunPhase`) skips already-completed phases — no
per-workflow branching, no `currentPhase`-derived resume index.

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
  `executeAgent`. The phase supplies a user prompt via `prompt:` and/or
  a skill catalogue via `skill:`/`skills:`. They can be set
  independently, together, or both:
  - `prompt: prompts/architect.md` renders a template file and passes
    the result as the user prompt.
  - `skills: [pr-review, issue-triage]` (or sugar `skill: pr-review`
    for a single skill) makes each named `skills/<name>/` directory
    available to the agent. Phase setup stages each one at
    `<workspace>/.agents/skills/<name>/` (symlink in gondolin/none,
    copy in docker) before the run. pi-coding-agent's built-in
    `.agents/skills/` auto-discovery surfaces them in the system prompt
    as an XML `<available_skills>` catalogue; the agent reads each
    SKILL.md via its `read` tool on demand — pi.dev's progressive-
    disclosure model. Whole skill *directories* travel along, so any
    `scripts/` / `references/` / `assets/` next to a SKILL.md are
    visible at `.agents/skills/<name>/...`.
  - **When both are set** — the prompt template is the user prompt
    (skill content is *not* auto-embedded), and the staged catalogue
    is available alongside. The template can reference skills by name
    ("see the `pr-review` skill for the structured-feedback format")
    and the agent reads them on demand.
  - **When only skills are set** — the runner emits a short
    auto-generated user prompt nudging the agent to start by reading
    the primary (first-listed) skill's SKILL.md.
  - Phases with neither (`type: context`) get no `.agents/skills/`
    directory staged at all.
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

A sibling YAML field, `web_search: true`, opts the phase into
agentic-pi's `web_search` / `web_fetch` tools. It uses the same
`phaseConfigFor` overlay and the same opt-in-per-phase convention as
`unrestricted_egress`. Phases that opt into web search usually also
want `unrestricted_egress: true` because `web_fetch` against
third-party docs goes through the same firewall path. See the
"Environment" section of the top-level `CLAUDE.md` for the required
provider env vars.

## One scheduler (every workflow is a DAG)

There is a single scheduler — no separate linear/DAG paths. `runWorkflow`
builds a DAG with `buildDag(phases, { chainIfNoDeps: true })`:

- **No `depends_on`** (every production workflow) → chain synthesis adds
  `depends_on: [previousPhase]` (`all_success`) to each phase, reproducing the
  old linear semantics including the failure cascade.
- **Any `depends_on` declared** (only `examples/parallel-review.yaml`) → the
  declared edges are used as-is.

The scheduler then loops `while (!isComplete(dag))`: it skips nodes whose
trigger rule fails (a failure cascades down the chain as **skips**, recorded
in the `executions` ledger), and runs the earliest-declared ready node — **one
at a time, sequentially, in declaration order**. Real concurrency via git
worktrees is deferred to a later issue.

- **One workspace.** Every phase and every loop iteration uses the single
  `ctx.taskId`. The sandbox workspace persists between phases (architect writes
  `plan.md`, executor reads it). The old DAG path's per-phase
  `${taskId}-${phaseName}` clones are gone.
- **Uniform skip semantics.** A node runs iff its trigger rule is satisfied by
  its deps' statuses; otherwise it is skipped (no downstream agent calls; the
  run ends `success: false`). `isTerminated` errors (OOM/cancel) are not
  reported as phase failures, and the failing node's error propagates to the
  run.
- Loop iterations run serially within their node because each fix cycle reads
  the previous reviewer verdict.

## Loop iteration naming

The dashboard's pipeline diagram and the approval gate state machine both
rely on predictable phase names for dynamically-created iterations.

```
First reviewer pass       → reviewer
  approves                → workflow continues
  requests changes
    Fix cycle 1           → reviewer_fix_1       (runs the executor with fix_prompt)
    Re-review (cycle 1)   → reviewer_recheck_1   (runs reviewer again)
    …
    Fix cycle 2           → reviewer_fix_2
    Re-review (cycle 2)   → reviewer_recheck_2
```

All generated labels are built by `PhaseRef.format()` (`phase-ref.ts`) — the
single authority — and parsed back via `PhaseRef.parse()` (base + kind).
`n` is the 1-based **cycle**; `fix_k` and `recheck_k` pair within a
cycle:

- `${parentPhaseName}` — the initial run
- `${parentPhaseName}_fix_${n}` — the nth fix cycle
- `${parentPhaseName}_recheck_${n}` — the nth re-review
- `${parentPhaseName}_iter_${n}` — generic-loop iteration n

The legacy bare-numeric re-review form (`reviewer_2`) is **dropped** — it was
untagged, ambiguous with literal phase names, and inconsistent with the
`_fix_`/`_iter_` tags. It is neither produced nor recognized on resume.

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
runner re-runs from the top and the `executions` ledger (`shouldRunPhase`)
skips already-completed phases, so the re-entry picks up exactly where it
paused. For a standalone **approve** gate the gated phase is already `done` so
the runner proceeds past it; for a **reply** gate the generic-loop node resumes
from `scratch.iteration`. A **reviewer-loop** gate (`loop.approval_gate`) is
mid-loop, so it persists `scratch["rloop:<phase>"].pausedAtCycle` before
pausing and persists each review's output: on resume the loop re-derives the
prior review's verdict from that output (a dedup-`done` review is **not**
assumed APPROVED) and runs the fix cycle for the approved gate rather than
re-pausing. No `currentPhase`-reset scaffolding is involved.

## taskId scoping

Linear and DAG runs compute the taskId once in `simple.ts` and store it
on `workflow_runs.context.taskId`:

```
${repo}-${issueNumber}-${workflowName}-${runId.slice(0, 8)}
```

- Includes the run id suffix so two parallel runs against the same
  issue can't collide on the sandbox workspace.
- The scheduler passes this exact taskId to every `runPhase` call →
  all phases **and all loop iterations** share one workspace (fixes read
  the reviewer's output from the same checkout). The old DAG path's
  per-phase `${taskId}-${phaseName}` clones are gone.

`resume.ts` reconstructs the taskId from the stored `context.taskId` so
a resumed run lands in the same sandbox dir the original started in.

**Per-PR reuse exception (issue #107).** The workflows in
`PER_TARGET_REUSE_WORKFLOWS` (`pr-review`, `pr-fix`) **drop** the run-id
suffix — their taskId is `${repo}-${prNumber}-${workflowName}`, keyed by
(repo, PR) rather than per-run. A re-review of the same PR (push →
`synchronize`, cron PR-review fanout) therefore lands in the **same**
sandbox dir, so `prePopulateWorkspace` does `git fetch` + `reset --hard` +
`git clean -fdx -e node_modules` instead of a fresh 1.3G clone + full
install, and N dirs/PR collapse to 1 (cutting the #106 churn at its
source). `build` is excluded — it creates a new branch per run and must not
reuse. Concurrency is held off by the dispatcher's
`isRunning(skill, triggerId)` guard plus `runs.getByTrigger` reuse; the
cross-run vs same-run distinction is made by a `<workDir>/.lastlight-run`
marker stamped with the owning run id (same id → preserve the checkout for
the next phase; different id → refresh). See `src/sandbox/index.ts`.

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

- `runner.test.ts` — covers the unified scheduler: chain + declared-DAG
  workflows, context phases, loop cycles, approval gates, ledger-driven
  resume, guardrails bypass, sequential ordering, one-workspace, and
  skip-in-ledger.
- `phase-executor.test.ts` — direct unit tests for `PhaseExecutor.execute`
  with fake collaborators (each per-phase body, gates, dedup).
- `golden-build.test.ts` — pins `build.yaml`'s phase sequence under the
  unified scheduler (regression guard against reorders).
- `dag.test.ts` — pure graph scheduling + chain synthesis.
- `loader.test.ts` — YAML validation.
- `templates.test.ts` — variable substitution and `unless_*`.
- `loop-eval.test.ts` — expression evaluator.

Run them with `npx vitest run src/workflows/` from the repo root.
