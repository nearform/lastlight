# Pluggable agent runtimes — agentic-pi, Claude Code, Codex, OpenCode

> **Status: design only (2026-10-03).** No code has been written. This folder
> is the design; implementation starts at the P0 spike in
> [`08-rollout.md`](08-rollout.md).

## Problem

Last Light runs exactly one coding agent: **agentic-pi**. The engine's
`AgentPort` (`packages/workflow-engine/src/ports/ports.ts`) is already
runtime-neutral, but everything below it is agentic-pi-shaped:

- every sandbox adapter hand-builds agentic-pi's argv/options;
- every downstream consumer (result accumulator, transcript shim, telemetry
  spans) switches on **Pi event names**;
- the GitHub tools, the command policy and the bash gate timeout are Pi
  extensions living inside agentic-pi.

We want Claude Code, Codex and OpenCode to plug in as alternative runtimes —
selectable per phase, indistinguishable to the rest of core, and **runnable
from the evals harness so harnesses can be compared head-to-head**.

## Inspiration: Fabro

[Fabro](https://docs.fabro.sh/core-concepts/agents) gives each workflow node a
`backend="api"|"acp"`. The ACP backend runs any
[Agent Client Protocol](https://agentclientprotocol.com) stdio agent inside the
run's sandbox; Fabro normalizes everything into one run-event stream
(`agent.message`, `agent.tool.started`, `agent.tool.completed`, …) and tracks
file changes with `git diff` for agents whose tools it can't see. ACP is the
lever: Claude Code, Codex, OpenCode, Gemini CLI and Pi all speak it (natively
or via an adapter), so **one client replaces N bespoke integrations**.

## Locked decisions

1. **Wire: ACP via an in-sandbox bridge.** *(2026-10-05: the "one-way" half
   of this is dropped — see [`10-live-sessions.md`](10-live-sessions.md).)* A new `lastlight-agent-bridge` runs
   *inside* the sandbox as the ACP client and emits Last Light's normalized
   JSONL on stdout. Sandbox transports stay one-way (prompt on stdin → JSONL on
   stdout), which k8s requires — it only has the pod log stream.
2. **GitHub tools: extracted to an MCP server for non-Pi runtimes.** The tool
   code is refactored into a Pi-free core inside agentic-pi; the bridge serves
   it over stdio MCP, profile-gated at registration. agentic-pi itself stays
   MCP-free (its hard rule 1).
3. **Auth: API keys only** for the first cut (`ANTHROPIC_API_KEY`,
   `OPENAI_API_KEY`, …). Subscription OAuth is P6.
4. **Every runtime is usable from `apps/evals`.** Runtime is a first-class arm
   axis next to model, and a harness comparison is the acceptance gate for
   each new runtime — not an afterthought.

> **2026-10-05 — superseded in part.** The ACP client now lives *inside*
> agentic-pi (`agentic-pi run --runtime claude|codex|opencode`) instead of a
> separate `lastlight-agent-bridge`, and emits Pi-shaped records, so core keeps
> one seam. See [`10-live-sessions.md`](10-live-sessions.md) S3.

## Architecture

```
workflow phase
  └─ AgentPort.runAgent (engine, unchanged)
       └─ executeAgent → runAgentIn (core)
            ├─ resolve AgentRuntime (runtime: key on the phase, else runtimes.default)
            ├─ agentic-pi on none/gondolin ──► runtime.runInProcess() ─┐
            └─ otherwise ──► Sandbox.execAgent(runtime.buildInvocation())│
                              │  docker exec / smol exec / k8s pod / host child
                              ▼                                          │
                 ┌──────────── inside the sandbox ─────────────┐         │
                 │ agentic-pi run   (Pi JSONL)                 │         │
                 │   — or —                                    │         │
                 │ lastlight-agent-bridge run --runtime X      │         │
                 │   ├─ ACP client ⇄ claude-agent-acp |        │         │
                 │   │               codex-acp | opencode acp  │         │
                 │   │      └─ MCP ⇄ bridge mcp-github         │         │
                 │   └─ emits AgentEvent JSONL                 │         │
                 └─────────────────────────────────────────────┘         │
                              │ stdout lines                             │
                              ▼                                          ▼
                 runtime.createDecoder()  ──►  AgentEvent stream
                              ├─ RunResultAccumulator → ExecutionResult
                              ├─ AgenticShim → same envelope transcripts (dashboards unchanged)
                              └─ AgentSpanTree → OTel / Phoenix
```

## Files

| File | What it covers |
|---|---|
| [`00-current-coupling.md`](00-current-coupling.md) | Evidence: the call path and every place core assumes agentic-pi |
| [`01-acp-and-adapters.md`](01-acp-and-adapters.md) | ACP spec state (Oct 2026) and the three adapters, with [UNVERIFIED] markers |
| [`01b-prior-art.md`](01b-prior-art.md) | Off-the-shelf survey (acpx, sandbox-agent, Harbor, Fabro, …) and the build/adopt decision |
| [`02-agent-event-schema.md`](02-agent-event-schema.md) | The normalized `AgentEvent` v1 schema and its Pi / ACP mappings |
| [`03-runtime-seam.md`](03-runtime-seam.md) | The `AgentRuntime` interface in core and the `Sandbox.execAgent` split |
| [`04-bridge.md`](04-bridge.md) | `lastlight-agent-bridge`: CLI, run flow, command policy, cost, packaging |
| [`05-github-mcp.md`](05-github-mcp.md) | Extracting the GitHub tools under the import-boundary invariants |
| [`06-config-and-capabilities.md`](06-config-and-capabilities.md) | Config surface, model/thinking translation, capability matrix |
| [`07-evals-harness-comparison.md`](07-evals-harness-comparison.md) | Runtimes in `apps/evals`: arm axis, mock + metric parity, fairness |
| [`08-rollout.md`](08-rollout.md) | Phases P0–P6 with acceptance criteria |
| [`09-risks.md`](09-risks.md) | Risks and open questions |
| [`10-live-sessions.md`](10-live-sessions.md) | **Two-way sessions** — steering, approvals, guardian agents; spike results (supersedes "one-way" in locked decision 1) |

## Glossary

- **Runtime** — the coding-agent harness a phase runs (`agentic-pi`,
  `claude-code`, `codex`, `opencode`). Orthogonal to **model** and to
  **sandbox backend** (docker / smol / k8s / none / gondolin).
- **ACP** — Agent Client Protocol: JSON-RPC over stdio between a *client*
  (editor, orchestrator — here the bridge) and an *agent*.
- **Adapter** — a process that speaks ACP on behalf of an agent that doesn't
  natively (`claude-agent-acp`, `codex-acp`). OpenCode speaks it natively
  (`opencode acp`).
- **Bridge** — `lastlight-agent-bridge`, the in-sandbox ACP client that turns
  prompt-on-stdin into `AgentEvent`-JSONL-on-stdout.
- **AgentEvent** — Last Light's normalized, runtime-neutral event (see
  [`02`](02-agent-event-schema.md)).
