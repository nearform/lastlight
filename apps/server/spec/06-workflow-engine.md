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
state to the [state database](/spec/10-state), and handles every gate and loop
the YAML can declare.

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
  concurrency?: { maxWorkflows: number; maxQueueWaitMs: number },
): Promise<WorkflowResult>;

interface WorkflowResult {
  success: boolean;
  phases: PhaseResult[];
  paused?: boolean;     // hit an approval or reply gate
  queued?: boolean;     // held back by the concurrency cap (no phases ran)
  prNumber?: number;    // build cycle that produced a PR
}
```

The engine's own `WorkflowResult` (above) is unchanged. `runWorkflow`
(`src/workflows/runner.ts`) returns a server-only intersection,
`WorkflowResult & { backpressure?: boolean }` — see [Concurrency cap and
admission](#concurrency-cap-and-admission) below. `backpressure` is set
only on the [k8s sandbox backend](/spec/09-sandbox#kubernetes--kubernetes-backend-in-development);
it never appears on gondolin/docker/smol/none runs.

`src/workflows/simple.ts:84–310` is the entry point everything funnels
through — webhook dispatch, CLI, cron, admin resume.

## YAML schema

**Workflow level** (`packages/workflow-engine/src/core/schema.ts:476–617`, re-exported
as `src/workflows/schema.ts`):

```ts
{
  kind: string;          // "agent" by default; "build" / "triage" / etc. for categorisation
  name: string;          // unique workflow name; lookup key
  description?: string;
  trigger?: string;      // informational
  pr_scoped?: boolean;   // this workflow runs against a PULL REQUEST — see below
  variables?: Record<string, string>;
  classification?: {     // how the intent classifier routes to this workflow (issue #164)
    intent: string;      //   the intent token this workflow owns (unique; not a control intent)
    description: string; //   the category paragraph merged into the composed classifier prompt
    examples?: string[]; //   optional one-line classifier examples
  };
  chat?: {               // how the CHAT agent advertises this workflow to a human
    trigger?: string;    //   the phrase to tell a user to type, e.g. "triage owner/repo"
    summary: string;     //   one line naming what they get
    deflect?: string[];  //   user phrasings to deflect here rather than attempt in-process
    reply?: string;      //   override for the deflection reply (default: name the trigger)
  };
  phases: PhaseDefinition[];
}
```

`pr_scoped: true` is the one key here the runner acts on. It puts a workflow
inside the PR-scoped dispatch gate: the run lock shared with every other
PR-scoped workflow, the per-head-SHA dedup, escalation, and the resolved
`PrState` snapshot on `context.prState`. `prScopedWorkflows()`
(`src/workflows/pr-scope.ts`) derives the set from this metadata, memoised on the
loader's asset version, so a forked or renamed workflow keeps its gate by
carrying its own key. It is metadata on the workflow because that is where the
fact lives: the harness previously held a hardcoded set of four names while the
handlers are operator-configurable through `routes.github.*`, so remapping a
route to a fork silently dropped the whole gate for it — and every consequence of
the gate is a *refusal*, so nothing looked wrong until two agents pushed the same
branch (issue #256). `validateAssets` now warns at boot when a configured
`routes.github.pr_*` target does not declare it. The four packaged members are
`pr-fix`, `dependabot-ci-fix`, `dependabot-pr-merge` and `pr-review`; those four
names are also honoured without the key, for overlays that forked them before it
existed, with a warning naming the file. See
[05-router.md → the PR-scoped dispatch gate](05-router.md#the-pr-scoped-dispatch-gate).

The optional `classification` block makes a workflow **self-describing to the
router**: its `description`/`examples` are composed into the classifier prompt
(`workflows/prompts/classifier.md`), and its `intent` becomes routable via the
router's `getWorkflowByIntent` fallback — so adding a workflow (even in an
overlay) can add a new intent with no core change. See
[05-router.md → Build-intent classifier](05-router.md#build-intent-classifier).

The optional `chat` block is its counterpart for the **chat agent**: it is what
the bot tells a human to type, composed into the chat system prompt from the
enabled workflow set. It is a separate, explicit opt-in rather than a derivation
from `classification`, because "the classifier can tag a message with this
intent" and "a human should be told to type this" are different questions that
diverge in both directions (`demo` is classifiable but unroutable from Slack;
the two dependabot workflows are routable but would arrive with no PR number).
An entry may omit `trigger` and give `reply` instead, for a workflow that must be
explained but never typed — `repo-health` is cron-only and has no
`classification` block at all. See
[11-chat.md → Advertised capabilities](11-chat.md#advertised-capabilities).

The same block feeds the **Slack rows of the dashboard trigger table**
(`getWorkflowTriggers`, `src/workflows/triggers.ts`), resolved through
`routes.slack` so an operator's remap lands on the fork. Those rows gate on the
`classification.intent` (what the Slack switch dispatches on) rather than the
trigger phrase, so a `chat:` entry without an intent contributes an explanation
to the agent and no trigger row. They were a hand-kept list of five while the
router routed nine, which is why the dashboard showed no Slack trigger for
`verify` / `qa-test` / `demo` / `answer`.

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
  timeout_seconds?: number | { from: string; default: number };  // bash/script step timeout + until_bash budget (default 300 / 30)
  skill?: string;                       // single skill name; sugar for `skills: [<name>]`
  skills?: string[];                    // per-phase bundle: <workspaceRoot>/.lastlight-skills/<phase>/<name>/
                                        // may coexist with `prompt`; mutually exclusive with `skill`
  model?: string;                       // can be "{{models.architect}}"
  variant?: string;                     // reasoning effort; can be "{{variants.fix}}"
  approval_gate?: string;               // pause gate name
  approval_artifact?: string;           // handoff doc this gate approves (e.g. architect-plan.md)
  approval_gate_message?: string;       // template rendered when pausing ({{approvalUrl}} deep-links the focused view)
  depends_on?: string[];                // declaring this ANYWHERE disables chain synthesis for the WHOLE workflow
  trigger_rule?:
    | "all_success" | "one_success"     // DAG firing conditions
    | "none_failed_min_one_success"
    | "all_done";
  branches?: FanoutBranch[];            // type: fanout only — required there, rejected elsewhere
  max_concurrent?: number | { from: string; default: number };  // fanout width, clamped by the backend ceiling
  on_branch_soft_failure?: { retries: number; then: "fail" | "complete" };  // per-BRANCH; not generic_loop's key
  output_var?: string;                  // alias for {{this.field}} in later phases
  unrestricted_egress?: boolean;        // bypass strict allowlist for this phase
  web_search?: boolean;                 // enable agentic-pi web tools
  requires_sandbox?: "docker" | "gondolin" | "none";  // skip phase (non-failing) if active backend differs
  sandbox_image?: "default" | "qa";     // docker only: "qa" runs on lastlight-sandbox-qa (Playwright+Chromium+ffmpeg); skips if unbuilt
  skip_if?: string | string[];          // skip phase (non-failing) when any expression matches the render context
  loop?: PhaseLoop;                     // reviewer-fix loop
  generic_loop?: GenericLoop;           // until-condition loop
  on_output?: OutputRule[];             // contains_BLOCKED → fail; requires_marker → fail if final output lacks this marker (postcondition against silent no-op "successes")
  on_success?: { set_phase: string };   // terminal marker
  messages?: PhaseMessages;             // per-event reply templates
}
```

