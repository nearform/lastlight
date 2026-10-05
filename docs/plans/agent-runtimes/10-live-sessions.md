# 10 — Live sessions: steering, approvals and guardian agents

> **Status: spike done (2026-10-05), branch `spike/live-sessions`.** The code
> is throwaway-quality but works end to end on the host and on docker.
> This doc supersedes locked decision 1 in the [README](README.md) where they
> conflict.

## The constraint change

The README locked "transports stay one-way (prompt on stdin → JSONL on
stdout), which k8s requires". **That was an implementation choice, not a
k8s limit**, and it is now dropped:

- The k8s backend is one-way only because it follows the pod log
  (`sandbox/k8s/log-stream.ts`) and passes the prompt as a file.
- Pods **already call home** with a per-run bearer token:
  `artifact-upload-route.ts`, `skill-bundle-route.ts`, `agent-context-route.ts`.
- Cilium already allows that path: `harnessEgressRule()` in `egress-policy.ts`.
- Docker's `docker exec -i` has had an open stdin all along.

Two-way sessions are worth having for their own sake:

- **Steering:** add context mid-run instead of kill-and-retry.
- **Approvals:** individual tool calls (push, publish, out-of-scope edits) wait
  for a decision.
- **Guardian agents:** a cheap model watches the event stream and can steer,
  deny or abort.

## Control-channel contract (runtime-neutral)

Commands go into the session as JSONL. Records come out on the existing event
stream.

| In (command) | Out (record) | Pi (agentic-pi) | ACP |
|---|---|---|---|
| `{"type":"prompt","message"}` (first line) | normal Pi stream | `session.prompt` | `session/prompt` |
| `{"type":"steer","message"}` | `control_ack` | `session.steer()` — delivered at the next turn boundary | **none.** acpx `mode:"steer"` just queues a turn |
| `{"type":"follow_up","message"}` | `control_ack` | `session.followUp()` | a new `session/prompt` after the turn |
| `{"type":"abort","reason"}` | `control_abort`, then `agent_end stopReason=aborted` | `session.abort()` | `session/cancel` |
| `{"type":"decide","id","allow","reason","input?"}` | answers `approval_requested{id,toolName,input}` → `approval_resolved` | async `tool_call` hook: block with **reason**, or **patch input** | `session/request_permission`: allow / reject **with no reason and no patch** |

Approvals **fail closed**: a timeout, a closed channel or an abort denies the
tool call.

## What was built

**agentic-pi**
- `src/control.ts`: the parser, `ApprovalBroker` (fail-closed), the `approvalGate`
  Pi extension, and `pumpControl`.
- CLI flags `--control stdin`, `--approve-tools a,b|*`, `--approval-timeout`.
- `run({ control, approveTools })` for in-process callers.
- Default runs are unchanged: no flag means nothing is registered, so the JSONL
  fixtures stay byte-identical.
- 9 unit tests in `test/control.test.ts`.

**core**
- `DockerSandboxDriver.runAgent({ control: { attach(send), approveTools } })`
  in `sandbox/docker.ts`, behind an optional param.

**Spike scripts** (`apps/server/scripts/spike/`)
- `live-session.ts`: a guardian over agentic-pi, on the host or `--docker`, with
  `--hard-scope` and `--llm-judge`.
- `acpx-live.mjs` + `stub-mcp.mjs`: the same guardian over acpx. These need the
  scratch install in `/tmp/acpx-spike`, i.e. `npm i acpx
  @agentclientprotocol/claude-agent-acp pi-acp @earendil-works/pi-coding-agent
  @modelcontextprotocol/sdk`.

## S1 results — agentic-pi, two-way (claude-haiku-4-5)

Task: fix a bug in `src/`, also edit README, commit and `git push`. The
guardian allows only `src/` and denies push.

| Run | Backend | Result |
|---|---|---|
| steer + deny | host | Push denied with a reason; the agent carried on and finished. README steer **landed 2 tool calls late**; the agent had already committed README and then had to undo it. $0.035 |
| abort on budget | host | `abort` → `agent_end stopReason=aborted` about 100 ms later, exit 0; the in-flight edit still completed. $0.012 |
| steer + deny | docker (`exec -i`, vendored bundle) | Same wire, works unchanged. The steer arrived, but README had **already been committed in the same batch**, so the agent's `git checkout` did nothing → **README shipped**. $0.036 |
| `--hard-scope` | docker | write/edit gated through approvals; README edit **denied before it ran**; commit contains `src/math.js` only. $0.034 |
| `--llm-judge` | host | A Haiku guardian judged each bash call, adding about **1 s per gated call**; it allowed reads, tests and local commits. $0.030 |
| guardian crashed (accidental) | host | Every approval **timed out → denied** (fail closed); the agent kept going. |

