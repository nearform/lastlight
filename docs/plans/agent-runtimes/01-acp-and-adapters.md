# 01 — ACP and the three adapters

State as of **2026-10-03**: ACP spec **v1.10.2**, TypeScript SDK
`@agentclientprotocol/sdk` **1.7.0** (2026-10-02). Facts not confirmed against
source or official docs are marked **[UNVERIFIED]** — the P0 spike settles each.

## ACP in one paragraph

JSON-RPC 2.0 over the agent's stdio. The client calls `initialize`, then
`session/new {cwd, mcpServers}`, then `session/prompt {sessionId, prompt}`. While
the prompt runs, the agent streams `session/update` notifications and may call
back into the client (`session/request_permission`, optionally `fs/*` and
`terminal/*` if the client advertised them). The prompt resolves with a
`stopReason`. `session/cancel` is a notification.

## Spec surface we rely on

| Area | Shape | Status |
|---|---|---|
| `initialize` | `protocolVersion` (1), `clientCapabilities {fs, terminal}` → `agentCapabilities {loadSession, promptCapabilities, mcpCapabilities, sessionCapabilities}`, `authMethods`, `agentInfo` | Stable |
| `session/new` | `cwd` (absolute), `mcpServers[]` (stdio: `name, command, args, env[{name,value}]`), `_meta` → `sessionId`, `configOptions[]` | Stable |
| `session/prompt` | → `stopReason ∈ end_turn, max_tokens, max_turn_requests, refusal, cancelled` | Stable |
| `session/update` | `user_message_chunk`, `agent_message_chunk`, `agent_thought_chunk`, `tool_call`, `tool_call_update`, `plan`, `available_commands_update`, `current_mode_update`, `config_option_update`, `session_info_update`, `usage_update` | Stable |
| `usage_update` | `{used, size, cost?:{amount, currency}}` — `used`/`size` are **context-window occupancy, not billed tokens**; `cost` is **cumulative** | Stable since 2026-06-05 |
| `PromptResponse.usage` | `{totalTokens, inputTokens, outputTokens, thoughtTokens?, cachedReadTokens?, cachedWriteTokens?}` | **Draft RFD**; per-turn vs cumulative unresolved |
| Tool calls | `toolCallId, title, kind (read/edit/delete/move/search/execute/think/fetch/…), status (pending/in_progress/completed/failed), content[], locations, rawInput, rawOutput` | Stable |
| `session/request_permission` | `{toolCall, options:[{optionId, kind: allow_once/allow_always/reject_once/reject_always}]}` → selected option or `cancelled`. **No free-text reason, and no way to rewrite the tool input** | Stable |
| Config options | `session/set_config_option {configId, value}`; categories `mode`, `model`, `thought_level`, … Supersedes `session/set_mode` | Stable |
| `session/set_model` | Adapters expose `unstable_setSessionModel` | Unstable |

## Adapters

| | Claude Code | Codex | OpenCode |
|---|---|---|---|
| Package / bin | `@agentclientprotocol/claude-agent-acp` (was `@zed-industries/claude-code-acp`), bin `claude-agent-acp`; bundles the Claude Agent SDK + native CLI (`CLAUDE_CODE_EXECUTABLE` overrides) | `@agentclientprotocol/codex-acp` (moved from `zed-industries/codex-acp`); bundles a Codex binary (`CODEX_PATH` overrides) | `opencode-ai`, run as `opencode acp` (native) |
| License | Adapter Apache-2.0; **bundled Claude Code binary is proprietary** | Apache-2.0 | MIT |
| API-key auth | `ANTHROPIC_API_KEY`; gateway via `ANTHROPIC_BASE_URL` | `OPENAI_API_KEY` / `CODEX_API_KEY`; may need an explicit `authenticate` call **[UNVERIFIED]** | provider env vars (models.dev conventions) |
| Model | config option `model` > `ANTHROPIC_MODEL` > settings | config option `model`, or `CODEX_CONFIG` JSON | config option `model` as `providerID/modelID` |
| Thinking | config option `effort` (`thought_level`) | config option `reasoning_effort` | config option `effort` |
| Usage / cost | `usage_update.cost` = `total_cost_usd` (cumulative); `PromptResponse.usage` accumulated tokens. **Full fidelity** | context size only, **no cost**; token totals via `_meta.quota.token_count` **[UNVERIFIED semantics]** | `usage_update.cost` reported; per-turn tokens reported |
| Permission modes | `default`, `acceptEdits`, `plan`, `dontAsk`, `bypassPermissions` | `read-only`, `workspace-write`, `agent`, `agent-full-access` (+ approval policy via config) | asks only where its `permission` config says `ask` — default config mostly allows |
| Pre-tool hook | settings `PreToolUse` command hooks (deny + reason, `updatedInput`) | none known; exec-policy rules **[UNVERIFIED]** | plugin `tool.execute.before` **[UNVERIFIED API]** |
| Instructions | CLAUDE.md via `settingSources`; or `_meta.claudeCode.options.systemPrompt.append` | AGENTS.md from git root down + `$CODEX_HOME/AGENTS.md` — **won't see our workspace-root AGENTS.md above the git root [UNVERIFIED]** | AGENTS.md + config `instructions: [paths]` |
| Skills | SDK `skills` option **[UNVERIFIED shape]** | `$CODEX_HOME/skills` **[UNVERIFIED]** | config-dir skills **[UNVERIFIED]** |
| MCP via `session/new` | yes | yes | yes |
| Max turns | `_meta.claudeCode.options.maxTurns` → `max_turn_requests` | none known | agent steps **[UNVERIFIED]** |
| Extras | `_meta.claudeCode.options.{disallowedTools, settingSources, settings}`; `emitRawSDKMessages` exposes the SDK `result` (`total_cost_usd`, `num_turns`) | `CODEX_CONFIG` | `OPENCODE_CONFIG_CONTENT` **[UNVERIFIED]** |

Also exists: **`pi-acp`** (an ACP adapter for bare Pi). See
[`09-risks.md`](09-risks.md) item 14 for why agentic-pi does not route through
it yet.

## Sources

- ACP: [schema](https://agentclientprotocol.com/protocol/schema),
  [prompt turn](https://agentclientprotocol.com/protocol/prompt-turn),
  [tool calls](https://agentclientprotocol.com/protocol/tool-calls),
  [config options](https://agentclientprotocol.com/protocol/session-config-options),
  [session usage stabilized](https://agentclientprotocol.com/announcements/session-usage-stabilized),
  [session usage RFD](https://agentclientprotocol.com/rfds/session-usage),
  [end-turn token usage RFD](https://agentclientprotocol.com/rfds/end-turn-token-usage)
- Adapters: [claude-agent-acp](https://github.com/agentclientprotocol/claude-agent-acp),
  [codex-acp](https://github.com/agentclientprotocol/codex-acp),
  [OpenCode ACP](https://opencode.ai/docs/acp/)