**Cron level** (`kind: cron`, same file). A cron definition is not runnable
itself — it is a schedule plus what to run:

```ts
{
  kind: "cron";
  name: string;          // unique cron name; the dashboard/CLI handle
  schedule: string;      // croner expression
  workflow?: string;     // dispatch this AgentWorkflow on each tick
  handler?: string;      // OR run this host-side handler (src/cron/handlers.ts)
  context?: Record<string, unknown>;   // static context merged into each tick
  condition?: { unless: string };      // named predicate; true ⇒ do not register
}
```

`workflow` and `handler` are **mutually exclusive and one is required** — a Zod
refinement, because both would silently pick one and neither would register a
cron that ticks into the void. `handler:` exists for periodic work that cannot
be done by an agent at all (harness-only data, or a Slack post); the trade-offs
and the failure rule are in
[Integrations → Cron](/spec/03-integrations).

Defined with Zod; loaded and cached by `loader.ts`.

## Phase types

Six: `context` (no execution), `agent` (one LLM session), `fanout`
(N LLM sessions, concurrently, in one workspace), the deterministic
`bash` / `script` pair (a command, no LLM), and `post-review`
(in-process PR-review submission, no sandbox).

The engine owns only the generic kinds. `post-review` and any other
app-specific type are dispatched through a `Map<string,
PhaseTypeHandler>` injected on `EnginePorts.handlers`
(`phase-executor.ts`, registered in `runner.ts`) — which is the seam to
extend when a deployment needs a step the engine should not know about.

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
  changed line via `src/engine/github/review-poster.ts` — **deriving** the line
  from the finding's verbatim `existingCode` excerpt rather than trusting the
  number the model counted (own hunks → whole head file → a *unique* match
  elsewhere in the diff, which re-files a finding filed against the wrong half
  of a declaration/implementation pair) — demotes off-diff
  findings to the body, and posts one review through `GitHubClient` (App auth in
  prod; a bearer token + `config.githubApiBaseUrl` against the eval mock, which
  serves no App-token or diff endpoint). A genuine failure — missing findings
  after a real review, or a GitHub error surviving the body-only retry — **fails
  the phase**; a legitimate `skip` succeeds without posting. Idempotent on
  resume (no-op when a bot review already exists on the head SHA). This replaced
  the earlier in-sandbox `type: script` poster, which depended on the AI
  hand-writing `pr_number`/`base_ref`/`head_sha` into the JSON and silently
  `exit 0`'d on any mismatch.

  The document may also carry an optional **split verdict** (issue #271's fix
  7) — `verdict: { spec, standards }`, each `pass` / `fail` / `unknown`. A
  `fail` on **either** axis stops the review being an `APPROVE`; it becomes a
  `COMMENT`. Nothing else changes: the event is never escalated to
  `REQUEST_CHANGES` on a heuristic (that would flip the `last-light/review`
  check to `failure` and shut a merge gate), and among the non-`APPROVE` events
  an explicit `event` still wins. `unknown` means *not assessed* and does not
  block — most PRs state no acceptance criteria, and blocking on `unknown` would
  stop the reviewer approving anything. The point is that a change clean by
  every standards check but not doing what the issue asked is a case one `event`
  cannot express, and 58 of 59 production approvals carried zero findings. An
  absent `verdict` is today's behaviour exactly, and the handler **discards**
  the field entirely unless `review.analysis.enabled` — so the inertness is
  structural rather than a promise about what a prompt writes.

### `fanout` — N agent sessions, one workspace

