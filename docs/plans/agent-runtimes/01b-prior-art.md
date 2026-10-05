# 01b — Prior art: is there an off-the-shelf harness?

Surveyed 2026-10-03. Question: is there an open-source library that already
wraps Claude Code, Codex and OpenCode (ideally Pi too) behind one normalized
API that a TypeScript orchestrator could adopt?

**Short answer: no project fits as-is. The ACP layer itself has matured enough
that our own bridge can be thin.**

## Constraints any candidate must meet

1. One-shot, headless, prompt-in → JSONL-out — **one-way**, because k8s only
   gives us the pod log stream.
2. Inject our own tools (36 GitHub tools, via MCP).
3. Enforce a bash command policy (block/log, clamp timeouts).
4. Normalized usage **and USD cost**.
5. Embeddable from TypeScript, and runnable from the evals harness on the host.
6. Licensing compatible with public GHCR images.

## Candidates

| Candidate | License / lang / activity | Agents | Transport | Usage + cost | MCP / policy | Fit |
|---|---|---|---|---|---|---|
| [openclaw/acpx](https://github.com/openclaw/acpx) | MIT, TS (Node ≥22.13), ~3.3k★, v0.19.4 (2026-10-01), pre-1.0 | ~27 ACP agents incl. Claude, Codex, OpenCode, Pi, Gemini | ACP | raw ACP stream | `--mcp-config`; per-tool permission policy (autoApprove / autoDeny / escalate); embeddable runtime with `onPermissionRequest`; `compare` command | **Closest.** `acpx --format json <agent> exec` is nearly our bridge. Gaps: pre-1.0 churn, raw ACP not our schema, no cost normalization |
| [rivet-dev/sandbox-agent](https://github.com/rivet-dev/sandbox-agent) | Apache-2.0, Rust server + TS SDK, ~1.6k★, last release 2026-03 | Claude, Codex, OpenCode, Amp, Pi, Cursor | ACP adapters (old pins), HTTP daemon in the sandbox | whatever the adapter sends | MCP config API, permission callback | Poor: needs bidirectional HTTP into the sandbox → breaks k8s; slowing |
| [coder/agentapi](https://github.com/coder/agentapi) | MIT, Go | 11 | PTY scraping | none | none | **Archived 2026-09-13** |
| [BloopAI/vibe-kanban](https://github.com/BloopAI/vibe-kanban) executors | Apache-2.0, Rust, ~28k★ | Claude, Codex, OpenCode, Gemini, Amp, … | native CLI JSON + ACP | total tokens, no cost | app-level | An app, not a library. Its normalized log entry schema is worth reading |
| [Harbor](https://github.com/harbor-framework/harbor) (ex Terminal-Bench) | Apache-2.0, Python, ~5.8k★, active | very broad incl. generic ACP | native CLI per agent → post-hoc **ATIF** trajectory | yes (reads Claude `total_cost_usd`) | per-agent MCP flags | Python evals framework, not embeddable. **Good reference for per-agent config isolation; ATIF is a schema to align with** |
| Vercel AI SDK community providers (`ai-sdk-provider-claude-code`, `-codex-cli`, opencode) | MIT, TS | one each | vendor SDK / CLI | AI-SDK usage, cost as metadata | per provider | Wrong abstraction — squashes agent runs into model calls |
| [Fabro](https://github.com/fabro-sh/fabro) | MIT, Rust, ~1.7k★, nightly | Claude, Codex, Gemini via ACP | **host-side** ACP client piped into sandbox stdio | — | auto-approves all permissions | Not reusable from TS; needs bidirectional stdio. Its ACP backend plan doc is a good design reference |
| OpenHands SDK, any-agent, Goose, Crystal, Sculptor, Omnara, claude-code-router | various | — | — | — | — | Out of scope (Python frameworks, full apps, model proxies) |
| Vendor SDKs (`@anthropic-ai/claude-agent-sdk`, `@openai/codex-sdk`, `@opencode-ai/sdk`) | proprietary / Apache-2.0 / MIT | one each | native | full | full | Fallback only: three adapters and three schemas to maintain |

### Added 2026-10-05 (two-way constraint dropped — see [`10`](10-live-sessions.md))

| Candidate | Verdict |
|---|---|
| [omnigent-ai/omnigent](https://github.com/omnigent-ai/omnigent) (Databricks, Apache-2.0, Python, ~505K LOC, alpha) | A platform (server + DB + UI + per-session runner), not an engine. No TS SDK, no JSONL one-shot; its Pi path drops cost and its tool gate fails open. **Borrow** the dial-out runner, the `message/interrupt/stop/function_call_output` vocabulary and ALLOW/DENY/ASK — don't adopt |
| [herdrdev/herdr](https://github.com/herdrdev/herdr) (Rust, ~42k★) | Terminal multiplexer; agent state by screen scraping. No structured tool events/cost/approvals — wrong layer |
| acpx as an embedded host client | Spiked: works for Claude Code (cost ✔, MCP ✔, cancel ✔) but `steer` only queues, rejects carry no reason, edits aren't permission-gated; `pi-acp` runs vanilla Pi with no permissions/cost |
| rivet sandbox-agent | No longer disqualified by two-way traffic; still slow-moving (0.5.0 RCs). Revisit only if in-sandbox ACP over exec gets fragile |

## Decision

**Build our own thin bridge on `@agentclientprotocol/sdk`**, and borrow:

- **acpx's permission-policy shape** (allow / deny / escalate per tool kind)
  for the bridge's policy layer;
- **Harbor's per-agent config isolation** (`CLAUDE_CONFIG_DIR`, `CODEX_HOME`,
  …) for the isolated config home;
- **ATIF-compatible fields** in `AgentEvent`, so our harness-comparison results
  can be lined up against Harbor's.

The **P0 spike** builds both of these and picks one:
(a) embed `acpx`'s runtime inside the bridge, getting its MCP config and
permission policy for free but taking on pre-1.0 API churn; and
(b) a hand-rolled client on the ACP SDK.

## Why nothing fits, per constraint

- **One-way k8s:** only an in-sandbox client that turns stdin into stdout JSONL
  fits. sandbox-agent (HTTP daemon) and Fabro (host-side client) both need
  two-way traffic. acpx fits.
- **Our MCP tools:** every adapter accepts `mcpServers` on `session/new`, so
  one stdio MCP server serves all runtimes. This needs no third-party help.
- **Command policy:** ACP permissions can approve or reject, never rewrite.
  Clamping a timeout needs native per-agent config or a `bash` wrapper on PATH.
  No candidate does this.
- **Cost:** take `usage_update.cost` where present (Claude, OpenCode). Price
  tokens ourselves for Codex, and record which source each number came from.
  No candidate normalizes this.
- **Licensing:** every route to Claude ships Anthropic's proprietary Claude
  Code binary. See [`09-risks.md`](09-risks.md) item 1.
