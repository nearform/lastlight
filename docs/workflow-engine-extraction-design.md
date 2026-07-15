# Design: `@lastlight/workflow-engine`

Extract Last Light's bespoke workflow engine out of `src/workflows/` into a
standalone, port-driven, publishable package. The goal is testability (fake
ports, no docker/git/sqlite) and reuse (another codebase — e.g. the Mastra port
at `~/work/mac` — can depend on the engine without the whole app).

This is an **extraction, not a rewrite.** The scheduler, DSL, template engine,
loop constructs, approval semantics, and resume/dedup ledger are preserved
verbatim; we only invert four concrete couplings into injected ports and
relocate files.

---

## 1. Module boundary

```
@lastlight/workflow-engine
  core/
    dag.ts            pure graph: buildDag, getReadyNodes, getNodesToSkip, isComplete, topoSort
    phase-ref.ts      loop-iteration label format()/parse()
    verdict.ts        parseReviewerVerdict
    loop-eval.ts      generic_loop `until` expression evaluator
    templates.ts      Mustache-ish renderTemplate + TemplateContext + slugify
    schema.ts         Zod DSL: AgentWorkflow / Phase / PhaseLoop / GenericLoop / Cron
    types.ts          shared vocabulary: ExecutorConfig, ExecutionResult,
                      CommandSpec, GitSandboxAccess, PhaseOutcome, WorkflowResult
    scheduler.ts      runWorkflowCore(definition, ctx, config, callbacks, deps)
    phase-executor.ts PhaseExecutor bodies: context / standard / bash / script /
                      reviewer-loop / generic-loop (post-review lives app-side)
  ports/
    ports.ts          AgentPort, WorkflowStateStore, AssetLoader, LivenessPort,
                      PhaseReporter, PhaseResolver, PhaseTypeHandler, EngineDeps
  test-support/
    fakes.ts          FakeAgentPort, InMemoryStateStore, RecordingReporter, StubAssetLoader
```

Everything above is **domain-agnostic** — no imports of `../engine`, `../state`,
`../notify`, `../admin`, GitHub, or better-sqlite3. Enforced by a
dependency-cruiser CI gate.

### Stays in the app (`src/workflows/`)

The app *uses* the engine — it owns the Last-Light-specific wiring:

- `loader.ts` — layered built-in/overlay asset roots, `configureWorkflowAssets`.
  Adapts to the engine's `AssetLoader` port.
- `simple.ts` — `runSimpleWorkflow`: row create/reuse, `handleExistingRun`,
  `TemplateContext` build with `wrapUntrusted`, kill-switch. The dispatch
  orchestration.
- `resume.ts` — boot orphan recovery + GitHub issue refetch + Slack resume.
- `target-policy.ts` — PR/build workspace reuse sets.
- `runner.ts` — thin **composition root**: keeps `runWorkflow(...)` (unchanged
  9-arg signature), builds the default ports, delegates to `runWorkflowCore`.
  Also `gitAccessProfileForWorkflow` / `gitSandboxAccessForWorkflow`.
- `handlers/post-review.ts` — the `post-review` phase type as an app-registered
  `PhaseTypeHandler` (GitHubClient, review-poster, git shelling, build-assets).

---

## 2. Ports

Four concrete couplings become injected interfaces. The existing concrete types
**already satisfy these structurally**, so introducing each port is a type-only
change.

### `AgentPort` — the agent/sandbox seam

Replaces the direct `executeAgent` / `executeCommand` imports in
`phase-executor.ts`. Signatures mirror `src/engine/agent-executor.ts` exactly.

```ts
export interface AgentRunOpts {
  taskId?: string;
  githubAccess?: GitSandboxAccess;
  onSessionId?: (sessionId: string) => void;
  timeoutSeconds?: number;
  sandboxEnv?: Record<string, string>;
  writeSession?: boolean;
}
export interface AgentPort {
  runAgent(prompt: string, config: ExecutorConfig, opts: AgentRunOpts): Promise<ExecutionResult>;
  runCommand(spec: CommandSpec, config: ExecutorConfig, opts: AgentRunOpts): Promise<ExecutionResult>;
}
```