```yaml
- name: survey
  type: fanout
  depends_on: [seed]
  trigger_rule: all_done
  skills: [pr-review, code-review]
  model: "{{models.review-survey}}"
  max_concurrent: { from: surveyConcurrency, default: 6 }
  on_branch_soft_failure: { retries: 1, then: complete }
  branches:
    - name: contract
      prompt: prompts/survey-contract.md
      context_file: .lastlight/pr-review/obligations/contract.md
      until_bash: lastlight-facts discharge --dir .lastlight/pr-review --family contract
    - name: security
      prompt: prompts/survey-security.md
      skills: [pr-review, code-review, security-review]
```

Each branch inherits the phase's `prompt` / `skills` / `model` /
`variant` and may override any of them. Branch names are **ledger
keys**, so they are alphanumeric-with-hyphens (no underscores, which
`PhaseRef` uses as its separator), must be unique, and may not end in
the reserved `-retry` / `-check` suffixes.

(The `model:` line above is why `pr-review.yaml`'s downstream `adjudicate`
phase carries its own key the guarded way —
`model: "{{#if models.review-adjudicate}}{{models.review-adjudicate}}{{/if}}{{#if !models.review-adjudicate}}{{models.review}}{{/if}}"`.
The `{{#if}}` pair is load-bearing: a bare unset key renders *empty*, and an
empty `model:` resolves to the **default** model — not to `models.review`,
which is the fallback the phase actually wants.)

**`context_file` — a path in a prompt is not a path.** A branch may name a
workspace file, relative to the AGENT'S OWN CWD, whose contents the harness
reads and appends to that branch's rendered prompt. The model never resolves
it. This exists because it was measured: across three stored `pr-review` runs
on 2026-08-22, 27 of 133 attempts to open the per-family obligations block
resolved against the workspace ROOT rather than the checkout and hit ENOENT
(23 of 120 branches never recovered), while all 98 relative reads succeeded.
The model's only absolute anchor by its first turn is its skill bundle at
`<workspaceRoot>/.lastlight-skills/…`, one level above the checkout the
deterministic phases write in — so a seeded pass silently became an unseeded
one. The harness resolves the path against `ProvisionResult.hostAgentCwd`, the
host end of the very `cwd` a `type: bash` phase runs in, so producer and
consumer share one base by construction. It is appended **last**, which is the
prompt-cache ordering the fan-out already depends on. An unreadable or escaping
path (absolute, or containing `..`) appends a **loud NOT AVAILABLE notice**
naming it, never silence: "nobody looked" must never render as "looked, found
none". The one carve-out is **`kubernetes`**, whose `hostAgentCwd` is an in-pod
path this process cannot see at all — there the read is not attempted and the
branch is handed the path to open itself, with the mis-anchoring trap named.