Core compatibility: replaying the transcripts through `RunResultAccumulator`
and `AgenticShim` works. Both ignore unknown record types, and cost and turns
are correct. Known follow-ups:
- The shim doesn't render approvals or steers yet.
- An aborted run's `finalText` is mid-run prose; it must classify as aborted,
  not success.

## S2 results — the same guardian over ACP via embedded acpx 0.19.4

| | Claude Code (`claude-agent-acp` 0.81) | Pi (`pi-acp` 0.0.33) |
|---|---|---|
| Event richness | `text_delta`, `tool_call` (kind, title, rawInput), `status` | same shape, sparser |
| Usage / **USD cost** | cumulative tokens + **USD** (`status.usage.cost`) ✔ | **none** ✘ |
| Permission requests | **bash only**; edits are never asked, so the guardian can't gate them | **none at all**; `git push` ran unguarded ✘ |
| Deny feedback | reject carries **no reason**; the agent stopped and asked the human | n/a |
| MCP tool injection | ✔ (`mcp__lastlight__github_add_issue_comment`, permission-gated) | ✘ (Pi has no MCP) |
| Mid-turn steer | ✘ `mode:"steer"` queued; it never landed mid-turn | ✘ same |
| Cancel | ✔ clean, about 1 s, `stopReason: cancelled`; **usage on a cancelled turn reported as 0** | not measured |
| Session start | about 0.4 s | about 28 s (cold) |
| What actually runs | Claude Code | **vanilla `pi --mode rpc`**: none of agentic-pi's GitHub tools, command policy, gate-timeout, cost or telemetry |

## Conclusions

1. **Keep agentic-pi; don't adopt omnigent, and don't route Pi through ACP.**
   - agentic-pi on Pi's public SDK is the **strongest** controllable runtime we
     measured. It is the only one with true mid-run steer, deny-with-reason,
     input rewriting (e.g. clamping a command), native cost, and a fail-closed
     gate.
   - Omnigent's Pi path is weaker (drops cost, fails open, no clamp).
   - `pi-acp` loses everything agentic-pi adds.
   - [`09-risks.md`](09-risks.md) item 14 (route agentic-pi through `pi-acp`)
     should be closed as **no**.
2. **Steer is advisory; approvals are enforcement.**
   - Steering lands at a turn boundary, after a batch that may already have
     done the damage.
   - Anything that must not happen goes through a synchronous approval:
     scope, publish, spend.
   - A guardian uses steer for nudges and `decide` for rules.
