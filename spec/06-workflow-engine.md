---
title: "Workflow Engine"
order: 6
description: "The YAML grammar, the phase runner (linear and DAG), loop iterations, approval and reply gates, the template engine's data flow, taskId scoping, idempotency, and the resume protocol that survives process restarts."
---

## Purpose

The workflow engine is the part of Last Light that decides what to run,
in what order, with what inputs, and how to recover when the process
dies. It is workflow-agnostic — the runner doesn't know `build.yaml`
from `issue-triage.yaml`. It loads a definition, executes phases, calls
out to the [Sandbox](/spec/09-sandbox) for each agent session, persists
state to SQLite, and handles every gate and loop the YAML can declare.

Every behaviour in Last Light — build, triage, review, explore, health,
security, answer, verify, qa-test, demo — is a YAML file consumed by this
engine.

## Public contract

```ts
export async function runSimpleWorkflow(
  workflowName: string,
  request: SimpleWorkflowRequest,
  config: ExecutorConfig,
  callbacks: RunnerCallbacks,
  db: StateDb,
  models?: ModelConfig,
  approvalConfig?: ApprovalGateConfig,
  bootstrapLabel = "lastlight:bootstrap",
  variants?: VariantConfig,
): Promise<WorkflowResult>;

interface WorkflowResult {
  success: boolean;
  phases: PhaseResult[];
  paused?: boolean;     // hit an approval or reply gate
  prNumber?: number;    // build cycle that produced a PR
}
```

`src/workflows/simple.ts:84–310` is the entry point everything funnels
through — webhook dispatch, CLI, cron, admin resume.

## YAML schema

**Workflow level** (`src/workflows/schema.ts:201–236`):

```ts
{
  kind: string;          // "agent" by default; "build" / "triage" / etc. for categorisation
  name: string;          // unique workflow name; lookup key
  description?: string;
  trigger?: string;      // informational
  variables?: Record<string, string>;
  classification?: {     // how the intent classifier routes to this workflow (issue #164)
    intent: string;      //   the intent token this workflow owns (unique; not a control intent)
    description: string; //   the category paragraph merged into the composed classifier prompt
    examples?: string[]; //   optional one-line classifier examples
  };
  phases: PhaseDefinition[];
}
```

