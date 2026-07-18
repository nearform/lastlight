# Workflow runner

This is where the harness actually executes agent work. Everything that runs
more than one agent call — build cycles, triage scans, health reports, PR
reviews — goes through here. The design goal is that adding a new workflow
should require **only a YAML file** in `workflows/`, no runner changes.

## Files

| File | Role |
|---|---|
| `schema.ts` | Zod schema for `AgentWorkflowDefinition`, `PhaseDefinition`, `PhaseLoop`, `GenericLoop`, `CronWorkflowDefinition`. Source of truth for what a YAML file is allowed to contain. Also home to the optional top-level `classification:` block (`intent`/`description`/`examples`) — how a workflow contributes its category to the composed intent classifier and claims a routable intent (issue #164) — plus `RESERVED_CONTROL_INTENTS` + `intentToken()`. |
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

**Retry a failed run.** The dashboard's Retry button (and `lastlight workflow
retry <id>`) reuses the exact same ledger-driven machinery via
`config.retryWorkflow` (`src/index.ts`) → `WorkflowRunStore.restartRun` (flips
`failed → running`, clears `finished_at`/`context.error`, compare-and-set so a
double-click no-ops) → `resumeSimpleRun`. The failed phase's ledger row is
`success=0`, so `shouldRunPhase` re-runs it while already-succeeded phases skip —
resuming from the phase that failed with the same context, taskId and workspace.
Unlike the approval `resumeWorkflow` path (which rebuilds a lossy
owner/repo/issueNumber context), retry reconstructs the full context from the
stored `workflow_runs.context` + `scratch`, so it also retries Slack-thread-scoped
runs (e.g. an `explore` started from Slack).

> **Caveat — skipped phases don't re-expose outputs.** A phase skipped on resume
> because its ledger row is already `success=1` contributes **nothing** to the
> in-memory `outputs` map: `PhaseExecutor.runStandard` returns no `outputVars` on
> a dedup-`done` skip, and standard phases never persist `output_text`. So a
> still-to-run phase that reads a *skipped* upstream via
> `{{phaseOutputs.X.output}}` / an `output_var` would see it EMPTY. Every
> production workflow avoids this by handing large context between phases through
> committed build-assets / workspace files / `scratch` (explore writes
> `explore-context.md` + `scratch.socratic.qa`; build/pr-review hand off via
> committed docs), not `{{phaseOutputs}}` across a resume boundary. Keep it that
> way when authoring retryable workflows.

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

Phase kinds the runner recognises:

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
    available to the agent. Phase setup stages each one into a
    **per-phase bundle** at
    `<workspaceRoot>/.lastlight-skills/<phaseName>/<name>/` (symlink in
    gondolin/none, copy in docker) before the run, then maps the bundle
    to the agent explicitly via pi's `--skill`/`skillPaths` (absolute
    paths, so cwd is irrelevant). The bundle lives at the **workspace
    root** — a sibling of any checked-out repo, never inside its git tree
    (so the agent never sees or commits it) — and is keyed per phase so
    two phases sharing a workspace (sequential today, parallel via
    worktrees later) can't clobber each other's catalogue. pi surfaces
    the mapped skills in the system prompt as an
    XML `<available_skills>` catalogue; the agent reads each SKILL.md via
    its `read` tool on demand — pi.dev's progressive-disclosure model.
    Whole skill *directories* travel along, so any `scripts/` /
    `references/` / `assets/` next to a SKILL.md come too.
  - **When both are set** — the prompt template is the user prompt
    (skill content is *not* auto-embedded), and the staged catalogue
    is available alongside. The template can reference skills by name
    ("see the `pr-review` skill for the structured-feedback format")
    and the agent reads them on demand.
  - **When only skills are set** — the runner emits a short
    auto-generated user prompt nudging the agent to start by reading
    the primary (first-listed) skill's SKILL.md.
  - Phases with neither (`type: context`) get no skill bundle staged at
    all.

  > **cwd + skill-bundle placement.** When the harness pre-clones the
  > repo (`prePopulateBranch`), the agent's cwd **is** the checkout, so
  > commands run inside the repo with no `cd` preamble. The skill bundle
  > stays a sibling at the workspace root, reached by an absolute
  > `--skill`/`skillPaths` path — on docker the whole workspace is mounted
  > so this resolves even with cwd inside the repo; on `none` the host FS
  > is fully visible in-process. **gondolin** mounts *only* cwd, so a
  > workspace-root sibling would be invisible — there the bundle is staged
  > under the repo instead and added to the checkout's local
  > `.git/info/exclude` (never committed). Non-pre-cloned workflows run
  > with cwd = the workspace root and clone the repo into a subdir.
  > `build`, `pr-review`, `pr-fix`, **`verify`, and `qa-test`** pre-clone
  > (`PREPOPULATE_SYNTH_WORKFLOWS` in `simple.ts` + the pr-* dispatcher);
  > verify/qa-test were added so their browser-QA screenshots, written to
  > `.lastlight/<key>/` under the repo, land where `serverArtifacts()`
  > harvests them rather than orphaned at the workspace root.
- **bash** (`type: bash`) — runs a deterministic shell command
  (`command:`) **inside the sandbox container** (no LLM). Built on
  `DockerSandbox.runCommand` (the non-agent sibling of `runAgent`:
  `docker exec --user agent -w <cwd> … sh -c <cmd>`), running in the same
  workspace agent phases use (the host `workDir` persists across phases by
  taskId). Exit 0 = success; a non-zero exit **fails the phase** and cascades
  like any phase failure. The command is rendered through the template engine
  first (so it can reference `{{phaseOutputs.*}}`, `{{branch}}`, …), then a
  post-render `validateShellCommand` guard rejects any leftover `{{` marker.
  stdout is exposed downstream exactly like an agent phase
  (`output_var` → `{{phaseOutputs.<name>}}`); upstream string outputs
  are also forwarded as `LL_OUT_<PHASE>` env vars (single-line, ≤4KB).
  Honours `unrestricted_egress` / `sandbox_image` / `timeout_seconds`. The run
  is mirrored to a session jsonl (command → `bash` tool_use, output →
  tool_result) so it shows in the dashboard + `lastlight session log` like an
  agent turn, with `turns: 0` and no model cost. On gondolin/none the command
  falls back to a host `spawnSync` in the workspace.
- **script** (`type: script`) — same machinery as `bash`, but runs an inline
  program (`script:`) with a runtime selected by `runtime:` — `js`/`ts` →
  `node` (TS via `--experimental-strip-types`), `python` → `uv run`. The source
  is written to a workspace-root sibling beside the skill bundle (`.lastlight-scripts/<phase>/script.<ext>`,
  never inside the repo git tree) and executed there. Python sources may carry
  a PEP 723 `# /// script` inline-dependency block — `uv run` resolves it from
  PyPI (already on the strict egress allowlist) into a cached venv
  (`UV_CACHE_DIR=/cache/uv`, `UV_PYTHON_DOWNLOADS=never` so it uses the baked-in
  python3).
- **loop-phase** — any phase with `loop:` set. Always executes as an
  agent phase internally, but repeated in `reviewer → fix → reviewer`
  pairs up to `max_cycles`. See loop iteration naming below.

`type: bash`/`type: script` phases share the agent phase's dedup ledger
(`runCommandPhase` → `runPhaseLedger`), so they get an `executions` row and
dedup on resume like everything else.

`generic_loop` is a second, newer loop mechanism with an `until`
expression (evaluated by `loop-eval.ts`) instead of fixed review/fix
cycles. Used for custom "retry until X" phases. Its `until_bash` exit-condition
runs **inside the sandbox** (via `executeCommand`, `writeSession: false`)
against the persisted workspace — exit 0 ends the loop. (It used to run on the
harness host via `execSync`; it now executes in the same container the phase
does.)

**Soft-failure policy (`generic_loop.on_soft_failure`).** By default any
non-success iteration hard-fails the whole workflow. That's wrong for a
long interactive loop like `explore`'s `socratic` phase: a single degenerate
turn — the agent exits cleanly but emits no final text and no `agent_end`, so
`mapStopReason` returns `"unknown"` (a *soft* outcome, distinct from a real
crash) — would discard every accumulated Q&A round. Declaring
`on_soft_failure: { retries: N, then: fail | complete }` makes the loop
resilient: a soft iteration re-runs up to `N` times (under a distinct
`_iter_n_retry` ledger label), and if it's *still* soft, `then: complete`
treats the loop as finished (as if `until` matched) and advances downstream
with the work gathered so far, while `then: fail` (the default) keeps the
old hard-fail. The soft/hard split is the generic `isSoftOutcome(result)`
classifier (phase-executor.ts, shared with the reviewer loop's fallback
recovery) — soft = `stopReason` `unknown` / `error_truncated`; hard =
terminated / `error_fatal` / `error_tool` / `error_exit_*`. Field absent ⇒
today's behavior exactly (only `explore.yaml`'s socratic phase opts in).

**No-op / empty-completion backstops.** Two guards stop a run that never
produced a real result from passing green — see
[`spec/06-workflow-engine.md`](../../spec/06-workflow-engine.md) for the
contract: (1) `on_output.requires_marker: "<MARKER>"` fails a phase whose final
output lacks the marker (a per-workflow postcondition — e.g. dependabot-pr-merge
requires `ASSESSMENT_COMPLETE`); (2) `reclassifySuccess` (executors/shared.ts)
demotes a terminal `agent_end` that carried **no final answer** (an empty
completion, including agentic-pi's synthesized backstop) from `success` to the
soft `unknown`, so it fails a plain phase and retries in a loop.

## Per-phase sandbox requirement (`requires_sandbox`)

A phase can declare `requires_sandbox: docker | gondolin | none` to gate itself
on the backend the harness is actually running. If the active backend (the
run-level `config.sandbox`, defaulting to gondolin) doesn't match, the scheduler
**silently skips** the phase — recorded as a *non-failing* skip in the
`executions` ledger, exactly like a trigger-rule skip, and surfaced via the
phase's `messages.on_skipped_done`. This is safe-by-default graceful
degradation for phases whose tooling is baked only into a specific sandbox image
(e.g. a future `/demo` video-render step that needs the docker image): on a
gondolin-only host the step no-ops instead of failing the workflow.

The gate lives in `runWorkflow`'s scheduling loop (it filters ready nodes before
execution), not in `phaseConfigFor`. Because a skipped node is not `succeeded`,
a downstream phase depending on a gated phase via the default `all_success` rule
would itself skip — keep gated phases **terminal**, or give their dependants
`trigger_rule: all_done`.

### Per-phase sandbox image (`sandbox_image`)

A phase can declare `sandbox_image: qa` to run on the enriched browser-QA image
(`lastlight-sandbox-qa:latest` — Playwright + Chromium baked in) instead of the
lean default (`lastlight-sandbox:latest`). The field is overlaid by
`phaseConfigFor` onto `ExecutorConfig.sandboxImage`; only the docker path acts on
it (the orchestrator's `withSandbox` resolves `imageName` from `sandbox_image`
and passes it to `sandboxFor`; the `DockerSandbox` adapter forwards it to
`createTaskSandbox({ imageName })`). The image name is a fixed constant in
`src/sandbox/images.ts` (`SANDBOX_IMAGE_QA`) — not env-overridable.

Pair it with `requires_sandbox: docker` so the phase skips on gondolin. On the
docker backend the scheduler *also* skips it when the QA image isn't built
(`qaImageAvailable()` in `images.ts`, kept docker-free so the runner can import
it), recorded as the same non-failing skip. So the phase runs only where browser
QA is genuinely possible; otherwise it no-ops. This is the Tier B browser-QA
mechanism — see `docs/tier-b-browser-qa-scope.md` and `skills/browser-qa/`.

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
- `${parentPhaseName}_iter_${n}_retry` — the one-shot retry of a generic-loop
  iteration whose first attempt came back soft (see `on_soft_failure` above); it
  gets its own ledger row so resume/dedup treats it as a distinct step, and the
  dashboard's longest-prefix grouping still nests it under the parent

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

A gate can also name the artifact it's asking a human to approve via
`approval_artifact: <filename>` (alongside `approval_gate` / inside `loop:`),
e.g. `architect-plan.md` or `reviewer-verdict.md`. The filename is stored on
the `workflow_approvals` row (`artifact` column) and powers the **focused
approval view** (below). The gate's `approval_gate_message` can deep-link to
that view with the `{{approvalUrl}}` template helper — `PhaseExecutor.
pauseForApproval` injects the freshly-minted `approvalId` into the message
render context, and `{{approvalUrl}}` renders `${publicUrl}/admin/?approval=<id>`
(empty when no `PUBLIC_URL` is configured, so the rest of the message still
posts). This works identically for GitHub- and Slack-initiated runs — both
build the same template context with `publicUrl = callbacks.publicUrl`.

The user then resolves the gate via one of:

- **GitHub comment**: `@last-light approve` / `@last-light reject <reason>`.
  Router classifies it and dispatches the `approval-response` skill.
- **Slack slash**: `/approve [workflowRunId]`, `/reject [id] [reason]`.
- **Dashboard**: approve/reject button on the workflow detail page, or the
  **focused approval view** at `/admin/?approval=<id>` (deep-linked from the
  gate message / the run-detail banner's "Open focused review" link). It loads
  `GET /admin/api/approvals/:id`, which enriches the approval with an
  `artifactRef` derived from the run (`context.owner` + bare `repo` +
  `buildAssetIssueKey`): in **server** storage mode the view embeds the
  artifact editor (edit + save the store doc, then approve); in **repo** mode it
  links out to the doc's file on GitHub (`context.branch` + `issueDir`). Both
  approve/reject go through the same `POST /approvals/:id/respond` →
  `config.resumeWorkflow` path as the inline button.

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
source).

**Per-target recreate (issue #153).** `PER_TARGET_RECREATE_WORKFLOWS`
(`build`) *also* drops the run-id suffix (taskId `${repo}-${issueNumber}-build`)
so a re-triggered build lands in the **same** sandbox dir — but on a
*different*-run marker it **deletes the leftover checkout and re-clones from the
default branch** instead of refreshing the (stale) feature branch. An incomplete
build is therefore disposable: re-running it starts again off current `main`,
and its `lastlight/N-slug` branch is always cut from the latest default, never a
stale pushed branch. This is driven by `recreateFromBase` on `GitSandboxAccess`
/ `PrePopulateSpec` (set in `gitSandboxAccessForWorkflow`).

Concurrency is held off by the dispatcher's `isRunning(skill, triggerId)` guard
plus `runs.getByTrigger` reuse; the cross-run vs same-run distinction is made by
a `<workDir>/.lastlight-run` marker stamped with the owning run id (same id →
preserve the checkout for the next phase — the architect's `plan.md` survives;
different id → refresh for pr-review/pr-fix, recreate-from-base for build). The
workspace-provisioning policy sets live in `src/workflows/target-policy.ts`; the
clone logic is in `src/sandbox/index.ts`.

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