`ExecutorConfig` (carrying the frozen `githubApiBaseUrl` mock seam) flows through
unchanged. Default app adapter is a two-line delegation to
`executeAgent`/`executeCommand`.

### `WorkflowStateStore` — runs + dedup ledger + approvals

The observed method surface of `StateDb` and its sub-stores. `StateDb` already
implements it; the engine just takes `store: WorkflowStateStore` instead of
`db: StateDb`.

```ts
export interface RunStore {
  getRun(id: string): WorkflowRun | undefined;
  getByTrigger(triggerId: string): WorkflowRun | undefined;
  createRun(row: NewWorkflowRun): void;
  appendPhase(id: string, phase: string, entry: PhaseHistoryEntry): void;
  finishRun(id: string, status: "succeeded" | "failed" | "cancelled", opts?: FinishOpts): void;
  setRunning(id: string): void;
  mergeScratch(id: string, patch: Record<string, unknown>): void;
  pauseForApproval(id: string, approval: NewApproval, marker: PhaseMarker, scratchPatch?: Record<string, unknown>): void;
  incrementRestartCount(id: string): number;
  listActive(): WorkflowRun[];
}
export interface ExecutionLedger {
  shouldRunPhase(dedupKey: string, triggerId: string, workflowRunId?: string): "run" | "running" | "done";
  recordStart(row: NewExecution): void;
  recordFinish(id: string, result: ExecutionFinish): void;
  recordSessionId(id: string, sessionId: string): void;
  recordOutputText(id: string, text: string): void;
  recordSkippedPhase(dedupKey: string, triggerId: string, workflowRunId?: string, repo?: string): void;
  markAllStaleForTrigger(triggerId: string, reason: string): number;
  getPhaseOutput(dedupKey: string, triggerId: string, workflowRunId?: string): string | undefined;
}
export interface ApprovalStore {
  getPendingForWorkflow(runId: string): WorkflowApproval | undefined;
}
export interface WorkflowStateStore {
  runs: RunStore;
  executions: ExecutionLedger;
  approvals: ApprovalStore;
}
```

`isWorkflowEnabled` (dashboard kill-switch) stays app-side, not engine state.

### `AssetLoader` — prompts + skills

Replaces `phase-executor`'s direct `loadPromptTemplate` / `resolveSkillPaths`
imports. Mostly already covered by `PhaseResolver.renderPrompt`; this adds the
two remaining reads.

```ts
export interface AssetLoader {
  loadPromptTemplate(relativePath: string): string;
  resolveSkillPaths(names: readonly string[]): string[] | undefined;
}
```

### `LivenessPort` — container liveness (tiny)

Replaces `listRunningContainers` (`admin/docker`). The test impl returns `false`.

```ts
export interface LivenessPort {
  isPhaseContainerAlive(taskId: string): Promise<boolean>;
}
```

### `PhaseTypeHandler` — the domain escape hatch

`post-review` is the one body genuinely coupled to GitHub. Instead of porting
each of its dependencies, invert the *dispatch*: core owns the phase-type switch
for the generic kinds (context / agent / bash / script / loops) and delegates
unknown types to app-registered handlers.

```ts
export interface PhaseTypeHandler {
  execute(phase: PhaseDefinition, node: DagNode, outputs: Readonly<Record<string, unknown>>): Promise<PhaseOutcome>;
}
// app registers: "post-review" -> GitHubPostReviewHandler
```

### Already abstracted: notification

`PhaseExecutor` already depends only on `PhaseReporter` (not `../notify`). It and
`PhaseResolver` move into `ports.ts` unchanged. The `ProgressReporter` →
`../notify` coupling lives entirely in the app layer (`runner`/`simple`/`resume`),
which *constructs* a `PhaseReporter` from `RunnerCallbacks.reporter`.