The optional `classification` block makes a workflow **self-describing to the
router**: its `description`/`examples` are composed into the classifier prompt
(`workflows/prompts/classifier.md`), and its `intent` becomes routable via the
router's `getWorkflowByIntent` fallback — so adding a workflow (even in an
overlay) can add a new intent with no core change. See
[05-router.md → Build-intent classifier](05-router.md#build-intent-classifier).

**Phase level** (`schema.ts:84–182`):

```ts
{
  name: string;                         // unique within workflow
  label?: string;                       // dashboard display
  type?: "context" | "agent" | "bash" | "script";  // default "agent"
  prompt?: string;                      // path to template, e.g. "prompts/architect.md"
  command?: string;                     // type: bash — deterministic shell command (templated)
  script?: string;                      // type: script — inline source (templated)
  runtime?: "js" | "ts" | "python";     // type: script — js/ts → node, python → uv run (default "js")
  timeout_seconds?: number;             // type: bash/script — per-step timeout (default 300)
  skill?: string;                       // single skill name; sugar for `skills: [<name>]`
  skills?: string[];                    // per-phase bundle: <workspaceRoot>/.lastlight-skills/<phase>/<name>/
                                        // may coexist with `prompt`; mutually exclusive with `skill`
  model?: string;                       // can be "{{models.architect}}"
  variant?: string;                     // reasoning effort; can be "{{variants.fix}}"
  approval_gate?: string;               // pause gate name
  approval_artifact?: string;           // handoff doc this gate approves (e.g. architect-plan.md)
  approval_gate_message?: string;       // template rendered when pausing ({{approvalUrl}} deep-links the focused view)
  depends_on?: string[];                // triggers DAG mode if any phase has it
  trigger_rule?:
    | "all_success" | "one_success"     // DAG firing conditions
    | "none_failed_min_one_success"
    | "all_done";
  output_var?: string;                  // alias for {{this.field}} in later phases
  unrestricted_egress?: boolean;        // bypass strict allowlist for this phase
  web_search?: boolean;                 // enable agentic-pi web tools
  requires_sandbox?: "docker" | "gondolin" | "none";  // skip phase (non-failing) if active backend differs
  sandbox_image?: "default" | "qa";     // docker only: "qa" runs on lastlight-sandbox-qa (Playwright+Chromium+ffmpeg); skips if unbuilt
  loop?: PhaseLoop;                     // reviewer-fix loop
  generic_loop?: GenericLoop;           // until-condition loop
  on_output?: OutputRule[];             // e.g. contains_BLOCKED → fail
  on_success?: { set_phase: string };   // terminal marker
  messages?: PhaseMessages;             // per-event reply templates
}
```

Defined with Zod; loaded and cached by `loader.ts`.

## Phase types

Four: `context` (no execution), `agent` (one LLM session), and the
deterministic `bash` / `script` pair (a command, no LLM).

- **context** — a checkpoint. The runner writes a `phase_history` row and
  moves on. Used to mark dashboard pipeline stages without spending
  tokens (`runner.ts:480–491`).
- **agent** — render the user prompt (from `prompt:` if set, else
  auto-generate a nudge toward the primary skill), stage any declared
  skills into the per-phase bundle
  `<workspaceRoot>/.lastlight-skills/<phase>/<name>/` (mapped via
  `--skill`/`skillPaths`), call `executeAgent()` in the
  [Sandbox](/spec/09-sandbox), capture output.
  Iterates if `loop:` or `generic_loop:` is declared. See
  [Phases & Prompts](/spec/07-phases-and-prompts) and
  [Skills](/spec/08-skills) for the prompt/skill mechanics.
- **bash** — run a deterministic shell command (`command:`) **inside the
  sandbox container** via `executeCommand()` (no LLM). Built on
  `DockerSandbox.runCommand` (the non-agent sibling of `runAgent`:
  `docker exec --user agent -w <cwd> … sh -c <cmd>`), in the same workspace
  agent phases use (the host workDir persists across phases by taskId). The
  command is template-rendered first (so it can reference
  `{{phaseOutputs.<name>}}`, `{{branch}}`, …) then a post-render
  `validateShellCommand` guard rejects any leftover `{{` marker. Exit 0 =
  success; a non-zero exit **fails the phase** and cascades like any phase
  failure. stdout is exposed downstream like an agent phase (`output_var` →
  `{{phaseOutputs.<name>}}`); upstream string outputs are also forwarded as
  `LL_OUT_<PHASE>` env vars. The run is mirrored to a session jsonl (command →
  `bash` tool_use, output → tool_result) so it appears in the dashboard +
  `lastlight session log` like an agent turn, with `turns: 0` and no model
  cost. On gondolin/none it falls back to a host `spawnSync`.
- **script** — same machinery as `bash`, but runs an inline program
  (`script:`) with the runtime in `runtime:` — `js`/`ts` → `node` (TS via
  `--experimental-strip-types`), `python` → `uv run`. The source is written to
  a workspace-root sibling beside the skill bundle
  (`.lastlight-scripts/<phase>/script.<ext>`, never inside the repo git tree). Python sources may carry a PEP 723 `# /// script`
  inline-dependency block, resolved by `uv` from PyPI (on the strict egress
  allowlist) into a cached venv. See [Sandbox](/spec/09-sandbox).
- **post-review** — a first-class, **in-process** PR-review submission
  (`PhaseExecutor.runPostReview`; no sandbox). It reads the reviewer agent's
  `.lastlight/pr-review/findings.json` for the review *content only*
  (`{ skip?, summary, event, findings[] }`) from the persisted host checkout,
  and supplies every other fact from the harness's own run context: the PR
  number (`ctx.prNumber`/`ctx.issueNumber`), the base ref (`ctx.baseBranch`),
  and the head SHA + diff (`git` on the checkout). It anchors each finding to a
  changed line via `src/engine/github/review-poster.ts`, demotes off-diff
  findings to the body, and posts one review through `GitHubClient` (App auth in
  prod; a bearer token + `config.githubApiBaseUrl` against the eval mock, which
  serves no App-token or diff endpoint). A genuine failure — missing findings
  after a real review, or a GitHub error surviving the body-only retry — **fails
  the phase**; a legitimate `skip` succeeds without posting. Idempotent on
  resume (no-op when a bot review already exists on the head SHA). This replaced
  the earlier in-sandbox `type: script` poster, which depended on the AI
  hand-writing `pr_number`/`base_ref`/`head_sha` into the JSON and silently
  `exit 0`'d on any mismatch.

The `bash`/`script` deterministic types share the agent phase's dedup ledger
(`runCommandPhase` → `runPhaseLedger`), so they get an `executions` row and
dedup on resume like everything else. They also inherit the run's minted
`GITHUB_TOKEN` (scoped by the workflow's permission profile). When the harness
configures a GitHub API base-url override (`config.githubApiBaseUrl`, set only
by the eval harness to point at its mock), `runSandboxedCommand` forwards it into
the command env as `GITHUB_API_URL`, and `post-review` reads it directly to
build its `GitHubClient`; in production both are unset, so GitHub calls fall
back to `api.github.com`.

## Linear vs DAG

The decision is automatic:

```ts
// src/workflows/runner.ts:330
function hasDependencies(definition): boolean {
  return definition.phases.some(p => p.depends_on?.length);
}
```

If any phase declares `depends_on`, the entire workflow runs through
the DAG executor (`runner.ts:1092–1486`); otherwise it walks the phase
array in order (`runner.ts:457–1033`).

- **Linear** — single `taskId` shared across phases. The sandbox
  workspace persists, so the executor can read the architect's
  `architect-plan.md`.
- **DAG** — `buildDag(phases)` from `dag.ts` produces a node graph;
  `getReadyNodes()` returns nodes whose dependencies are satisfied per
  `trigger_rule`. Concurrent phases run via `Promise.allSettled()`.
  Each gets a phase-scoped taskId (`${taskId}-${phaseName}`) so they
  don't trample each other's workspaces.

Loop iterations always run sequentially even inside DAG-mode workflows
(fix cycles read the prior reviewer verdict).

## Loops

Two flavours.

### `loop` — reviewer/fix cycle

```yaml
- name: reviewer
  prompt: prompts/reviewer.md
  loop:
    max_cycles: 2
    on_request_changes:
      fix_prompt: prompts/fix.md
      re_review_prompt: prompts/re-reviewer.md
      fix_model: "{{models.executor}}"
      fix_variant: "{{variants.fix}}"
```

Iteration naming — built by `PhaseRef.format()` and resolved by
`phaseIndexInDefinition` (both in `src/workflows/phase-ref.ts`):

```
reviewer                    ← first review
reviewer_fix_1              ← fix cycle 1
reviewer_recheck_1          ← re-review after fix 1
reviewer_fix_2              ← fix cycle 2
reviewer_recheck_2          ← re-review after fix 2 (max_cycles)
```

`n` is the 1-based cycle; `fix_k` and `recheck_k` pair within a cycle. The
legacy bare-numeric re-review form (`reviewer_2`) is dropped — neither
produced nor recognized on resume.

The runner parses the verdict line — `^\s*VERDICT:\s*(APPROVED|REQUEST_CHANGES)`
— from the reviewer's output via the single pure parser
`parseReviewerVerdict` (`src/workflows/verdict.ts`) and either advances or
enters the next fix cycle.

### `generic_loop` — until-condition cycle

```yaml
- name: socratic
  prompt: prompts/explore-ask.md
  generic_loop:
    max_iterations: 8
    until: "output.contains('READY')"
    gate_kind: "reply"           # pause after each iteration; user reply feeds next
    scratch_key: "socratic"      # accumulate Q&A under workflow_runs.scratch.socratic
    fresh_context: false         # pass {{previousOutput}} to next iteration
    interactive: true
    on_soft_failure:             # optional; absent = hard-fail on any non-success
      retries: 1                 # re-run a soft (empty) iteration up to N times
      then: complete             # then: fail (default) | complete
```

Iteration naming: `${phaseName}_iter_${n}`; a soft-failure retry is
`${phaseName}_iter_${n}_retry` (its own ledger row). The until-condition is
evaluated by `loop-eval.ts` — see below.

**`on_soft_failure`** — by default any non-success iteration hard-fails the
whole run, which is wrong for a long interactive loop (one degenerate turn
would discard all accumulated state). A *soft* outcome is a clean exit that
produced no usable output — `mapStopReason` returns `"unknown"` /
`"error_truncated"` — as opposed to a hard crash (terminated / `error_fatal` /
`error_tool` / `error_exit_*`); the split is the generic `isSoftOutcome(result)`
classifier, shared with the reviewer loop's fallback recovery. When declared,
a soft iteration re-runs up to `retries` times; if still soft, `then: complete`
ends the loop as if `until` matched (advancing downstream with the work so far,
recorded as success so the run's `anyFailed` rollup stays green) while
`then: fail` keeps the hard-fail. Only `explore.yaml`'s socratic phase opts in.

## Approval gates and reply gates

Both are pause points. The difference is who resumes them.

**Approval gate**: phase declares `approval_gate: post_architect`. If
`config.approval["post_architect"] === true` ([Configuration](/spec/02-configuration)),
the runner persists the phase, writes a `pending` row to
`workflow_approvals`, sets `workflow_runs.status = "paused"`, and
returns `{ paused: true }`. Resume comes from a GitHub comment
(`@last-light approve`), a Slack slash command, or the dashboard —
the [Router](/spec/05-router) routes those to `skill: approval-response`,
which calls back into `runSimpleWorkflow()`.

If the gate name is *not* in `APPROVAL_GATES`, the phase proceeds
without pausing. Gates are positive enable only.

**Approving an artifact**: a gate can name the handoff doc it's asking a
human to approve via `approval_artifact: architect-plan.md` (also valid
inside `loop:`). The filename is stored on the `workflow_approvals` row
([State](/spec/10-state)). The gate message can deep-link a **focused
approval view** with `{{approvalUrl}}` — `pauseForApproval` injects the
new `approvalId` into the message context and the helper renders
`${publicUrl}/admin/?approval=<id>` (empty without `PUBLIC_URL`, so the
message still posts; identical for GitHub- and Slack-initiated runs). That
view (`GET /admin/api/approvals/:id`) enriches the approval with an
`artifactRef` derived from the run (`context.owner` + bare `repo` +
`buildAssetIssueKey`): **server** storage mode embeds the artifact editor
(edit + save the store doc, then approve); **repo** mode links out to the
doc on GitHub. Both resolve through the same dashboard approve/reject path.

**Reply gate**: declared as `gate_kind: "reply"` on a `generic_loop`.
The phase pauses, the next free-form maintainer message on the same
issue or Slack thread becomes the next iteration's input. No
`@last-light` mention required — the router's reply-gate short-circuit
(see [Router](/spec/05-router)) feeds it in as a `skill: explore-reply`.
The harness merges the reply into `scratch[scratch_key]` and re-enters
the same phase for iteration `n+1`.

## Template engine — data flow

Full template syntax lives in [Phases & Prompts](/spec/07-phases-and-prompts).
Here, just the data flow:

```
TemplateContext = {
  // run-scoped (built once in simple.ts:248–279)
  owner, repo, issueNumber, prNumber, branch, taskId, issueDir,
  issueTitle, issueBody, issueLabels, commentBody, sender,
  bootstrapLabel, contextSnapshot, models, variants,
  ...request.extra,

  // phase-scoped (merged per phase in runner.ts)
  phaseOutputs,    // { [phaseName | output_var]: string | object }
  fixCycle,        // loop only
  iteration,       // generic_loop only
  previousOutput,  // generic_loop with fresh_context: false
  scratch,         // mutable from workflow_runs.scratch
}
```

Phase A's output reaches Phase B by being stored in `phaseOutputs[A]`
(in memory during a linear run). Phase B's prompt template reads it
with `${A.output}` or `{{A.field}}`. DAG runs scope outputs per-phase
taskId to keep concurrent workspaces clean.

## Scratch state

`workflow_runs.scratch` is the only mutable JSON we keep on a run.
What lives there:

- **Loop accumulators** — `scratch.socratic.iteration`,
  `scratch.socratic.qa`, etc.
- **Pointers to large outputs** — `scratch.<key>.lastOutputExecutionId`
  points at an `executions` row whose `output_text` holds the actual
  text. Inlining 50 KB of LLM output into the scratch JSON every
  iteration would balloon SQLite for no good reason.
- **Free-form workflow state** — reply-gate-merged user responses,
  intermediate flags.

Mutations go through `db.updateWorkflowRunScratch(workflowId, patch)`.

## taskId scoping

```ts
// src/workflows/simple.ts:64–74
function workflowScopedTaskId(repo, number, workflowName, workflowId) {
  const suffix = workflowId.slice(0, 8);
  return number !== undefined
    ? `${repo}-${number}-${workflowName}-${suffix}`
    : `${repo}-${workflowName}-${suffix}`;
}
```

- **Linear** — every phase uses this base. The sandbox workspace
  persists, so files like `.lastlight/issue-42/architect-plan.md`
  survive between phases.
- **DAG** — each phase appends `-${phaseName}`. Concurrent phases
  don't share workspaces.
- **Loop iterations** — reuse the parent phase's taskId. Fix cycles
  read the reviewer's verdict from the same disk.
- **Resume** — stored in `workflow_runs.context.taskId`. A resumed run
  lands in the exact same sandbox directory.

## Idempotency

```ts
// runner.ts:210–225
const dedupKey = `${workflowName}:${phaseName}`;
const status = db.shouldRunPhase(dedupKey, triggerId, workflowRunId);
if (status === "running") {
  // verify the container is still alive; if not, mark stale
}
if (status === "done") {
  return { skipped: true, reason: "done" };
}
```

Completed phases are never re-run on resume. In-flight phases are
checked for liveness — if a sandbox container disappeared while the
process was down, `db.markStaleAsFailed()` flips the row and the runner
re-enters the phase. Worst case: a phase runs twice; the prompts are
written to tolerate that.

## Resume protocol

Two distinct entry points.

**`resumeOrphanedWorkflows()`** (`resume.ts:276–315`) — called at
[Harness](/spec/01-harness) boot. Scans `workflow_runs` for rows with
status `running` (`paused` is left alone — those are awaiting humans).
For each:

1. Increment `restart_count`. If `> 3` (`MAX_RESTART_RESUMES`), mark
   the run `failed` and skip. This is the crash-loop circuit breaker.
2. Mark stale execution rows failed.
3. Call `resumeSimpleRun()` in the background (non-blocking).

**Approval / reply gate resume** — `simple.ts:317–397` handles inbound
approval responses. Fetches the `workflow_approvals` row, updates its
status, flips the run back to `running`, calls `runSimpleWorkflow()`
again. The runner's `nextPhaseAfter(definition, run.currentPhase)`
walks the phase array to the position after the last completed phase
and starts there — completed phases are skipped via
`shouldRunPhase() === "done"`.

For reply gates the runner sets `currentPhase` to the phase *before*
the loop owner so `nextPhaseAfter()` lands back on the looping phase
for the next iteration.

## Loop expression evaluator

```ts
// src/workflows/loop-eval.ts
export function evalUntilExpression(expr: string, ctx: LoopEvalContext): boolean;
```

A custom mini-DSL (not `eval()`). Accepts:

- `output.contains('text')` — substring match on the iteration's output
- `variable == 'value'` / `variable != 'value'` — equality / inequality
- `variable == true` / `== false` — boolean coercion of bare literals
- Dotted keys for nested access: `scratch.socratic.ready == true`

Unrecognised expressions return `false` (safe default — the loop runs
until `max_iterations`).

`until_bash` is the alternative: a shell command whose exit code (0 →
stop) drives the loop. It runs **inside the sandbox** (via `executeCommand`
with `writeSession: false`) against the persisted workspace — not on the
harness host. `{{}}` markers in the command are rejected before execution to
prevent template-after-render injection (`validateShellCommand`).

## Invariants

- **The runner is workflow-agnostic.** It learns about a workflow by
  loading YAML; it has no per-workflow branches. Any change to "what
  happens" is a YAML change, not a code change.
- **Completed phases never re-run.** `shouldRunPhase()` is checked at
  the top of every phase entry; resume relies on it.
- **Idempotency is per-(workflow_run_id, phase_name).** Not per-phase
  globally. Two runs of the same workflow on the same issue are
  independent.
- **`output_var` aliases are unprotected.** Two phases writing to
  overlapping output_vars will clobber each other silently. Convention:
  use distinct, descriptive aliases.
- **DAG concurrency uses phase-scoped taskIds; loops reuse parent.**
  This asymmetry is intentional and load-bearing.
- **Scratch points at outputs; doesn't inline them.** A phase output of
  any size lives in `executions.output_text`. Scratch stores the row id.
- **Approval gates are positive enable.** A gate name not in
  `APPROVAL_GATES` is silently disabled — the phase proceeds. There is
  no enable-all shortcut.
- **The verdict marker is exact.** `^\s*VERDICT:\s*(APPROVED|REQUEST_CHANGES)`
  on the first matching line of reviewer output. Variant phrasing
  ("looks good", "approved!") is not recognised; reviewer prompts are
  written to produce the literal marker.
- **Restart-count is the circuit breaker.** Three failed resumes and
  the run is failed permanently. Resist the urge to raise the limit
  without thinking about what's actually crashing.

## Current implementation

| Piece | File |
|---|---|
| Public entry | `src/workflows/simple.ts` |
| Linear executor | `src/workflows/runner.ts:457–1033` |
| DAG executor | `src/workflows/runner.ts:1092–1486` |
| YAML schema (Zod) | `src/workflows/schema.ts` |
| YAML loader + caching | `src/workflows/loader.ts` |
| DAG graph utilities | `src/workflows/dag.ts` |
| Until-condition evaluator | `src/workflows/loop-eval.ts` |
| Template engine | `src/workflows/templates.ts` |
| Resume + orphan recovery | `src/workflows/resume.ts` |

## Rebuild notes

- **Schema first, executor second.** Defining the YAML schema cleanly
  (in TypeScript, Go, whatever) is what makes the runner's behaviour
  predictable. Don't let optional fields with implicit defaults
  proliferate — every default is a future surprise.
- **Linear is the default; DAG is the special case.** Most workflows
  don't need a graph. Adding `depends_on` to a phase should be a
  deliberate choice that opts in to the concurrency cost.
- **Persist resume state, not in-flight state.** The runner stores
  where it is (current phase, scratch, restart count) — not the
  conversation buffer or the sandbox process. Those are reconstructed
  from disk + DB on resume.
- **A single state store, not two.** Both SQLite (resume substrate)
  and the JSONL event logs (event stream) are needed — see
  [State](/spec/10-state) — but the runner only talks to the resume
  store. Mixing them creates ordering bugs.
- **Approval gates as data, not code.** Whether a gate fires depends
  on configuration, not on whether the phase exists. A re-implementation
  that hard-codes which gates are enabled is denying operators a knob
  they need.
- **Restart-count circuit breaker is non-optional.** Crash loops are a
  certainty; if the runner re-enters an OOMing phase forever, it will
  eventually deplete the database with stale executions and consume
  every cent of the LLM bill. Pick a number, default to it, surface
  the count in the dashboard.
- **The verdict marker is an interface.** It's the contract between
  prompts and code — both sides know exactly what to produce and look
  for. Other parse markers (`READY`, `BLOCKED`) follow the same
  pattern. Make them exact.
