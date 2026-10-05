# 04 — `lastlight-agent-bridge`

> **2026-10-05: no separate package.** The ACP client lives inside agentic-pi
> (`src/acp-runner.ts`, embedded acpx), along with `agentic-pi mcp-github` and
> `agentic-pi hook claude-pretool`. Read "bridge" below as "agentic-pi's ACP
> path". The run flow, isolation and cost notes still apply. Claude images:
> a host-side derived image ([README](README.md) decision 19).

## Identity and boundaries

- `packages/agent-bridge`, npm `lastlight-agent-bridge`, bin
  `lastlight-agent-bridge`.
- Dependencies: `agentic-pi` (`workspace:*`, for the GitHub tool core, command
  policy and gate clamp), `@agentclientprotocol/sdk`,
  `@modelcontextprotocol/sdk`, and the **exact-pinned** adapters
  (`@agentclientprotocol/claude-agent-acp`, `@agentclientprotocol/codex-acp`,
  `opencode-ai`).
- New rule in `scripts/lint-import-boundaries.mjs`: **agent-bridge never imports
  `lastlight-*`**. Core and evals depend on it for the schema and the Pi
  decoder. That is the same edge shape as core → agentic-pi.

## CLI

```
lastlight-agent-bridge run --runtime claude-code|codex|opencode --model <provider/id>
    [--thinking L] [--profile P] [--skill DIR]... [--context-file ../AGENTS.md]
    [--gate-timeout N] [--max-turns N] [--web-search] [--github-api-base-url URL]
    [--agent-command '<json argv>']           # prompt on stdin → AgentEvent JSONL on stdout
lastlight-agent-bridge mcp-github --profile P --cwd DIR [--api-base-url URL]   # stdio MCP server
lastlight-agent-bridge hook claude-pretool    # Claude PreToolUse command hook
lastlight-agent-bridge doctor --runtime X     # binary, version, initialize handshake, auth methods
```

Exit codes mirror agentic-pi: 0 ok, 1 agent failure, 2 config/usage. The
command policy arrives through the existing `AGENTIC_PI_COMMAND_POLICY` env.

## `run` flow

1. **Isolated config home per run.**
   - Point `CLAUDE_CONFIG_DIR`, `HOME`, `CODEX_HOME`, `XDG_CONFIG_HOME` and
     `XDG_DATA_HOME` at a temp dir.
   - Disable telemetry and auto-update (`DISABLE_AUTOUPDATER=1`,
     `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1`, OpenCode equivalents
     **[UNVERIFIED names]**).

   This is the lesson from 69/69 eval sessions picking up the operator's
   personal Pi skills (`docker.ts:432-440`), applied to `~/.claude`, `~/.codex`
   and `~/.config/opencode`.
2. **Write the runtime's native config** into that home: hooks, permission
   rules, instructions, skills.
3. **Spawn the adapter** (pinned bin, or `--agent-command`) with piped stdio, in
   its own process group.
4. **`initialize`** with `clientCapabilities {fs: false, terminal: false}`.
   Execution stays inside the agent. Advertising fs makes OpenCode double-write
   edits.
5. **`session/new`** with `cwd` and
   `mcpServers: [{name: "lastlight", command: <bridge>, args: ["mcp-github", "--profile", P, "--cwd", cwd, …], env: [GITHUB_TOKEN…]}]`.
   For Claude, also pass `_meta.claudeCode.options`:
   - `settingSources: ["user"]`, which is the bridge-owned temp dir and never
     the repo's `.claude/`;
   - `maxTurns`;
   - `disallowedTools: ["WebSearch", "WebFetch"]` unless `--web-search`;
   - `systemPrompt: {type: "preset", preset: "claude_code", append: <context file>}`.
6. **Model and thinking.** Pick the `configOptions` entries with category
   `model` / `thought_level`, choose the nearest ladder value, read back what
   was applied, and emit `session.config`.
7. **`session/prompt`** with the stdin text. Translate updates per
   [`02`](02-agent-event-schema.md).
8. **Answer `request_permission`** with the policy (below). Never pick
   `allow_always`. Decline `elicitation/create`.
9. **On SIGTERM:** send `session/cancel`, wait a grace period, then kill the
   process group.
10. **On exit:** emit `files.changed`, the final `usage`, then `run.completed`
    or `run.error`.

## Command policy and gate timeout

ACP permissions can **approve or reject, never rewrite the input**, and a
rejection carries no reason. So the timeout clamp needs native config or a
wrapper. Tiers, picked per runtime and best first:

| Tier | Mechanism | Block with reason | Log | Clamp | Used by |
|---|---|---|---|---|---|
| 0 | **`bash` wrapper on PATH** inside the sandbox: applies `decideCommand` + the gate clamp to every shell the agent spawns | yes (stderr) | yes | yes | candidate uniform layer for all runtimes; **evaluated in P0** (agents that exec `/bin/bash` by absolute path would bypass it) |
| 1 | Native pre-tool hook | yes | yes | yes | Claude `PreToolUse` command hook (`hook claude-pretool` → `decideCommand` + clamp via `updatedInput`); OpenCode `tool.execute.before` plugin **[UNVERIFIED]** |
| 2 | ACP permission | **no reason** | yes | no | Codex (approval `untrusted`, sandbox full-access because Last Light's sandbox is the isolation) |
| 3 | Observe-only | — | yes | — | classify `execute`-kind tool calls and emit `tool.policy {enforcement: "observed"}` |

A hook process can't write to the bridge's stdout. Hook and wrapper events go
to `$LASTLIGHT_BRIDGE_EVENTS`, a jsonl file the bridge tails and re-emits.
`decideCommand` and the gate clamp are imported Pi-free from agentic-pi
(`command-policy.ts` is already dependency-free; `gate-timeout.ts` exports
`resolveGateTimeout`, a pure clamp).

## File tracking

Record `git rev-parse HEAD` and `git status --porcelain` at start. At end, run
`git diff --numstat <startHead>` plus untracked files, and emit
`files.changed`. This works for any runtime.

## Usage and cost

1. `costUsd` from the last `usage_update.cost` (Claude, OpenCode) →
   `costSource: "runtime"`.
2. Tokens from `PromptResponse.usage` (Claude), else
   `_meta.quota.token_count` (Codex).
3. No cost → estimate from **pi-ai's model registry** (the same price table Pi
   runs use, already in the dependency tree), keyed on the original
   `provider/id` → `costSource: "estimated"`.
4. Optional for Claude: `emitRawSDKMessages` gives the SDK `result` for exact
   `num_turns` / `total_cost_usd`.

## Packaging

- A new `agent-bridge-build` stage in `sandbox.Dockerfile`: a
  `pnpm deploy --prod` bundle copied to `/opt/agent-bridge` and linked onto
  PATH. That is the agentic-pi pattern, so the lockfile is what ships.
- Claude's proprietary binary forces an image decision; see
  [`09-risks.md`](09-risks.md) item 1.
- On the host (evals, `--sandbox none`), adapters come from `pnpm install`. No
  global installs.