3. **ACP is a lower common denominator for control.**
   - It has no steer, no deny reason, no input patch, and its permission
     coverage depends on the agent (edits are invisible on Claude, nothing at
     all on Pi).
   - For Claude Code/Codex runtimes, the guardian must fall back to native
     hooks (e.g. Claude's `PreToolUse`) or `git diff` post-checks.
   - Capability matrix rows to add to [`06`](06-config-and-capabilities.md):
     `steer`, `approval.reason`, `approval.patch`, `approval.coverage`.
4. **acpx (open question 3 in #434):**
   - Embedding works. `createAcpRuntime` + `onPermissionRequest` +
     `mcpServers` + `cancel` gave a working ACP client in about 150 lines.
   - Its value is the agent registry and launch resolution, not control. Its
     `steer` mode is a queue.
   - Recommendation: **embed acpx for the non-Pi runtimes** (P3), behind our
     own `AgentRuntime` seam so its pre-1.0 churn stays contained.

## S3 — one seam: ACP runtimes *inside* agentic-pi (decided 2026-10-05)

Decision: no runtime fork in core. **agentic-pi is the only thing lastlight
runs**: `agentic-pi run --runtime pi|claude|codex|opencode`. The Pi path is
unchanged; the others run over ACP via embedded acpx (`src/acp-runner.ts`) and
emit **the same record shapes** the Pi path does. Hard rule 1 is relaxed to
"the Pi path never uses MCP" (`packages/agentic-pi/CLAUDE.md`).

```
lastlight core ──(argv + JSONL out + control JSONL in)──► agentic-pi run --runtime X
                                                          ├─ pi                     → Pi SDK (native tools, steer, patch)
                                                          └─ claude|codex|opencode  → acpx/runtime ⇄ ACP adapter
                                                                                         └─ MCP ⇄ agentic-pi mcp-github
```

What was built (spike quality):
- **`src/acp-runner.ts`:**
  - an ACP→Pi translator (assistant messages with `toolCall` blocks, then
    `tool_execution_start/end`, `agent_end` and `usage_snapshot`);
  - a `runtime_status` capability record;
  - an isolated config home per runtime (`CLAUDE_CONFIG_DIR` …) — the first
    unisolated Claude run loaded 45 of the operator's personal commands;
  - AGENTS.md delivered as an appended system prompt;
  - the model mapped from `provider/id`;
  - approvals and command policy enforced through `onPermissionRequest`;
  - the control channel mapped (steer/follow_up are queued, abort cancels).
- **Deny reasons, recovered:** ACP rejections carry no reason, so Claude stops
  and asks a human. agentic-pi queues the reason as a follow-up turn and the
  run carries on (`approvalReason: "follow-up"`).
- **`src/mcp-github.ts` (`agentic-pi mcp-github`):** a generic adapter that
  serves the existing Pi `ToolDefinition`s over stdio MCP, with the same
  profile gate. There is **no tool fork**, because TypeBox parameters are
  already JSON Schema and the GitHub tools never touch the extension context.
- 2 translator tests in `test/acp-runner.test.ts`.

Same guardian script, same flags, same fake GitHub API, haiku-4-5:

| | `--runtime pi` | `--runtime claude` |
|---|---|---|
| Fix committed, README kept out | ✔ | ✔ (after a queued steer turn) |
| `git push` denied, run carries on | ✔ reason inline | ✔ reason as a follow-up turn |
| `github_add_issue_comment` hit the API | ✔ native tool | ✔ via `mcp-github` |
| Cost | $0.046 | $0.063 (native USD) |
| Core replay (`RunResultAccumulator` + `AgenticShim`, unchanged) | ok, 14/14 tool pairs, cost matches | ok, 15/15 tool pairs, cost matches |

Known gaps in the ACP path:
- Usage is one cumulative figure, attached to the final message.
- Claude edits never reach `onPermissionRequest`, so scope enforcement needs
  Claude's native `PreToolUse` hook (inside agentic-pi) or a `git diff`
  post-check.
- `thinking`, skills, gate-timeout and `--max-steps` are not mapped yet.
- Codex and OpenCode have not been run.
- Adapters are resolved from PATH or `npx`; images must bake them in, and the
  Claude licensing question stands.

**rivet sandbox-agent, evaluated as an acpx alternative: no.**
- It is a 25 MB Rust daemon. Its "embedded" TS mode still spawns that daemon
  and talks to it over HTTP.
- It drives the **same ACP adapters**, at older fallback pins.
- It has no steering, and permission replies are once/always/reject (no
  reason).
- Cancel only works by destroying the session.
- There is no cost roll-up; `usage_update` is passed through raw.
- Its "resume" re-pastes the last 50 events as text.
- The last npm release was 2026-03 (0.5.0-rc.3).
- It solves none of the four gaps above and adds a daemon.

## Where it slots into the rollout

- **P1.5 — Live sessions (agentic-pi).** After the P1 seam lands:
  - `SessionControl` on `AgentRuntime` / `Sandbox.execAgent` (stdin for
    docker/smol/none);
  - shim rendering for `approval_*` / `control_*`;
  - aborted-run classification;
  - a `guardian:` phase config (rules first, LLM judge optional);
  - a dashboard "steer / abort" control for maintainers.
- **k8s (P5):** an `/internal/sandbox-control` WebSocket on the shared Hono app.
  - It authenticates with the existing per-run token, and the in-pod
    agentic-pi dials out (the omnigent `omnigent host` pattern).
  - Pod logs stay the event source of truth; only commands travel over the
    socket.
- **ACP runtimes (P3/P4):** the same contract, with documented degradations
  from the table above, asserted in the conformance suite.

## Open questions

- Steer latency: can agentic-pi deliver a steer **between tool calls** within
  a batch, or only at turn end? Today Pi delivers it "after the current
  assistant turn finishes executing its tool calls".
- Should the guardian see `tool_execution_start` before execution? Today only
  gated tools pause. Gating `*` costs about 1 ms per call with rules and about
  1 s with an LLM judge.
- Who may steer in production: maintainers only (reuse the
  OWNER/MEMBER/COLLABORATOR gate), and never from Slack until it has one (see
  the Slack maintainer-gate gap).
