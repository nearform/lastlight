# WP5 — parallel phases (Track B)

**Goal.** Let the scheduler run independent DAG nodes concurrently, so the
survey fan-out is wall-clock parallel and each specialist is a first-class,
individually-retryable phase.

**Depends on:** nothing. **Nothing in this plan depends on it.**

> **PARKED, 2026-08-21 ([10-design-review.md](10-design-review.md) §D5.)** The
> review pipeline ships fully sequentially as **six declared phases**
> ([WP3](03-seed-and-survey.md) — not the `generic_loop` this file used to
> assume, which did not work). WP5 buys **latency and observability, not
> recall**, and no gate in this plan reads either.
>
> The decisive point: **the workflow YAML is identical sequential or parallel.**
> Enabling concurrency later is `maxPhasesPerRun` plus a scheduler change, with
> no prompt, obligation or measurement rework. So this is purely an ordering
> question, and the ordering follows the gates. [WP4](04-probe-oracle.md) AC6
> produces the latency number that would justify unparking it.
>
> **Two carve-outs.** **S2 and S3 land now, independently** — they are
> correctness bugs under the run-level concurrency already shipping. And record
> the cheaper alternative: **in-agent fan-out**. Every hard blocker below — B1,
> D1, D2, D7 — exists *because each phase provisions its own sandbox against a
> shared workspace*. A fan-out inside one agent has none of them. `agentic-pi`
> has no subagent primitive and that is deliberate (`README.md` §1: one-shot,
> one turn, *"the orchestrator spawns a new process"*), so it means a new
> extension — but plausibly a smaller project than 5a+5b+D1+D2+D7, and far safer
> on the nearform host's memory profile. It costs per-family ledger rows,
> retryability and cost attribution.

## This is a restoration, not an invention

Issue **#7** ("DAG parallelism in workflow executor") specified exactly this —
`Promise.allSettled` over ready nodes, per-node sandboxes, *"shared git state via
worktree"*, and *"`workflow_runs` needs per-node status tracking"*. Issue **#94**
then **deliberately removed** the parallel fan-out to collapse two forked
schedulers into one, recording:

> *"**Sequential execution** — remove the `Promise.allSettled` parallel fan-out.
> `getReadyNodes` are run one at a time in declaration order. (Real concurrency
> via git worktrees is deferred to a later issue.)"*

#7 was closed **by that unification, not by implementation**. Its own build-it
criterion was *"users are creating multi-reviewer workflows"* — now true. **#7 is
the issue to reopen**; there is no open issue today.

Much of the surrounding code was written for this and is already correct:

- Skill bundles are staged per phase, with the intent stated verbatim: *"Keyed by
  phase so **concurrent phases** in one workspace never touch each other's
  bundle"* (`src/engine/executors/shared.ts`). Script bundles likewise
  (`.lastlight-scripts/<phase>/`).
- `withSandbox` (`src/engine/executors/orchestrator.ts`) holds no shared state.
- Telemetry is **already correct under concurrency**: `withSpan`
  (`src/telemetry/index.ts`) wraps `context.with(...)` and `NodeSDK` registers
  the AsyncLocalStorage context manager; `AgentSpanTree`
  (`src/telemetry/pi-events.ts`) snapshots its parent context in the constructor
  precisely so later events do not mis-parent. Not ambient. No work needed.
- Backend re-entrancy across *runs* is already proven in production —
  `concurrency.maxWorkflows: 4` means four sandboxes, gondolin VMs included,
  already coexist in one harness process.

**The mechanism can land dark.** No production workflow ever produces
`ready.length > 1`. Three declare `depends_on` — `demo.yaml`, `qa-test.yaml`,
`verify.yaml` — and none of them fan out: `qa-test` and `verify` do have a join
node (`summary` depends on `[qa_test, qa_browser]`), but the join's second
dependency is itself downstream of the first, so only ever one node is ready at a
time. Everything else goes through chain synthesis in `dag.ts`. Only
`workflows/examples/parallel-review.yaml` has true sibling parallelism, and it is
an unused example. So a `maxPhasesPerRun`-gated change with a default of `1` is
provably a no-op — verify it with a test that asserts `getReadyNodes(...).length
<= 1` for every workflow in `workflows/`.

## The sequential point is one line

`packages/workflow-engine/src/core/scheduler.ts`:

```ts
// Sequential: run the earliest-declared ready node, one at a time.
const node = ready[0];
```

Everything in `dag.ts` is already DAG-correct. But the moment a real workflow
fans out, **six things break, and one of them silently corrupts run state.**

## Blockers

### B — need a design, not a patch

