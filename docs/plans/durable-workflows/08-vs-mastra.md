# 08 — Comparison with Mastra workflows (and the `~/work/mac` port)

Researched 2026-10-05 against `@mastra/core` 1.64–1.68 docs and issues, and the
Mastra port of Last Light at `~/work/mac` (active May 30 – Jun 8 2026, since
then dependency bumps only). Issue numbers are mastra-ai/mastra.

## The two programming models

| | Mastra workflows | This spike |
|---|---|---|
| Shape | **Static graph** built with `.then / .parallel / .branch / .dountil / .foreach / .map`, then `.commit()` | **Plain async function**: `run(ctx)` with `if` / `for` / `??` |
| Checkpoint unit | A graph node (`createStep`) | Every `ctx.agent / bash / step / approval / notify` call, including ones inside loops |
| Data between steps | Step `outputSchema` must equal the next `inputSchema` (bridge with `.map`) | JS values; each step result is persisted and replayed |
| Human gates | `suspend(payload)` / `run.resume({ step, resumeData })`, typed `suspendSchema` / `resumeSchema` | `ctx.approval()` = request step + run-scoped signal; decision row checked before parking |
| Loops | `.dountil(nestedWorkflow, cond)` | `reviewLoop()` / `iterate()` library functions |
| Fan-out | `.foreach(step, { concurrency })`, `.parallel` | `ctx.parallel(items, { max }, fn)` |

What the static graph cost the port in practice:

- **`~/work/mac` `build.ts` is 1,327 lines** against 233 of YAML. Every step
  takes and returns one ~35-field `buildState` (`build.ts:65-67`: no zod
  defaults allowed, or the `.then()` chain stops typing). Every step opens with
  `if (st.aborted) return st;` because routing around a node with `.branch`
  needs another schema. The `.dountil` predicate needs `inputData as BuildState`.
- **The `post_reviewer` gate was dropped.** A gate inside the review loop means
  suspending inside a nested `.dountil` workflow, which the port didn't attempt.
  In the spike it is one `if` in `reviewLoop`, and the restart-into-the-right-cycle
  case is tested.
- **Status, artifact and git plumbing make up about 40% of `build.ts`.** The
  spike hasn't ported the status checklist yet, so its 191 lines are not a
  like-for-like count.

## Durability

| | Mastra default engine | Spike (OpenWorkflow) |
|---|---|---|
| Crash mid-step | Run stays `running` until something calls `run.restart()` / `restartAllActiveWorkflowRuns()` | Lease lapses and any worker re-claims it: **measured 30.6 s** after `kill -9` |
| Crash between steps | Can re-run an already-completed step (fix PR #24853 still open) | Completed steps replay from storage; verified across processes |
| Auto-recovery at boot | Only recently wired into production `mastra start` (#24592 → #24663); evented runs not recovered (#24984 open) | Inherent: the worker claims due runs |
| Ownership / leases | None. Recovery "re-drives runs other replicas are executing" (#25579 open); the docs say to bring your own leader election | Lease + heartbeat per run |
| In-flight versioning | None documented; a resume runs whatever code is now registered under that step id | Runs record `version`; a worker only claims versions it registers |
| Long agent steps | Lost on crash, re-run from scratch | Same. Neither checkpoints *inside* a step (see README "What this does NOT fix") |
| Multi-day approvals | Works: suspended snapshots survive restarts and resume from any process | Works: tested across a restart |

Mastra's answer to real durability is the **Inngest runner** (`@mastra/inngest`,
production-ready) or **Temporal** (experimental). That is the same extra-service
trade-off `01-options.md` rejected, with Mastra layered on top.

`~/work/mac` shows the default-engine gap in production-shaped use:
`data/mac.db` still holds **3 build runs at `running` since 2026-06-07**. All runs
start fire-and-forget (`void run.start(…)`), and nothing ever calls a restart API.

## Everything around the engine

| | Mastra / `~/work/mac` | Spike |
|---|---|---|
| Agent execution | Port replaced agentic-pi + sandboxes with Mastra `Agent.generate()` in a `LocalSandbox`; egress firewall and gondolin dropped (`MIGRATION.md:147-160`) | `ctx.agent` → existing `AgentPort` → orchestrator → every sandbox backend, unchanged; the agent-runtimes ACP work slots underneath |
| Framework weight | Port had to own the Hono server (`mastra dev` EADDRINUSE, no server-start hook, `/api` prefix reserved, no CORS), plus a zod@3 peer clash | One dependency (`openworkflow`) in core; the engine package stays zod-only |
| Observability | **Strong**: Studio traces per step/agent/tool, one trace across suspend/resume, `timeTravel()` re-runs from any step | Existing dashboard + OTel span tree; step trace from `step_attempts` (06) |
| Customisation | Dynamic JSON workflows (registered agents/tools by id, no inline code); the port only had prompt/skill/context override dirs | TypeScript overlays composing built-ins (04) |
| Evals | None in the port | Evals keep driving real workflows in-process via `tick()` (06) |
| Tests | Construction smoke test only | Behaviour, restart, crash and 14-case YAML parity |

## Could Mastra be the runtime under `ctx`?

Not the default engine. Our `DurableStep` port needs "memoize this call by
name, anywhere in the function", and Mastra only checkpoints graph nodes. Making
`run(ctx)` a single Mastra step would give one checkpoint per run, so every
`ctx.agent` would re-execute after a crash.

Mastra's **Inngest** runner does have the right primitive (`step.run`
memoization), but then Inngest is the runtime and Mastra adds nothing to the
durability story.

## What to borrow

1. **Typed resume payloads.** Validate `ApprovalDecision` (and reply-gate text)
   with a schema at the signal boundary, as `resumeSchema` does.
2. **Time travel.** "Re-run run X from step Y with this override" is cheap on a
   memoized-step store: copy the step history up to Y into a new run. It is a
   strong debugging and evals feature, and worth a follow-up.
3. **One trace across suspend/resume.** Carry the run's `trace_id` in the
   durable input so spans after an approval join the original trace. The YAML
   engine already persists `trace_id`/`span_id` on `workflow_runs`.
4. **Recovery opt-out per workflow** (`autoRestartActiveRuns: false`), for
   workflows whose steps aren't idempotent.

## Verdict

Mastra's workflow layer reproduces the YAML engine's core problem in TypeScript.
Control flow lives in a builder graph, data is forced through one shared state
object, and skips are flags checked in every node. Its default engine is less
durable than both the current ledger and the spike: no leases, no automatic
reclaim until very recently, completed steps can re-run, and there is no version
pinning.

Its real strengths (Studio, time travel, typed suspend payloads) are around the
engine, not in it, and they are worth copying. The recommendation in
`07-spike-results.md` stands.