### Bundling

```ts
export interface EngineDeps {
  store?: WorkflowStateStore;       // omitted => inert approval gates + no ledger resume
  agent: AgentPort;
  assets: AssetLoader;
  liveness: LivenessPort;
  reporter: PhaseReporter;
  resolver: PhaseResolver;
  handlers?: Map<string, PhaseTypeHandler>;
  models?: ModelConfig;
  variants?: VariantConfig;
  approvalConfig?: Record<string, boolean>;
  workflowId?: string;
}
```

---

## 3. The composition root (frozen `lastlight/evals` surface)

`src/evals-api.ts` must not change. Keep the app-side `runWorkflow` as the
composition root — same path, same 9-arg signature:

```ts
// src/workflows/runner.ts — signature UNCHANGED
export async function runWorkflow(
  definition, ctx, config, callbacks,
  db?, models?, approvalConfig?, workflowId?, variants?,
): Promise<WorkflowResult> {
  const deps: EngineDeps = {
    store: db,                                   // StateDb satisfies WorkflowStateStore
    agent: defaultAgentPort,                     // wraps executeAgent/executeCommand
    assets: defaultAssetLoader,                  // wraps loader.ts
    liveness: dockerLivenessPort,               // wraps listRunningContainers
    reporter: buildReporter(callbacks),
    resolver: buildResolver(config),
    handlers: new Map([["post-review", makePostReviewHandler(config, callbacks)]]),
    models, variants, approvalConfig, workflowId,
  };
  return runWorkflowCore(definition, ctx, config, callbacks, deps);
}
```

Invariants preserved:

- `runWorkflow`'s 9-arg signature is byte-stable → the barrel needs **zero edits**.
- `db` omitted ⇒ `store` undefined ⇒ approval gates inert + ledger-resume no-ops
  — today's exact eval behavior.
- `ExecutorConfig.githubApiBaseUrl` still flows `config → AgentPort →
  executeAgent → github_* tools`, and into the post-review handler's review
  client. Untouched.
- `TemplateContext` / `ExecutorConfig` importable from their current paths via
  re-export shims during the transition.

---

## 4. Behavior held verbatim (do not touch)

- **Single sequential DAG walk.** One ready node at a time, declaration order,
  one shared `taskId` workspace. Do **not** parallelize `getReadyNodes()` — real
  concurrency needs git worktrees (separate issue).
- **Ledger-driven resume.** Always re-run from the top; `shouldRunPhase` skips
  `success=1` rows. No `currentPhase` resume index.
- **The `outputs`-across-resume caveat.** A phase skipped on resume (dedup
  `done`) contributes **nothing** to the in-memory `outputs` map. The
  `InMemoryStateStore` fake must reproduce this, or resume tests pass against a
  fake more forgiving than production.
- **Loop labels** via `PhaseRef.format()` (`reviewer_fix_n`,
  `reviewer_recheck_n`, `reviewer_iter_n`, `_iter_n_retry`).
- **Approval-gate state machine** (`rloop:<phase>.pausedAtCycle`, three
  resolution paths → one resume), **capability gating** (`requires_sandbox`,
  `sandbox_image`, `unrestricted_egress`, `web_search` — silent degrade),
  **output-marker branching** (`on_output` + `unless_*` bypass), and the **YAML
  DSL / Zod schema** — all preserved exactly.

---

## 5. Testability

Injected ports replace today's `vi.mock(...)` of agent-executor / loader / docker
/ `child_process` and the `makeMockDb() as unknown as StateDb` cast.
`test-support/fakes.ts` ships:

- **`FakeAgentPort`** — records `{prompt, config, opts}` per call, returns
  scripted `ExecutionResult`s. Mirrors the existing `FakeSandbox`
  (`src/sandbox/sandbox.ts`) shape (records received opts for assertions).
