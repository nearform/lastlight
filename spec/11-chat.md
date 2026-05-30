---
title: "Chat"
order: 11
description: "The pi-ai in-process chat runtime — the non-sandboxed path for low-latency conversational replies. Session resumption from messaging_messages, read-only GitHub tools, and the deliberate split with the sandboxed workflow path."
---

## Purpose

Chat is the alternative execution surface to the [Sandbox](/spec/09-sandbox).
It exists because Slack threads need low-latency, multi-turn
conversations that don't benefit from container isolation — and
because handing a tool-rich, write-capable agent to every casual
question is overkill.

The deliberate split: workflows do work and need isolation; chat
answers questions and needs latency. pi-ai is the right runtime for
the latter; agentic-pi is the right runtime for the former.

## Public contract

```ts
// src/engine/chat-runner.ts:75
export class ChatRunner {
  constructor(cfg: ChatRunnerConfig, sessionManager: SessionManager);
  async turn(messagingSessionId: string, prompt: string): Promise<ChatRunnerTurnResult>;
}

interface ChatRunnerConfig {
  model: string;          // resolved via resolveModel(config.models, "chat")
  thinking?: string;      // off | minimal | low | medium | high | xhigh
  systemPrompt: string;   // loadAgentContext() + CHAT_SYSTEM_SUFFIX + skill catalogue XML
  github?: ChatGitHubAuth;
  extraTools?: ChatExtraToolset;  // additional tools (read_skill); merged with github tools
  timeoutMs?: number;     // per-turn; default 120 s
}
```

The runner is constructed once at [Harness](/spec/01-harness) boot
(`src/index.ts:103–111`) and lives for the lifetime of the process. Each
inbound Slack message becomes one `turn()` call.

## pi-ai vs agentic-pi

Both are exported from `@earendil-works/pi-ai`. They serve different
purposes:

- **pi-ai** — `completeSimple()` is a single-turn-loop chat runtime
  with tool support. No sandbox. No supervisor. Suitable for low-latency
  conversational replies. Used here.
- **agentic-pi** — the sandboxed agent supervisor used by
  [Workflow Engine](/spec/06-workflow-engine) phases. Higher overhead
  per session, full isolation, full tool surface.

The runtimes share the provider abstraction and JSONL event-emission
shape, which is why both can write to the same dashboard via the
[Event Shim](/spec/10-state).

## Session model

One pi-ai session per Slack thread, mapped through the
`messaging_sessions` table.

Flow per turn (`chat-runner.ts:129–170`):

1. Resolve or mint `agentSessionId` for the messaging session. New
   threads get a fresh id; existing threads reuse the stored one.
2. `getHistory()` rehydrates the last 50 user/assistant message pairs
   from `messaging_messages` (rolling window — no token-aware
   truncation).
3. The new user message is appended to the in-memory turn payload.
4. `completeSimple()` runs the model with the read-only tool kit
   (line 197).
5. The final user prompt and the final assistant text are persisted
   via `addMessage()` (`messaging_messages` insert). Intermediate
   tool-loop output is discarded — only the surface conversation is
   stored.
6. `touchSession()` updates `last_activity_at` (`session-manager.ts:197`).

The `agent_session_id` is the join key into the JSONL — Slack thread
↔ messaging_session ↔ agent_session_id ↔
`projects/-app/<agent_session_id>.jsonl`. See [State](/spec/10-state).

## Tools

Two toolsets, merged into a single tool list at construction time
(`chat-runner.ts` `mergedTools`):

### GitHub (read-only)

Ten functions wired into pi-ai at `src/engine/github-tools.ts`:

| Tool | Purpose |
|---|---|
| `github_get_repository` | Repo metadata, default branch, language stats |
| `github_get_issue` | Issue body + metadata |
| `github_list_issue_comments` | Comments on an issue or PR |
| `github_list_issues` | Filter by state, labels, etc. |
| `github_get_pull_request` | PR body + metadata |
| `github_list_pull_requests` | PR list |
| `github_get_pull_request_diff` | The unified diff |
| `github_get_file_contents` | File from a ref |
| `github_list_commits` | Commit log |
| `github_search_issues` | GitHub search API |
| `github_search_code` | GitHub code search |