**Why one node instead of N parallel phases.** Real DAG concurrency is
parked behind four hard blockers, and
[the WP5 parking rationale](../../../docs/plans/deterministic-pr-levers.md#parked-parallel-phases-wp5)
records why it can be sidestepped: *"every hard blocker exists because
each phase provisions its own sandbox against a shared workspace."* A
fan-out inside one phase has none of them — one node, one provision,
one `current_phase`, one artifact harvest, one dispose.

**Execution order**, and each step is load-bearing:

1. One `withAgentSession` — a single `prepareRun`, so one GitHub token
   mint and one workspace provision for the whole fan-out.
2. Skill bundles staged **per branch, sequentially, before the join**.
   The bundle is already keyed per phase so concurrent readers cannot
   collide; staging is filesystem work and is serialised rather than
   reasoned about.
3. Branches run through a bounded `mapPool`.
4. **`until_bash` gates run after the join, sequentially.**
   `InProcessSandbox.runCommand` is a `spawnSync` — it blocks the event
   loop — so interleaving a gate with the agent turns would serialise
   the entire fan-out on `none`, the very backend the fan-out exists to
   speed up. Each gate records a `<phase>_branch_<name>_check` ledger
   row with `condition_met` / `condition_not_met`; it is observational
   and can never fail the phase.
5. One harvest, one dispose.

**Concurrency is `min(max_concurrent, backend ceiling)`**, and the
clamp is logged when the host has the last word:

| backend | ceiling | why |
|---|---:|---|
| `none`, `docker` | 6 | in-process `run()`, or N `docker exec` into the one provisioned container |
| `gondolin`, `smol`, `kubernetes` | **1** | a QEMU micro-VM (or equivalent) per branch, in the harness process |

A ceiling of 1 runs the branches as a chain — byte-identical in
behaviour to declaring them as sequential phases, which is what makes
the type safe to ship with `gondolin` as the production default.

**What it keeps, and what it gives up.** Each branch goes through the
same dedup ledger under its own `<phase>_branch_<name>` key, so resume,
dedup, per-branch cost attribution and the dashboard's longest-prefix
grouping all still work, and a branch opens and closes its own reporter
window so per-branch duration is measurable. What it gives up is a DAG
node per branch: no per-branch `trigger_rule`, and no `approval_gate`
(a fan-out cannot pause mid-flight — the schema refuses it, along with
`loop:` / `generic_loop:`, whose iteration shape the branches already
are).

**Isolation between branches is by disjoint output paths**, not by
separate checkouts — they share the one workspace. A fan-out whose
branches write the same file is a data race the engine will not catch.

The `bash`/`script` deterministic types share the agent phase's dedup ledger
(`runCommandPhase` → `runPhaseLedger`), so they get an `executions` row and
dedup on resume like everything else. They also inherit the run's minted
`GITHUB_TOKEN` (scoped by the workflow's permission profile). When the harness
configures a GitHub API base-url override (`config.githubApiBaseUrl`, set only
by the eval harness to point at its mock), `runSandboxedCommand` forwards it into
the command env as `GITHUB_API_URL`, and `post-review` reads it directly to
build its `GitHubClient`; in production both are unset, so GitHub calls fall
back to `api.github.com`.

## Scheduling — one DAG, one node at a time

Chain synthesis is automatic:

```ts
// src/workflows/runner.ts:330
function hasDependencies(definition): boolean {
  return definition.phases.some(p => p.depends_on?.length);
}
```

**Every workflow is a DAG, and there is exactly one scheduler**
(`core/scheduler.ts`). `buildDag(phases, { chainIfNoDeps: true })`
produces the node graph: a workflow that declares no `depends_on`
anywhere gets a synthesized previous-phase chain, reproducing linear
semantics including the failure cascade. Declaring `depends_on` on
*any* phase disables that synthesis for the **whole** workflow, so a
file that declares one edge must declare them all.

`getReadyNodes()` returns every node whose dependencies are satisfied
per `trigger_rule` — but the scheduler runs **one at a time, in
declaration order**:

```ts
// Sequential: run the earliest-declared ready node, one at a time.
const node = ready[0];
```

- **One workspace per run.** Every phase and every loop iteration
  shares the single `ctx.taskId`; the sandbox workspace persists
  between phases, which is how the executor reads the architect's
  `architect-plan.md`.
- **Loop iterations run sequentially** within their node — each fix
  cycle reads the previous reviewer verdict.

There is **no cross-phase concurrency**. Two prior claims in this
document — that concurrent phases run via `Promise.allSettled()` and
that each takes a phase-scoped `${taskId}-${phaseName}` — described
code removed by issue #94, which deliberately collapsed two forked
schedulers into one and deferred real concurrency ("via git worktrees")
to a later issue. That issue is still open and parked behind four hard
blockers, of which the worst silently overwrites a `paused` run with
`succeeded`: see
[the WP5 parking rationale in `docs/plans/deterministic-pr-levers.md`](../../../docs/plans/deterministic-pr-levers.md#parked-parallel-phases-wp5).

**Concurrency exists in exactly one place, and it is inside a node:**
`type: fanout` (below).

## Gated skips

Before running the ready nodes, the scheduler filters them
(`core/scheduler.ts`). Three declarations can take a node out:

| Field | Gates on | Example |
|---|---|---|
| `requires_sandbox` | The named backend isn't the one running | the browser-QA step that only works on docker |
| `sandbox_image: qa` | The heavier QA image isn't built on this host (docker only; inert elsewhere) | same |
| `skip_if` | An expression matches the run's render context | the `fix` phase after a diagnosis that says there is nothing to fix |

The first two gate on the phase being **unavailable**; `skip_if` gates on
it being **unnecessary**. All three take the *same* path: the node records
`skipped`, a `recordSkippedPhase` row lands, `messages.on_skipped_done` is
surfaced so a human sees why, and **the run still records `succeeded`**.

That last part is the whole reason `skip_if` exists rather than being
expressed with the pre-existing `on_output.contains_BLOCKED: { action:
fail }`. A phase whose *correct* outcome is "there is nothing for the next
phase to do" must not paint the run red, because `failed` has four
mechanical consequences: `messages.on_failure` posts to the PR (actively
wrong — "leaving it for a human" on a flaky test), the dashboard's **Retry**
button targets `failed`/`cancelled` and so offers a retry that cannot
succeed, the cost and failure stats are polluted, and
`latestSucceededForTrigger` ignores failed runs, which defeats the
already-handled-this-SHA dedup so the same dead end is re-diagnosed on
every webhook re-fire. Recording the skip `succeeded` fixes all four, and
turns the fourth into a positive: the dedup starts working for exactly the
cases that must not be re-attempted.

```yaml
- name: fix
  skip_if:                                          # one string, or a list (OR-ed)
    - "scratch.fixMarkers.diagnosis.class == 'flaky'"
    - "scratch.fixMarkers.diagnosis.class == 'infra-dependent'"
    - "scratch.fixMarkers.diagnosis.class == 'upstream-broken'"
```

`dependabot-ci-fix` carries a second, simpler list on the phase *above*,
reading a plain context value rather than a parsed marker:

```yaml
- name: diagnose
  skip_if:
    - "reason == 'dirty'"
    - "reason == 'behind'"
    - "reason == 'blocked'"
```

There is nothing to diagnose when no check is failing — the PR is
merge-BLOCKED, and the repair (merge the base in, regenerate the conflicted
lockfile) is mechanical. Diagnosing anyway was worse than wasteful: the
phase's taxonomy is CI-failure-shaped, so an agent shown green checks and no
failing job honestly answered `infra-dependent`, which is one of the three
stopping rows above — the fix phase was skipped and the conflict left in
place, on a `succeeded` run. A bare OR-ed list is sufficient despite the
grammar having no negation, because `reason` carries CI's verdict **first**
(`conclusion === "failing" ? "checks-failing" : mergeableState` in
`src/cron/dependabot-discovery.ts`), so these three values imply CI is not
settled-failing; a PR that is both red *and* behind arrives as
`checks-failing` and is still diagnosed. The `fix` rows then read a
`scratch` path that is absent, and an absent variable **fails open**, so the
fix phase runs.

Expressions use the `until:` grammar (see *Loop expression evaluator*
below), evaluated against `{ ...ctx, phaseOutputs, scratch }` — the same
values a prompt template can render. `output` is empty here (the phase has
not run), so a bare `output.contains(...)` is meaningless; read an upstream
phase instead. AND is expressible by collapsing to a single expression; the
production consumer is a class list, which is why one expression per class
reads better than one compound one.

**Read a PARSED value out of `scratch`, not prose out of `phaseOutputs`.**
The production rows above used to be
`phaseOutputs.diagnosis.contains('class=flaky')`, and every way that can go
wrong, it did: `phaseOutputs.diagnosis` is the agent's *entire* output and
the match is a plain substring, so an agent writing "this is not
`class=flaky`, it is reproducible" skipped the phase; a `{{priorAttempts}}`
line replayed from an earlier attempt matched too; `class=flaky-timeout`
matched while `class=probably-flaky` did not; and `phaseOutputs` is **empty
across a resume boundary**, so the guard failed open and ran a full sandbox
on exactly the verdicts it exists to stop. `scratch` is reloaded from the run
row each iteration, and the marker harvest has already parsed and validated
the class — so the guard reads the same value the decision layer does.

There is no negation, and a *conditional* row — "skip on `class=flaky`,
unless this PR has already deferred twice" — is therefore not expressible
at all. The `flaky` cap needs exactly that, and resolves it without an
operator: its second term is a fact about the PR's history known *before*
the run starts, so the harness composes the run's guard list from it —
`promoteFlakyDiagnosis` (`src/workflows/simple.ts`) drops the `flaky`
expression once `flakyDeferrals >= fix.maxFlakyDeferrals`, on a shallow
copy of the loader's cached definition. The other two rows are
unconditional. This is the general shape for any guard whose second term
is run-level rather than phase-level: compose the list, don't grow the
grammar.

Two scoping rules:

- **Evaluated when the node becomes *ready***, i.e. after its dependencies
  are terminal — which is what makes reading an upstream phase's output
  well-defined.
- **`phaseOutputs` is empty across a resume boundary** (a phase skipped as
  already-`done` contributes nothing to the in-memory map), so a guard that
  must survive resume should read `scratch`, which the run store rehydrates.

Every expression fails **open**: an unrecognised form and an absent variable
both evaluate false, so a malformed or not-yet-populated guard *runs* the
phase rather than silently swallowing it.

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
    max_iterations: 8            # or { from: <ctx path>, default: N } — see below
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
`${phaseName}_iter_${n}_retry` (its own ledger row) and the `until_bash` exit
check is `${phaseName}_iter_${n}_check` (its own ledger row too — see "Recording
a loop iteration" below). The until-condition is evaluated by `loop-eval.ts` —
see below.

**Recording a loop iteration.** The iteration is persisted the moment its *work*
finishes — `phase_history` entry (`iteration N — work complete`) plus the
iteration's `output_text` — **before** the exit condition is evaluated.
Everything after the agent turn belongs to the loop, not the iteration.
`until_bash` then opens its own `executions` row (`recordStart` → command →
`recordFinish` + `recordOutputText`), because it is a real sandbox command that
can run for minutes and an *open* row with a start time is how every renderer
draws "in flight, since N". The row deliberately bypasses
`runPhaseLedger`/`shouldRunPhase` — a condition must be re-evaluated on every
ask, never replayed from a dedup hit — and its `success` records whether the
check **ran**, with the verdict in `stop_reason` as `condition_met` /
`condition_not_met`. A red gate is the loop working as designed (it is what
earns the agent another iteration), so it must not read as a failure: the
dashboard gives `condition_not_met` a muted `unmet` tone and the CLI a `↻`.
When the condition is met a second entry (`iteration N — condition met`) is
appended for the same label; readers fold a repeated label last-wins.

Without this, prod run `49c101aa` spent 6m48s of a 20m31s run inside
`until_bash` with nothing recording it, while the run advertised
`currentPhase: "diagnose"` — a phase that had ended 12 minutes earlier — and
omitted the completed `fix_iter_1` from `phase_history` entirely.

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
  iteration would balloon the state database for no good reason.
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

- **Every phase uses this base, unmodified.** The sandbox workspace
  persists across the whole run, so files like
  `.lastlight/issue-42/architect-plan.md` survive between phases.
  Nothing appends a phase name: the per-phase
  `${taskId}-${phaseName}` clones went with issue #94's scheduler
  unification, and re-introducing them would break every handoff that
  reads an earlier phase's output off disk.
- **Loop iterations** — reuse the parent phase's taskId. Fix cycles
  read the reviewer's verdict from the same disk.
- **Fan-out branches** — likewise. Every branch of a `type: fanout`
  phase runs against the one provisioned workspace; isolation between
  them is by *disjoint output paths* and a per-branch skill bundle, not
  by separate checkouts.
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

## Concurrency cap and admission

A global cap bounds how many sandboxed runs execute at once, so a burst of
triggers can't swamp the host. It is enforced at the single dispatch funnel
(`runSimpleWorkflow`) and defaults to `concurrency.maxWorkflows` = 4
(env `MAX_CONCURRENT_WORKFLOWS`; see [Configuration](/spec/02-configuration)).

**Enqueue.** When a *fresh* trigger arrives and
`countRunning() >= maxWorkflows`, the run row is created with status
`queued` instead of `running`, `runSimpleWorkflow` posts an enqueue ack
("…is queued — it'll start automatically when a slot frees"), and returns
`{ success: true, queued: true, phases: [] }` — **no phases run**. A
duplicate trigger on an already-`queued` run is a no-op (returns the same
`queued` result; it must not fall through to `runWorkflow`, which would
execute outside the cap). Resumes and orphan restarts **bypass** the cap:
they re-enter `runWorkflow` directly, finishing in-flight work rather than
re-queuing behind it.

**The enqueue ack is transient.** It is a promise about the future, so it
must not outlive the run's stay in the queue. `RunnerCallbacks.postComment`
resolves to the created GitHub comment id (`void` on Slack, or when the post
failed), and `simple.ts` stashes it at `scratch.queuedAck.commentId`.
Whichever way the run then leaves the queue, the admission controller
resolves that comment — see below. Without this the ack is the *only*
visible trace of a run that starts and then legitimately no-ops (e.g. a
re-triage of an already-triaged issue), which reads as "it queued and never
came back".

**Admission.** `createAdmissionController` (`src/workflows/admission.ts`)
promotes queued runs to running as slots free, reusing `resumeSimpleRun`
(a queued run's stored `context` is shaped exactly like a resume's, and no
phase has run yet, so the ledger runs them all). Promotion is FIFO by
`started_at` and guarded by a compare-and-set (`admitRun`:
`WHERE status = 'queued'`), so its two triggers race safely:

1. **Event-driven** — `admitNext()` runs in `dispatchWorkflow`'s `finally`
   block, so a just-finished run immediately pulls the next queued one in.
2. **Periodic sweep** — a `setInterval(sweep, 15s)` also **TTL-expires**
   queued runs older than `concurrency.maxQueueWaitMs` (default 1 hr;
   env `MAX_QUEUE_WAIT_MS`) — transitioning them to `cancelled` with a
   "dropped from queue after waiting too long" reason in `context.error` —
   before admitting. The sweeper starts after boot's orphan recovery, so a
   run that was `queued` when the harness crashed is picked up on the first
   tick.

Both exits resolve the enqueue ack, so it never lingers as a stale promise:

- **Admitted** → `retractQueuedAck` **deletes** the ack comment. It has been
  honoured, and whatever the run itself posts is now the real answer.
- **TTL-expired** → `postExpiryAck` **rewrites the ack in place** to the drop
  notice. Editing adds nothing to the thread and GitHub does not notify
  watchers on edits, so this does not reintroduce the comment flood that made
  expiry silent on GitHub in the first place. A **Slack**-originated run
  instead gets a normal thread reply (a human explicitly asked for the work);
  a GitHub run that left no ack stays silent, its drop visible only in the
  dashboard and `lastlight workflow list`.

The `queued?: boolean` on `WorkflowResult` propagates up through
`dispatchWorkflow` and the [dispatcher](/spec/06-workflow-engine): queued
runs suppress the spurious "completed" reply, leave an in-progress PR check
untouched (the terminal review comment lands once admission runs the
workflow), and are cancellable like any live run. The dashboard shows a
`queued` run with a neutral status badge and includes it in the `active`
filter alongside `running`/`paused`.

**k8s backpressure requeue.** The [Kubernetes sandbox
backend](/spec/09-sandbox#kubernetes--kubernetes-backend-in-development)
has no tuned concurrency cap of its own — the cluster namespace's
`ResourceQuota` is the authority, so the harness admits freely (gated only
by a sanity-fuse `K8S_SANITY_FUSE = 1000`, not `maxWorkflows`) and finds
out capacity is exhausted only when a phase's Pod create is rejected.
`runWorkflow` surfaces that as `backpressure: true` on its result (a
server-layer intersection on `WorkflowResult` — the engine type itself is
unchanged). `simple.ts` reacts by calling `db.runs.requeueRunning()`,
transitioning the run **`running → queued`** instead of `failed` — a
third transition alongside the fresh-trigger `→ queued` enqueue and the
approval-gate `→ paused` pause. The `AdmissionController` then promotes it
again like any other queued run, in a **backpressure mode**
(`backpressureMode: config.sandbox === "kubernetes"`) that gates on
`K8S_SANITY_FUSE` and promotes one queued run per `admitNext()` call
instead of filling up to `maxWorkflows` — each promotion doubles as a
quota probe. See [Sandbox → Concurrency](/spec/09-sandbox#concurrency)
for the k8s-side half of this mechanism (the `QuotaExceededError` →
`stopReason: "error_quota"` mapping).

## Loop expression evaluator

```ts
// src/workflows/loop-eval.ts
export function evalUntilExpression(expr: string, ctx: LoopEvalContext): boolean;
export function evalSkipIf(exprs: readonly string[], ctx: LoopEvalContext): string | undefined;
```

A custom mini-DSL (not `eval()`). Accepts:

- `output.contains('text')` — substring match on the iteration's output
- `a.b.c.contains('text')` — the same against any dotted path in the
  context (`output` is the degenerate one-segment case). Strings and
  numbers only: stringifying an object yields `"[object Object]"`, which
  is a substring match waiting to surprise someone
- `variable == 'value'` / `variable != 'value'` — equality / inequality
- `variable == true` / `== false` — boolean coercion of bare literals
- Dotted keys for nested access: `scratch.socratic.ready == true`

Unrecognised expressions return `false` (safe default — the loop runs
until `max_iterations`; a `skip_if` guard runs its phase).

One grammar, two consumers. `evalUntilExpression` drives a
`generic_loop`'s `until:`; `evalSkipIf` OR-s a phase's `skip_if` list and
returns the **first matching expression**, so the scheduler can name it in
the skip reason. The longer dotted path exists for `skip_if`, which needs
to read a *sibling* value (`scratch.fixMarkers.diagnosis.class == '…'`)
that the loop never did.

`runScope.scratch` is refreshed from the run row on each iteration, inside
the `getRun` the cancel check already makes — so a guard reading `scratch`
sees what a phase harvest wrote through `onPhaseEnd`, not the value the
scope was constructed with. Without that refresh a `scratch` guard is a
silent no-op on the fresh path: it reads state that predates the phase it is
guarding on.

`until_bash` is the alternative: a shell command whose exit code (0 →
stop) drives the loop. It runs **inside the sandbox** (via `executeCommand`
with `writeSession: false`) against the persisted workspace — not on the
harness host. `{{}}` markers in the command are rejected before execution to
prevent template-after-render injection (`validateShellCommand`), so the
command is necessarily a **literal** string — it cannot be varied per backend.

Its budget is `phase.timeout_seconds ?? 30`. **Thirty seconds is a trap**: it
kills any real build/test suite mid-run and reports a false red, so a phase
whose gate is the repo's own CI commands must carry an explicit value. Both fix
workflows read theirs from `fix.gateTimeoutSeconds` — see "Templated phase
budgets" below.

The two are not exclusive, and the order between them is load-bearing: `until`
is evaluated **first**, and a match short-circuits `until_bash` entirely
(`phase-executor.ts`: `if (!conditionMet && loop.until_bash)`). A loop can
therefore declare both — a cheap expression that names the cases where there is
nothing left to check, and the expensive command for everything else.

**The fix family's push short-circuit.** Both `pr-fix` and `dependabot-ci-fix`
use exactly that pairing:

```yaml
generic_loop:
  max_iterations: { from: fix.localIterations, default: 2 }
  until: "output.contains('outcome=pushed tried=')"
  until_bash: "if [ -f .git/lastlight-verify.sh ]; then bash …; else … exit 1; fi"
```

`outcome=pushed` in a `CI_FIX_COMPLETE` marker means the commit is already on
the branch — put there by `github_publish`, not by a `git push` the agent ran
(see [Sandbox](/spec/09-sandbox) → "Invariant: the published commit is built by
GitHub, not by git"); for this gate the two are the same fact, and the marker
name is unchanged because the harness parses it.

GitHub's checks started against that commit the moment it landed and are the
strictly better authority — the real CI environment rather than a sandbox
approximation of it, warm rather than a cold container, and covering the matrix
legs the sandbox cannot reproduce. Re-running the local gate at that point
cannot change anything: its exit code decides only whether to spend **another**
agent iteration, and a pushed fix has nothing left to iterate on. Without the
short-circuit a real run (`49c101aa`) pushed at 11:03:31, saw GitHub go fully
green at 11:06:25, and still sat in a fresh container from 11:04:00 to 11:10:48
running the same suite a third time.

It fires on `pushed` **only**. `no-change` / `gave-up` pushed nothing, so there
is no new commit, no new check run and no external authority — the local gate is
the only evidence that exists, and its red verdict is precisely what earns the
agent the next iteration. Short-circuiting all three outcomes would end every
loop at iteration 1 and make `fix.localIterations` dead config.

The needle carries `tried=` because `outcome=pushed` alone also appears in a
rendered `{{priorAttempts}}` journal line from an earlier attempt
(`renderAttemptLine` emits `… | outcome=pushed gate=green`), which the prompt
replays into the run — the same replayed-line false match that forced the fix
phase's `skip_if` rows off `phaseOutputs`. `scratch` is not an option inside a
loop (it is refreshed per *phase node*, not per iteration, so it is stale
there), but `renderAttemptLine` deliberately never renders `tried=`, so
`outcome=pushed tried=` matches a live marker and nothing else. A marker that
reorders its fields simply fails to match and the gate runs as before — the
fallback is the previous behaviour, which is the right direction for a
cost optimisation to fail in.

What this gives up is stated plainly rather than left implicit: after a push the
harness no longer has an independent check on the agent's self-reported
`gate=green`. That is *not* a reintroduction of the `sh`-versus-`bash` defect
(see [Sandbox](/spec/09-sandbox) → the push gate), because the gate in this flow
runs **after** the push and therefore never gated it — the agent's self-report
was already the only thing between a bad fix and the branch. What catches a bad
fix is unchanged: GitHub's checks go red, `pr.checks_failed` re-dispatches the
fix family, and `fix.maxAttempts` / `fix.maxCostUsd` bound the retries. Naming
`bash` still matters for the unpushed path, which is where the loop's iterations
live.

### Templated phase budgets

`timeout_seconds` and `generic_loop.max_iterations` accept either a plain
positive integer or a reference into the run's template context:

```yaml
timeout_seconds: { from: fix.gateTimeoutSeconds, default: 900 }
generic_loop:
  max_iterations: { from: fix.localIterations, default: 2 }
```

`from` is the same dotted lookup `{{a.b}}` performs (`lookupContextKey`), so
`fix.localIterations` resolves against the EFFECTIVE, already repo-clamped
`fix` block the runner seeds on every run's context — a repository that lowered
its own budget in `.lastlight/lastlight.yml` is honoured with no code path of
its own. Resolution happens once, before the first iteration, in
`resolveTemplatedNumber` (`core/templated-number.ts`).

`default` is the value the workflow ships with, and it is used verbatim
whenever `from` resolves to nothing usable — key absent, non-numeric, zero or
negative — with a warning naming the phase and the path. That is why the shape
is an object rather than a bare `"{{fix.gateTimeoutSeconds}}"`: an unresolved
template renders to the empty string, which would leave the engine inventing a
kill timeout for a phase it knows nothing about. A resolved non-integer is
rounded UP (`gateTimeoutSeconds` is documented as any positive number, and
truncating a suite's budget downward is the direction that turns a passing gate
red).

Before this, both keys were parsed, per-repo clamped, CLI-displayed and read by
nothing: the operative numbers were literals in the YAML, whose comments asked a
human to keep the two in step (issue #256).

**A loop node honours the phase's `on_output.requires_marker` and its
`messages.on_start` / `on_success`.** The postcondition is checked once, against
the **last** iteration's output (the turn that reports the outcome; an earlier
one is by definition mid-loop), and its absence fails the phase exactly as it
does for a non-loop phase. Reaching `max_iterations` without the condition is
**not** a failure — a fix loop that runs out of iterations reports
`outcome=gave-up`, which is a correct outcome — only the absent sign-off is. Two
paths are exempt because they produce no fresh turn to sign off: a deduplicated
(already-completed) phase on resume, and the `on_soft_failure: complete`
advance.

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
- **One workspace per run — phases, loop iterations and fan-out
  branches all share `ctx.taskId`.** Every inter-phase handoff reads
  the previous phase's output off that one disk, so a per-phase clone
  would break them all.
- **DAG nodes run one at a time.** The only concurrency in the engine
  is *within* a `type: fanout` node. If you need two phases to overlap,
  that is the parked worktree project, not a scheduler tweak.
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
- **A gated skip keeps the run green.** `requires_sandbox`,
  `sandbox_image` and `skip_if` all record the node `skipped` and leave
  the run `succeeded`. `failed` is reserved for **malfunction** — a
  correct "there is nothing to do here" is not one, and recording it as
  one mis-fires four downstream mechanisms (see *Gated skips*).
- **A skipped node is not `succeeded`.** So an `all_success`
  `trigger_rule` downstream of a gated phase will not fire. That caveat
  is identical for all three gates; a graph that must proceed past one
  needs `all_done` or `none_failed_min_one_success`.
- **A run's config is frozen at dispatch.** `runWorkflow` takes the target
  repo's `.lastlight/` layer as a trailing, *defaulted* parameter (defaulted so
  `runWorkflow.length` stays 9 — the frozen `lastlight/evals` surface pinned by
  `evals-contract.test.ts`) and derives the effective models / variants /
  approval gates from it. A **resume restores** that layer from the run row
  rather than re-resolving it from the repo's default branch, so an edit made
  while the run was paused, queued or dead can't retarget it half-way through.
  See [Configuration](/spec/02-configuration) and
  [State](/spec/10-state).
- **Per-run asset resolution never mutates the module globals.** When a repo
  layer applies, the runner builds an `AssetResolver` over
  `getAssetLayers() + makeLayer("repo", …)` and passes *that* through
  `EnginePorts.assets` (`loadPromptTemplate` / `resolveSkillPaths`) for the whole
  run — not `configureWorkflowAssets`, which would leak one run's repo layer into
  another's prompts. `populateCache()` additionally refuses to read workflow or
  cron YAML from a `repo` layer, so "a repo may not define workflows" is
  structural rather than conventional.

## Current implementation

| Piece | File |
|---|---|
The runtime-agnostic core lives in **`lastlight-workflow-engine`**
(`packages/workflow-engine/src/`); the `src/workflows/*.ts` names below
are one-line re-export shims (`export * from "lastlight-workflow-engine"`),
kept so existing imports resolve. Anything needing GitHub, a sandbox or
the database stays app-side, behind a port.

| Piece | File |
|---|---|
| Public entry | `src/workflows/simple.ts` |
| The one scheduler (DAG walk, node status, wrap-up) | `packages/workflow-engine/src/core/scheduler.ts` |
| Per-phase bodies (context / agent / loops / gates) | `packages/workflow-engine/src/core/phase-executor.ts` |
| App-registered phase types | `src/workflows/handlers/{post-review,fanout}.ts`, registered in `runner.ts` |
| Composition root (real ports: sandbox, state, GitHub) | `src/workflows/runner.ts` |
| YAML schema (Zod) | `packages/workflow-engine/src/core/schema.ts` |
| YAML loader + caching | `src/workflows/loader.ts` |
| DAG graph utilities | `packages/workflow-engine/src/core/dag.ts` |
| Loop-iteration / branch label authority | `packages/workflow-engine/src/core/phase-ref.ts` |
| Until-condition evaluator | `packages/workflow-engine/src/core/loop-eval.ts` |
| Template engine | `packages/workflow-engine/src/core/templates.ts` |
| Resume + orphan recovery | `src/workflows/resume.ts` |
| Concurrency cap + admission | `src/workflows/admission.ts` (cap enforced in `simple.ts`) |
| Per-repo layer: dispatch-time resolve, persist, restore | `src/workflows/simple.ts` (`resolveRepoRunConfig`, `repoConfigRunRecord`, `restoreRepoRunConfig`) |
| Per-run asset resolver | `createAssetResolver` / `makeLayer` / `getAssetLayers` in `packages/shared/src/workflow-loader.ts`, wired in `runner.ts` |

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
- **A single state store, not two.** Both the relational DB (resume
  substrate) and the JSONL event logs (event stream) are needed — see
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