- **`InMemoryStateStore`** — real Map-backed `WorkflowStateStore`, no
  better-sqlite3. Reproduces the resume caveat above.
- **`RecordingReporter`** / **`StubAssetLoader`**.

Highest-value unit tests, now with no docker/git/sqlite/filesystem:

- approval state machine (pause → persist → resume → fix cycle, not re-pause;
  a dedup-`done` review is not misread as APPROVED);
- ledger-driven resume (crash → only the `success=0` phase re-runs);
- both loop constructs + capability-gating skips.

---

## 6. Sequenced extraction (each step keeps tests green)

Milestone A is an in-repo module (`src/workflow-engine/`); milestone B promotes
it to the package once the boundary is proven.

**Milestone A — in-repo module**
1. Move pure leaves (`dag`, `phase-ref`, `verdict`, `loop-eval`, `templates`,
   `schema`) to `src/workflow-engine/core/`; leave one-line re-export shims at the
   old paths. No behavior change.
2. Move shared type declarations (`ExecutorConfig`, `ExecutionResult`,
   `CommandSpec`, `GitSandboxAccess`) into `core/types.ts`; `profiles.ts` /
   `agent-executor.ts` re-export them. Kills the core→engine type dependency.
3. Add `ports.ts` with the interfaces; change `PhaseRunContext.db: StateDb` →
   `store: WorkflowStateStore` (structural, compiles unchanged). Re-home
   `PhaseReporter` / `PhaseResolver`.
4. Invert `AgentPort`: `runPhase`/`runCommandPhase`/`runUntilBash` take the port;
   build `defaultAgentPort` in `runner.ts`; tests inject `FakeAgentPort`.
5. Invert `AssetLoader` + `LivenessPort`; drop the `loader`/`docker` `vi.mock`s.
6. Lift `post-review` into `src/workflows/handlers/post-review.ts`
   (`PhaseTypeHandler`); core dispatches unknown types via `deps.handlers`.
   Removes GitHubClient/review-poster/git/build-assets from core.
7. Split the scheduler: `runWorkflowCore` in `core/scheduler.ts`; reduce
   app `runWorkflow` to the composition shim (§3).
8. Enforce the boundary: dependency-cruiser gate (core has no app-layer imports).

**Milestone B — package**
9. Lift `src/workflow-engine/` into a workspace package
   `@lastlight/workflow-engine` (`core/` + `ports/` + `test-support/`). Only
   after the gate in step 8 is green. Point the old `src/workflows/*` shims at
   the package.

---

## 7. Regression fences

- `npx vitest run src/workflows/ tests/workflows/` green after every step;
  `golden-build.test.ts` unchanged (phase sequence pinned).
- New `tests/workflows/evals-contract.test.ts` — asserts `runWorkflow.length === 9`
  and `expectTypeOf` on `RunnerCallbacks` / `WorkflowResult` /
  `ExecutorConfig.githubApiBaseUrl`.
- New `tests/workflows/state-store-contract.test.ts` — type-asserts
  `StateDb satisfies WorkflowStateStore` so a future `StateDb` change surfaces at
  compile time.
- dependency-cruiser CI gate on the core import boundary.
- Smoke `~/work/lastlight-evals` against the branch to confirm the
  `lastlight/evals` surface still drives real workflows against mocked GitHub.

## Anchor files

`src/workflows/{runner,phase-executor,schema,simple,resume,loader,templates,dag,phase-ref,verdict,loop-eval,target-policy}.ts`,
`src/engine/github/profiles.ts` (`ExecutorConfig`), `src/state/db.ts`,
`src/evals-api.ts`, `src/sandbox/sandbox.ts` (`FakeSandbox` prior art),
`tests/workflows/{runner,phase-executor}.test.ts` (migration fences),
`src/workflows/CLAUDE.md` (authoritative design doc).