### Skills (`read_skill`)

One tool wired in via `extraTools`, defined in
`src/engine/chat-skills.ts`:

| Tool | Purpose |
|---|---|
| `read_skill` | Read the full SKILL.md for one of the curated chat skills. Parameters: `{ name: <enum of CHAT_SKILL_NAMES> }`. |

The chat agent's system prompt contains an XML `<available_skills>`
catalogue (name + description per curated skill — same shape
pi-coding-agent emits for sandbox phases). When a user's request
matches a skill's description, the agent calls `read_skill` to load
the body — pi's progressive-disclosure model. See
[Skills §Chat path](/spec/08-skills).

No `bash`, no `edit`, no `write`, no MCP. Chat physically cannot
modify code or open issues. A user asking chat to "fix that bug" is
gently redirected to the build workflow path, which goes through the
[Router](/spec/05-router) classifier and dispatches via
[Workflow Engine](/spec/06-workflow-engine).

Tool execution loop (`chat-runner.ts` `dispatchTool`): the model emits
a `toolCall`, the runner tries the github toolset first, then the
extra (`read_skill`) toolset; the JSON result is appended to context
and the loop repeats. Capped at `MAX_TOOL_ROUNDS = 8` — hitting the
limit ends the turn with `finishReason: "max-rounds"`.

## No sandbox — implications

Chat runs in the harness process itself. Real consequences:

- **Shared memory and env.** A pi-ai memory blow-up takes the harness
  with it. Production deployments should size the host accordingly.
- **No filesystem isolation.** Chat tools are network-only (GitHub API);
  the agent has no file-write capability. The sandbox-less design
  doesn't grant filesystem access — it just doesn't fence it off.
- **Lowest possible latency.** No container spin-up, no VM boot, no
  per-turn workspace clone. A turn is roughly one HTTP round-trip plus
  the LLM call.
- **Same crash blast radius as the rest of the harness.** A pi-ai
  error is a harness error — surfaced via the same logs, recovered
  by the same supervisor.

## System prompt

Built once at boot (`src/index.ts`):

```
systemPrompt = loadAgentContext() + CHAT_SYSTEM_SUFFIX + chatSkills.catalogueXml
```

Three layers:

- `loadAgentContext()` (`src/engine/profiles.ts`) concatenates all
  `.md` files under `agent-context/` in alphabetical order, joined
  with `\n\n---\n\n` (see [Skills §AGENTS.md](/spec/08-skills)).
- `CHAT_SYSTEM_SUFFIX` (`src/engine/chat.ts`) adds the chat-specific
  constraints — read-only tools, no write actions, hand off to the
  build workflow for code changes — so the same persona file
  (`soul.md`) can serve both surfaces without contradicting itself.
- `chatSkills.catalogueXml`
  (`src/engine/chat-skills.ts → loadChatSkillCatalogue`) is the XML
  `<available_skills>` block listing each curated chat skill's name +
  description. Mirrors the catalogue pi-coding-agent emits for
  sandbox phases. The agent uses it to decide which `read_skill` call
  (if any) to make.

The curated skill list is `CHAT_SKILL_NAMES` — currently `["chat",
"issue-triage", "pr-review", "repo-health"]`. v1 is hard-coded; lift
to env / settings if it ever needs runtime configurability.

## LLM provider routing

Same providers as the sandbox path. Model and reasoning effort
resolve via:

- Model: `resolveModel(config.models, "chat")` → `config.models.chat`
  or `config.models.default` or the global `LASTLIGHT_MODEL`.
- Thinking: `resolveVariant(config.variants, "chat")` →
  `config.variants.chat` or the global `LASTLIGHT_THINKING`.

Provider keys (`ANTHROPIC_API_KEY` etc.) are read from the harness's
own env — chat doesn't need the sandbox's forwarding dance.

## Session reset and status

