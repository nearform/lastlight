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

- **RunIdentity** — the immutable value object that is the single authority for
  a run's derived identity: `{ branch, taskId, issueDir, issueKey,
  buildAssetsRelocated, prePopulateBranch }`. Computed **once** at run creation
  (`RunIdentity.forNew(request, config)`) and persisted into the row's immutable
  `context`; every reuse and resume `RunIdentity.load(context)`s it **verbatim**
  — never recomputed (a missing field **throws**, it does not fall back to a
  formula). This is what kills the `lastlight/N-slug` branch drift that used to
  422 the PR phase on resume (the fallback recompute saw an empty title and
  collapsed to `lastlight/N-issue-N`, a ref that was never pushed). The full
  **TemplateContext** (the rendered variable bag — distinct concept) is then
  assembled by one `buildTemplateContext(identity, content, config, callbacks)`
  that both the fresh-dispatch (`simple.ts`) and resume (`resume.ts`) paths call,
  so resume structurally cannot drop `prNumber` / `botMention` / `artifactBaseUrl`
  / `request.extra` (`content.extra` is seeded by spreading the stored `context`,
  preserving `failedChecks` / `headSha` / `channelId`). Lives in
  `src/workflows/run-identity.ts`; absorbs the former `resolveRunBranch` /
  `artifactIssueDir` / `workflowScopedTaskId` helpers as private ordering.
  _Avoid_: recomputing identity on resume; a second copy of the branch formula;
  conflating RunIdentity (immutable identity) with TemplateContext (rendered
  vars, refetched content included). See [[lastlight-architecture-deepening-issues]].

- **PhaseExecutor** — the deep module that owns every per-phase body (context /
  reviewer-loop / generic-loop / standard / approval-gate) behind one
  `execute(node, outputs) → PhaseOutcome`. The scheduler owns ordering and
  accumulation; the PhaseExecutor owns what one phase *does*.

- **Trigger rule** — per-edge condition (`all_success`, `one_success`,
  `none_failed`, `none_failed_min_one_success`, `all_done`) deciding whether a
  node runs given its dependencies' statuses. `none_failed` passes an
  all-skipped set; `none_failed_min_one_success` also needs one success. A node whose rule can't be satisfied is
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

## Sandbox execution

Vocabulary pinned during the `/grilling` of the sandbox-seam deepening
(architecture review: collapse `executeDocker`/`executeSmol`/`executeInProcess`
into one orchestrator behind a named port). Describes the agreed target shape;
the implementation PR uses these names.

The framing decision underneath all of these: Last Light is
**agent-in-sandbox**, not **tools-in-sandbox**. The port isolates the *whole
agent run* — the runtime and every tool it calls — not individual tool calls
dispatched out from a host-resident agent. Prefer "agent-in-sandbox" when
naming the model; _avoid_ describing the backends as "sandboxing the agent's
tools" (the agent isn't on the host). See [ADR-0001](docs/adr/0001-agent-in-sandbox.md).

- **Sandbox** — the **port** every backend implements: `provision() →
  { hostWorkspaceDir, agentCwd }`, `runAgent(taskId, prompt, opts, onEvent)`,
  `runCommand(taskId, command, opts)`, `dispose()`. The port **owns
  provisioning** — each adapter orders its own clone-vs-boot internally (docker
  pre-clones then mounts; smol boots then probes the share-backed dir then
  clones; in-process just `setupTaskWorktree`) and hands back the two things the
  orchestrator needs. `runAgent` emits **parsed event records**, never raw
  lines — `JSON.parse` is the subprocess adapters' job. _Avoid_: calling the
  backend classes a "driver" or "runtime"; the deep module behind the port is
  the **orchestrator** (below), the things at the seam are **adapters**.

- **Sandbox adapter** — a concrete backend at the `Sandbox` seam:
  `DockerSandbox`, `SmolSandbox`, `InProcessSandbox`, `FakeSandbox`. An adapter
  owns its isolation mechanism (container / micro-VM / in-process env-splice)
  and its egress enforcement; none of that surfaces at the interface.
  `InProcessSandbox` is **one** class parameterized by `mode: 'gondolin' |
  'none'` — the two differ only in agentic-pi's `sandbox` arg and a `HOME`
  override; it owns the `applyEnv`/`restore` `process.env` splice and the lazy
  `import("agentic-pi")`. The `mode` flag is a **tombstone**: when `gondolin`
  is retired it collapses to single-mode `none`. _Avoid_: a second
  near-twin `GondolinSandbox` class (the split is two field values, not two
  behaviours).

- **Sandbox orchestrator** — the deep module that owns one agent/command run
  end-to-end: a shared `withSandbox(...)` bracket (provision → work →
  session-jsonl write → dispose → fallback-finalize) with two thin callers,
  `runSandboxedAgent` and `runSandboxedCommand`. It holds the
  skill-staging, build-artifact stage/harvest, `RunResultAccumulator` + shim +
  `recordPiEvent` event loop, and session-id notification — **written once**,
  identical for every adapter. Replaces the per-backend `executeDocker` /
  `executeSmol` / `executeInProcess` twins and the `if (backend === …)`
  ladders. Adapters are built by the single factory `sandboxFor(backend,
  { egress, env, imageName })`; tests substitute one via an optional
  `sandboxFactory` on the `executeAgent`/`executeCommand` opts (default
  `sandboxFor`).

- **EgressPolicy** — the **intent-only** value object the orchestrator hands an
  adapter at construction: `{ unrestricted: boolean; hosts: string[] }` (hosts
  already merged with OTEL collector hosts). The orchestrator decides *what is
  allowed*; each adapter translates it to its *mechanism* — docker `--dns`
  strict/open, smol `--allow-host`, in-process `allowedHttpHosts` / `["*"]`. The
  `172.30.0.x` constants and the `"*"` sentinel live inside adapters. The
  SSRF-metadata floor is adapter-local (docker `coredns-open` NXDOMAINs the
  metadata literals; smol does not — a documented gap). _Avoid_: a
  per-mechanism struct (`{ dnsIp?, allowHosts?, allowedHttpHosts? }`) — that is
  the leak wearing a value object.

- **FakeSandbox** — the in-memory `Sandbox` adapter for unit-testing the
  orchestrator without Docker/VMs. `provision()` returns a **real** `mkdtemp`
  workspace (so skill staging + artifact harvest run for real), `runAgent`
  replays a **canned array of pi event records** through `onEvent` (with a throw
  mode for the fallback path), and it **records** the opts it received
  (`EgressPolicy`, `agentCwd`, `skillDirs`, `sandboxEnv`) for assertions. Covers
  Last Light's orchestration, not agentic-pi's semantics. The
  `RUN_SANDBOX_IT` / `RUN_SMOL_IT` integration tests demote from "only coverage"
  to boundary smoke (real adapter boots + streams).