| # | Blocker | Evidence |
|---|---|---|
| **B1** | **One workspace per run.** Two agents in one git checkout, one `.git/index`, one working tree. This is #7's own answer (worktrees) and everything in D1–D3 is downstream of it | `phase-executor.ts` (one `taskId`); `orchestrator.ts`; `sandbox/index.ts` |
| **B2** | **Approval-pause and abort cannot early-return.** The scheduler returns immediately on `outcome.paused`; under `Promise.all` you cannot. A sibling then finishes, `anyFailed` is false, and the wrap-up calls `finishRun(…, "succeeded")` — **overwriting `paused` and orphaning the pending `workflow_approvals` row.** Resolving the gate later resumes a run that already reads `succeeded`. **Silent corruption — the worst item in this list** | `scheduler.ts` (paused/aborted early-return vs the success wrap-up); `phase-executor.ts` `pauseForApproval` |
| **B3** | **k8s pod + Secret name collision.** `podNameFor(taskId, "run")` is `sha1(taskId + "/run")` with **no phase component and no random suffix**, so two concurrent phases produce one name and the second create 409s. Secret names derive from it. And `pvcNameFor(taskId)` is a single `ReadWriteOnce` claim — two pods cannot mount it across nodes | `k8s/naming.ts`; `kubernetes-sandbox.ts`; `k8s/secret.ts`; `k8s/pvc.ts` |
| **B4** | **`current_phase` is a single column.** Two phases in flight and the run row lies about which phase it is on — reintroducing structurally the exact bug two prior fixes were written to kill (`scheduler.ts`'s throw-attribution comment, and prod run `49c101aa` in `phase-executor.ts`). Needs per-node status, which #7 itself called out | `workflow-run-store.ts` |

### D — real design changes

| # | Issue | Evidence |
|---|---|---|
| **D1** | **There is no provisioning lock, and today's safety is an accident.** Everything in `prePopulateWorkspace` is `execFileSync`, which blocks the event loop, so one phase's whole provision is atomic w.r.t. another *by accident*. It breaks on the refresh-error path (the catch deliberately does not advance the `.lastlight-run` marker, so the next phase re-enters the destructive `fetch`/`checkout -B`/`reset --hard`/`clean -fdx` branch **under a live sibling**) and does not apply at all on k8s, where the clone runs in an **async init container** | `sandbox/index.ts`; `k8s/init-clone.ts` |
| **D2** | **`ensureBaseAvailable` runs on every phase provision, including the preserve path** — deliberately, to stop a fix phase merging a stale base. It does `git fetch --depth 50/500/--unshallow` and `git remote set-branches --add` into a `.git` a sibling agent is actively using → `shallow.lock` / `packed-refs.lock` / `config.lock` contention | `sandbox/index.ts` |
| **D3** | **Build-asset stage/harvest is per-run, not per-phase.** Two concurrent phases stage then harvest the same `architect-plan.md` / `reviewer-verdict.md`; last harvest wins, silently. (`AGENTS.md` is also written per-phase to one path, but with identical content — benign) | `executors/shared.ts` `serverArtifacts`; `orchestrator.ts` stage/harvest |
| **D4** | **`outputs` is last-writer-wins with mid-flight reads.** `Object.assign(outputs, outcome.outputVars)` races, and siblings *read* `outputs` while another writes — `buildPhasePrompt`, the reporter's template render. Two siblings sharing an `output_var` clobber silently; the spec already documents `output_var` aliases as unprotected | `scheduler.ts`; `phase-executor.ts`; `runner.ts` |
| **D5** | **Terminal-state flip mid-flight.** `failWorkflow` finalises the run immediately, which fires `notifyTerminal` → the `last-light/review` Check completes and the reap paths treat the run as over — while a sibling is still burning tokens in a sandbox. `on_output: { action: fail }` has the same shape | `runner.ts`; `workflow-run-store.ts`; `engine/review-check.ts` |
| **D6** | **Cancellation never reaches in-flight phases**, and the polling window widens with fan-out — nothing tears down the sandboxes | `scheduler.ts` |
| **D7** | **No concurrency accounting.** `concurrency.maxWorkflows` (default 4) is *run*-level; N-way fan-out multiplies live sandboxes by DAG width. k8s absorbs it via `ResourceQuota` backpressure; **docker and gondolin do not** — and gondolin is the default, with each phase a QEMU micro-VM in the harness process. The nearform host has no swap, a 2 GB agent cap, and has wedged under memory pressure before | `spec/06-workflow-engine.md`; `spec/09-sandbox.md` |

### S — safe today, independently valuable

| # | Fix |
|---|---|
| **S1** | Mark **all** ready nodes `"running"` before awaiting any — `getReadyNodes` filters on `status !== "pending"`, so otherwise it re-dispatches them next turn |
| **S2** | Route `appendPhase` and `mergeScratch` through the existing op serializer. **Both are currently unguarded read-modify-write** (`SELECT` then `UPDATE`, default client, not wrapped in `serialize`), so two phases finishing near-simultaneously lose an update. This is a **correctness bug today** under the run-level concurrency we already ship, not only under phase concurrency |
| **S3** | docker: add a phase component to `serviceContainerName` (currently a fixed `lastlight-svc-${taskId}-${name}`), and scope `stopServices`' label filter beyond `taskId` — **phase A's `dispose()` currently kills phase B's service containers** |
| **S4** | `isPhaseContainerAlive` keys on `taskId` alone, so a stale `running` row for phase A reports "alive" because phase B's container is up; `markStaleAsFailed` never fires and the phase aborts |
| **S5** | Make `firstFailure` and the terminal PR-number scan order-independent (sort `phases[]` by DAG order, or track failure separately) |
| **S6** | k8s pod suffix: `podNameFor` **already takes a `phaseSuffix`** and is being passed the constant `"run"`. Threading the phase name through is a one-liner; the PVC half of B3 is the hard part |
| **S7** | **Fix the stale spec.** `apps/server/spec/06-workflow-engine.md` still describes the **pre-#94** DAG path — *"Concurrent phases run via `Promise.allSettled()`. Each gets a phase-scoped taskId (`${taskId}-${phaseName}`)"*. That code does not exist. Anyone reading the spec would conclude this already works |

## Staging

Three sub-packages, in order. Each is independently shippable.

### 5a — safe today (no behaviour change)

S1, S2, S5, S6, S7. **S2 and S3 are bug fixes under today's run-level
concurrency** and are worth landing on their own merits regardless of whether
WP5 ever completes. S7 is a documentation correctness fix that should land
first, because the spec currently misleads.

### 5b — the run-level state machine

B2, B4, D5. This is what makes a bounded-concurrency map **correct** rather than
merely fast:

- per-node status on `workflow_runs` (#7's own requirement), with `current_phase`
  becoming a derived projection — the earliest-declared running node — rather
  than an authority;
- a **quiesce** step: `paused` / `failed` / `aborted` set the run's *intent* and
  the scheduler stops dispatching new nodes, but the wrap-up waits for in-flight
  nodes and never overwrites a terminal intent with `succeeded`;
- `notifyTerminal` fires from the quiesced state, not from the first failure.

Ship the concurrency **cap** (D7: `concurrency.maxPhasesPerRun`, default `1`,
plus a global in-flight agent-call cap) **before** anything can fan out.

### 5c — the workspace

B1, D1, D2, D3. The real project:

- per-phase **git worktrees** off the shared clone (cheap — no second 1.3 GB
  clone), or per-phase taskIds with a merge story;
- a per-taskId **async provisioning mutex** regardless, since D1's current safety
  is an event-loop accident;
- `ensureBaseAvailable` skipped for a sibling attaching to an already-provisioned
  workspace;
- build-asset stage/harvest serialised or made per-phase.

`src/worktree/manager.ts` exists but is **dead code** — referenced only by its
own test. Either wire it here or delete it; do not plan around it as if it were
live.

**B3's PVC half is k8s-specific** and can be deferred by capping that backend at
`maxPhasesPerRun: 1`.

## What the review pipeline gets

Once 5a + 5b + the cap are in, the survey fan-out can become real phases:

```yaml
  - name: survey_contract   { depends_on: [seed] }
  - name: survey_enforcement{ depends_on: [seed] }
  - name: survey_security   { depends_on: [seed] }
  - name: survey_state      { depends_on: [seed] }
  - name: survey_spec       { depends_on: [seed] }
  - name: falsify
    depends_on: [survey_contract, survey_enforcement, survey_security,
                 survey_state, survey_spec]
    trigger_rule: all_done      # one failing specialist must not kill the review
```

`all_done` is load-bearing: with the default `all_success`, one specialist
failing would skip the whole tail.

These are **read-only** phases writing **disjoint** paths
(`hypotheses/<family>.jsonl`), which is the easiest possible case for 5c — but
note D2: even read-only siblings collide on git plumbing, so the provisioning
mutex is still required. "Disjoint paths" is not sufficient on its own.

## Acceptance criteria

1. `maxPhasesPerRun: 1` is **byte-identical** to today. `golden-build.test.ts`
   and every production workflow untouched.
2. `workflows/examples/parallel-review.yaml` stops being an unused example and
   becomes the concurrency fixture; `runner.test.ts` gains a two-ready-node case.
3. **B2 regression test:** a workflow where one branch pauses at an approval gate
   while a sibling succeeds ends `paused`, with the `workflow_approvals` row
   intact and resumable.
4. **S2 regression test:** two concurrent `appendPhase` calls both survive.
5. Cancel tears down in-flight sandboxes (D6).
6. k8s: two concurrent phases produce two distinct pod names (S6), or the
   backend is capped at 1 with a logged reason.

## Non-goals

- **No worktrees in 5a/5b.**
- **No cross-run parallelism change.** `concurrency.maxWorkflows` is unrelated
  and already works.
- **No per-phase tool allow/deny.** Separate, optional, and not needed by the
  review pipeline ([locked decision 9](README.md)).