Two adjacent skills routed by the [Router](/spec/05-router):

- **`chat-reset`** (`src/index.ts:654–661`) — deactivates the current
  messaging session (`session-manager.ts:206`). The next user message
  starts a new pi-ai session with empty history. Confirmation is sent
  via `envelope.reply()`.
- **`status-report`** (`src/index.ts:664–675`) — lists currently
  running executions. Not a pi-ai call at all — it queries the
  [State](/spec/10-state) directly and replies with a formatted
  summary.

Both are harness-level skills, not pi-ai tools — they need DB write
or admin-level state access that read-only chat tools cannot provide.

## JSONL log

Chat turns log the same way sandboxed phases do (see [State](/spec/10-state)):

- One JSONL file per Slack thread, at
  `$STATE_DIR/agent-sessions/projects/-app/<agentSessionId>.jsonl`.
- Each turn emits assistant + tool-result envelopes plus a final
  `result` envelope with cost / token stats.
- The dashboard's `ChatSessionReader` looks up the
  `agent_session_id` from `messaging_sessions` and reads the single
  file. It does *not* scan the `-app/` directory blindly — that would
  return JSONL from every Slack thread mixed together.

## Concurrency

`chains: Map<sessionId, Promise>` in `ChatRunner` (`chat-runner.ts:86, 115–127`)
serializes turns on a single Slack thread — two messages arriving in
the same thread within milliseconds are guaranteed to run one after
the other. Different threads run in parallel without bound.

A turn that throws still resolves the chain promise (in a `finally`)
so the next turn isn't blocked by a prior crash.

## Invariants

- **Chat is read-only on the world.** Every tool is a GET. Inserts
  into `messaging_messages` are the only writes chat makes, and they
  go through the session manager — not the agent's tool surface.
- **Same Slack thread → same agent session id.** Always. A
  reset is the only way to get a new id for an existing thread.
- **Tool rounds are capped.** Eight is enough; a chat that wants to
  exceed this should be redirected to a workflow.
- **History is a rolling 50-message window.** No token-aware
  truncation. A re-implementation that adds it should be careful to
  preserve assistant ↔ user pairing.
- **Screened messages reach chat with a flag, not a block.** A
  `[lastlight-flag: ...]` prefix on the user content tells the agent
  to treat it as data per `agent-context/security.md`. Chat does not
  refuse flagged content; it processes it with appropriate skepticism.
- **The system prompt is constructed once.** A change to
  `agent-context/*.md` does not propagate until the harness restarts.

## Current implementation

| Piece | File |
|---|---|
| `ChatRunner` class | `src/engine/chat-runner.ts` |
| System prompt assembly, screening | `src/engine/chat.ts` |
| Read-only GitHub tools | `src/engine/github-tools.ts` |
| Session manager + DB | `src/connectors/messaging/session-manager.ts` |
| `chat-reset` handler | `src/index.ts:654–661` |
| `status-report` handler | `src/index.ts:664–675` |
| Dashboard reader | `src/admin/ChatSessionReader.ts` |

## Rebuild notes

- **Two runtimes, one persona file.** The same `agent-context/*.md`
  drives both chat and workflows. A re-implementation that bifurcates
  the persona will drift quickly.
- **In-process for chat is the right call.** Container spin-up per
  turn would dwarf the LLM call latency. The trade-off is shared
  blast radius, which is acceptable for a read-only surface.
- **Resist adding write tools to chat.** "Just one tool to create the
  issue" is how surfaces drift. The contract — chat asks questions,
  workflows do work — keeps both clean.
- **Per-thread serialisation is required.** Two simultaneous turns on
  one Slack thread would corrupt session state. The `chains` map is
  load-bearing.
- **Rolling history window over token budget — for now.** The 50-message
  window is simple and predictable. Switching to a token-budgeted
  approach is fine but needs care around partial assistant messages.
- **JSONL is shared infrastructure.** Both surfaces write to the same
  shim, the same envelope format, the same project-slug convention.
  A re-implementation that gives chat its own log format makes the
  dashboard harder.
