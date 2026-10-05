# 10 — Live sessions: graceful cancel, steering, and the control seam

> **Status (2026-10-05): design settled, spike done (`spike/live-sessions`,
> throwaway quality, not for merge as-is).** The MVP scope below comes from
> the design review recorded in the [README](README.md) (decisions 2–10). The
> spike results further down are the evidence for it.

## The constraint change

The original README locked "transports stay one-way (prompt on stdin → JSONL
on stdout), which k8s requires". **That was an implementation choice, not a
k8s limit**, and it is dropped:

- The k8s backend is one-way only because it follows the pod log
  (`sandbox/k8s/log-stream.ts`) and passes the prompt as a file.
- Pods **already call home** with a per-run bearer token
  (`artifact-upload-route.ts`, `skill-bundle-route.ts`,
  `agent-context-route.ts`), and Cilium already allows that path
  (`harnessEgressRule()` in `egress-policy.ts`).
- Docker's `docker exec -i` and smol's `exec -i` have had an open stdin all
  along.

## MVP scope

**In:**

1. **Graceful cancel.** The admin UI's existing "Cancel run"
   (`POST /workflow-runs/:id/cancel`) sends `{"type":"abort"}` to the live
   session first and waits up to 10 s for `agent_end stopReason=aborted`
   before the existing `docker kill` path. The phase records `cancelled` with
   its real cost, and the transcript ends cleanly. Today the cancel is a hard
   kill: the transcript stops mid-line and the phase's cost is lost. It also
   only finds docker containers, so in-process and smol runs aren't covered.
