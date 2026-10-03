# 02 — The normalized AgentEvent schema (v1)

One JSONL record per line, runtime-neutral, modelled on Fabro's run events and
kept field-compatible with Harbor's ATIF trajectory where it costs nothing.

## Envelope

```ts
interface AgentEventBase {
  v: 1;
  seq: number;              // monotonic per run
  ts: string;               // ISO-8601
  event: string;            // see table
  runtime: "agentic-pi" | "claude-code" | "codex" | "opencode";
  sessionId: string;
  parentSessionId?: string; // subagents (Claude Task tool, future Pi subagents)
}
```

## Events

| `event` | Props | From Pi (agentic-pi JSONL) | From ACP (bridge) |
|---|---|---|---|
| `session.started` | `cwd, model, runtimeVersion, protocol: "pi"\|"acp", agent?` | header `{type:"session",id,cwd}` | after `session/new`; `sessionId`, `agentInfo` |
| `session.config` | `model, thinking, mode, applied:{model, thinking}` | — | config-option readback; mismatch also emits `warning` |
| `component.status` | `component` (`github`, `web-search`, `file-search`, `mcp:<name>`), `status`, `toolCount?`, `reason?` | `extension_status` | bridge: MCP start + `tools/list` count, web tools on/off |
| `skills.status` | `SkillsStatus` shape + `delivery: native\|catalogue` | `skills_status` | bridge: staged skills |
| `turn.started` / `turn.ended` | `index` | `turn_start` / `turn_end` | synthesized at message-segment boundaries (approximate) |
| `message` | `role, text, thinking?, toolCalls:[{id,name,input}], usage?, model?, error?` | `message_end` (per-message usage + cost) | chunks aggregated, flushed on `tool_call` or turn end; `agent_thought_chunk` → `thinking`. **No per-message usage** |
| `tool.started` | `toolCallId, name` (canonical), `rawName, kind?, title?, input` | `tool_execution_start` | `tool_call` (or first update carrying `rawInput`) |
| `tool.completed` | `toolCallId, name, status: completed\|failed\|cancelled\|denied, isError, output` (truncated), `locations?, diff?` | `tool_execution_end` | `tool_call_update` with terminal status |
| `tool.policy` | `toolCallId?, action: log\|block, class, pattern, command, enforcement: hook\|permission\|wrapper\|observed` | `command_policy` | hook side-channel, permission decision, PATH wrapper, or observe-only |
| `plan` | `entries[]` | — | `plan` |
| `usage` | `tokens:{input, output, cacheRead, cacheWrite, reasoning?}` (cumulative), `costUsd?, costSource: runtime\|estimated\|none, contextUsed?, contextSize?` | `usage_snapshot` (+ summed `message_end` usage) | `usage_update` → cost + context; `PromptResponse.usage` → tokens; pricing table fallback |
| `retry` | `phase: start\|end, attempt, delayMs?, error?` | `auto_retry_start/end` | — |
| `warning` | `code, message` | `sandbox_status`, `onWarn` | protocol oddities, config not applied, unknown update |
| `files.changed` | `baseRef, files:[{path, status, additions, deletions}]` | — (core may add later) | bridge `git diff` at end |
| `run.completed` | `stopReason: end_turn\|max_turns\|max_tokens\|refusal\|cancelled, finalText, turns, turnsSynthesized, endedOnToolCall, usage` | `agent_end{messages}`; `max_steps_reached` → `max_turns` | `PromptResponse.stopReason` (`max_turn_requests` → `max_turns`); `finalText` = last segment after the last tool call |
| `run.error` | `name, message, kind?: auth\|quota\|provider\|protocol\|spawn\|timeout` | `fatal_error`, synthesized assistant `stopReason:"error"` (`extractAgentError`) | JSON-RPC error, agent exit, `refusal` |

## Rules

- **`usage` is a snapshot; the last one wins.** Never sum `usage_update.used` —
  it is context occupancy, not billed tokens.
- **Canonical tool names.** Strip our own server's prefixes
  (`mcp__lastlight__`, `lastlight_`, `lastlight.`), so `github_*` classification in
  the dashboard, metrics and the evals tool counts keeps working. `rawName`
  keeps the original.
- **`sessionId` from `session.started` pins the shim's on-disk path**, the same
  way the Pi header does today (`event-shim.ts`).
- **`turnsSynthesized: true`** on ACP runs: turn counts are not comparable
  across runtimes, so scorecards label them.
- **Unknown events are ignored by consumers** and passed through to the
  transcript as `system` lines. That lets the bridge add events without a
  lockstep core release.

## Ownership

The schema, a dependency-free validator and the **stateful Pi decoder** (Pi
JSONL → AgentEvent) live in `lastlight-agent-bridge/events`. Core, the bridge
and evals then share one implementation. agentic-pi's own JSONL is
**untouched**: its fixtures are contract evidence (agentic-pi hard rule 2), and
the decoder adapts to it, not the other way round.