2. **Steering from the admin UI.** A "Send message" control on a running
   phase sends `{"type":"steer"}`. The message shows *sent → acked
   (`control_ack`) → landed (the turn it was injected at)*, carries the actor
   (`actorFromContext`, #205), and appears in the transcript as a distinct
   record ("↳ steer from <actor>"), not as a fake user message. A steer after
   `agent_end` is rejected and reported as undelivered.
3. **The control seam**, built and documented with no rules on it (below).

**Out (separate issues, or not planned):**

- Steering from issue/PR comments or Slack. Not planned for now; Slack also
  has no maintainer gate.
- A `follow_up` UI verb, and a "stop this phase but continue the workflow"
  action (it would hand downstream phases a partial output with no signal).
- Guardian rules and tool approvals (`decide`). They come back together in a
  separate issue once an LLM-judge use case exists, with an eval behind it.
  Approving `git push` is not an approval step.
- A `lastlight workflow steer` CLI command, until the UI flow is proven.
- k8s control (a dial-out `/internal/sandbox-control` WebSocket). No
  production runs on k8s yet.

**Static limits are a separate prerequisite**, not live-session work. Turn
cap (`--max-steps`, exists), a per-phase `--max-cost-usd`, a repeated-failure
breaker and an `edit_scope` command-policy class all live in agentic-pi. They
need no channel and work on k8s. These are what the spike's "rules-only
guardian" would have done, and none of them needs core.

## The seam

```ts
// packages/workflow-engine/src/ports — runtime-agnostic, no core edge
interface SessionControl {
  readonly capabilities: { steer: boolean; abort: boolean; approvals: boolean };
  steer(message: string, actor: string): Promise<ControlAck>; // rejects if the phase already ended
  abort(reason: string, actor: string): Promise<void>;        // grace then hard kill is the adapter's job
}
interface SessionObserver {                                    // a future guardian; tests use it today
  onEvent(record: unknown, control: SessionControl): void;
}
```

- **Types** live in `lastlight-workflow-engine` ports, so the boundary
  invariant holds and the Fake sandbox can implement them.
- **Adapters:** docker, smol and in-process return a `SessionControl` from
  `runAgent`; k8s returns none (`control: false`). The Fake sandbox implements
  it so orchestrator tests drive steer and abort deterministically.
- **Registry:** an in-memory `executionId → SessionControl` map in the
  orchestrator, cleared at `agent_end`. The admin API's steer and cancel
  routes look sessions up there. The `agent` service runs the harness, the
  admin API and the orchestrator in one process, so no cross-process bus is
  needed.
- **Observers** are an `observers: SessionObserver[]` option on the executor,
  set from code only. There is no `guardian:` YAML key until a guardian
  exists.
- **Approvals:** `capabilities.approvals` is reported, but `decide()` is added
  together with its first user.
- **Always on:** core always passes `--control stdin` (docker, smol) or
  `run({control})` (in-process). agentic-pi without the flag behaves exactly
  as today, so external npm consumers and existing fixtures are unaffected.
  New fixtures cover the control framing (agentic-pi hard rule 2).
- **Stdin EOF** means "no more commands", not abort. If the server dies,
  `docker exec` dies with it anyway. Approvals, once they exist, still fail
  closed on EOF.

## Control-channel contract (runtime-neutral)

Commands go into the session as JSONL. Records come out on the existing event
stream as new members of agentic-pi's `EmitterRecord` union. Commands are an
exported `ControlCommand` union.

| In (command) | Out (record) | Pi (agentic-pi) | ACP |
|---|---|---|---|
| `{"type":"prompt","message"}` (first line) | normal Pi stream | `session.prompt` | `session/prompt` |
| `{"type":"steer","message"}` | `control_ack` | `session.steer()`, delivered at the next turn boundary | **none.** acpx `mode:"steer"` just queues a turn |
| `{"type":"follow_up","message"}` | `control_ack` | `session.followUp()` | a new `session/prompt` after the turn |
| `{"type":"abort","reason"}` | `control_abort`, then `agent_end stopReason=aborted` | `session.abort()` | `session/cancel` |
| `{"type":"decide","id","allow","reason","input?"}` *(deferred)* | answers `approval_requested{id,toolName,input}` → `approval_resolved` | async `tool_call` hook: block with **reason**, or **patch input** | `session/request_permission`: allow / reject **with no reason and no patch** |

`runtime_status{capabilities}` is emitted once at the start, so the UI can
label a steer on an ACP runtime as "queued until the current turn ends"
instead of pretending it lands mid-turn.

## Spike evidence

### S1 — agentic-pi, two-way (claude-haiku-4-5)

Task: fix a bug in `src/`, also edit README, commit and `git push`. The
guardian allows only `src/` and denies push. (Push gating was the spike's
demo, not a product requirement.)

| Run | Backend | Result |
|---|---|---|
| steer + deny | host | Push denied with a reason; the agent carried on and finished. README steer **landed 2 tool calls late**; the agent had already committed README and then had to undo it. $0.035 |
| abort on budget | host | `abort` → `agent_end stopReason=aborted` about 100 ms later, exit 0; the in-flight edit still completed. $0.012 |
| steer + deny | docker (`exec -i`, vendored bundle) | Same wire, works unchanged. The steer arrived, but README had **already been committed in the same batch** → README shipped. $0.036 |
| `--hard-scope` | docker | write/edit gated; README edit **denied before it ran**; commit contains `src/math.js` only. $0.034 |
| `--llm-judge` | host | A Haiku guardian judged each bash call, adding about **1 s per gated call**. $0.030 |
| guardian crashed (accidental) | host | Every approval **timed out → denied** (fail closed); the agent kept going. |

What this established:

- **Steer is advisory; prevention is enforcement.** A steer lands after a
  batch that may already have done the damage, so anything that must not
  happen is a static rule in the sandbox (decision 2), not a steer. That is
  why the UI shows *where* a steer landed.
- **Abort is fast and clean** (≈100 ms), which is what makes graceful cancel
  worth having.
- **Core compatibility:** replaying the transcripts through
  `RunResultAccumulator` and `AgenticShim` works unchanged (both ignore
  unknown record types; cost and turns are correct). Still to do: render the
  control records in the shim, and classify an aborted run as `cancelled`,
  not success (its `finalText` is mid-run prose).

### S2 — the same guardian over ACP via embedded acpx 0.19.4

| | Claude Code (`claude-agent-acp` 0.81) | Pi (`pi-acp` 0.0.33) |
|---|---|---|
| Event richness | `text_delta`, `tool_call` (kind, title, rawInput), `status` | same shape, sparser |
| Usage / **USD cost** | cumulative tokens + **USD** (`status.usage.cost`) ✔ | **none** ✘ |
| Permission requests | **bash only**; edits are never asked | **none at all**; `git push` ran unguarded ✘ |
| Deny feedback | reject carries **no reason**; the agent stopped and asked the human | n/a |
| MCP tool injection | ✔ (`mcp__lastlight__github_add_issue_comment`) | ✘ (Pi has no MCP) |
| Mid-turn steer | ✘ queued; never landed mid-turn | ✘ same |
| Cancel | ✔ clean, about 1 s, `stopReason: cancelled`; **usage on a cancelled turn reported as 0** | not measured |
| Session start | about 0.4 s | about 28 s (cold) |
| What actually runs | Claude Code | **vanilla `pi --mode rpc`**: none of agentic-pi's GitHub tools, command policy, gate-timeout, cost or telemetry |

### S3 — ACP runtimes *inside* agentic-pi

`agentic-pi run --runtime claude` via `src/acp-runner.ts` (embedded acpx)
emitting Pi-shaped records, plus `agentic-pi mcp-github` serving the existing
Pi `ToolDefinition`s over stdio MCP with the same profile gate. Same guardian
script, same flags, same fake GitHub API, haiku-4-5:

| | `--runtime pi` | `--runtime claude` |
|---|---|---|
| Fix committed, README kept out | ✔ | ✔ (after a queued steer turn) |
| `git push` denied, run carries on | ✔ reason inline | ✔ reason as a follow-up turn |
| `github_add_issue_comment` hit the API | ✔ native tool | ✔ via `mcp-github` |
| Cost | $0.046 | $0.063 (native USD) |
| Core replay (`RunResultAccumulator` + `AgenticShim`, unchanged) | ok, 14/14 tool pairs, cost matches | ok, 15/15 tool pairs, cost matches |

The first unisolated Claude run loaded 45 of the operator's personal
commands, which is why config isolation is a parity contract (README
decision 12).

## Open questions (for after the MVP)

- Can agentic-pi deliver a steer **between tool calls** within a batch? Today
  Pi delivers it after the current assistant turn finishes its tool calls.
- When a guardian exists: should it see `tool_execution_start` before
  execution? Gating `*` costs about 1 ms per call with rules and about 1 s with
  an LLM judge.
