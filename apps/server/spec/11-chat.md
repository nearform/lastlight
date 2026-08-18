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
// src/engine/chat/chat-runner.ts:75
export class ChatRunner {
  constructor(cfg: ChatRunnerConfig, sessionManager: SessionManager);
  async turn(messagingSessionId: string, prompt: string): Promise<ChatRunnerTurnResult>;
}

interface ChatRunnerConfig {
  model: string;          // resolved via resolveModel(config.models, "chat")
  thinking?: string;      // off | minimal | low | medium | high | xhigh
  systemPrompt: string | (() => string);  // agent context + chatSystemSuffix() + skill catalogue XML;
                                          // a thunk is resolved per turn (see §System prompt)
  github?: ChatGitHubAuth;
  extraTools?: ChatExtraToolset;  // additional tools (read_skill); merged with github tools
  timeoutMs?: number;     // per-turn; default 120 s
}
```

The runner is constructed once at [Harness](/spec/01-harness) boot
(`src/index.ts:103–111`) and lives for the lifetime of the process.

### Per-session batching (MessageBatcher)

Bursty messaging input is coalesced **before routing** by the `MessageBatcher`
(`src/engine/chat/message-batcher.ts`), gated on `type === "message"` at the
`registry.onEvent` boundary in `index.ts`. The first message for an idle session
opens a short settle window (`CHAT_BATCH_DEBOUNCE_MS`, default 700ms; 0
disables); every message that lands in that window — or while a turn is already
in flight — is collected, sorted back into send order by source timestamp
(Slack `ts`), and **collapsed into one envelope** (bodies newline-joined). That
single envelope is dispatched once, so the burst is **classified once** and
answered as a single ordered turn (one executions row, one reply threaded under
the latest message). A rapid `A B C D E` burst becomes one `A\nB\nC\nD\nE` turn.

Batching before the classifier is deliberate: routing runs a ~700ms LLM
classifier per message concurrently, which would otherwise reorder a burst (a
later message whose classification finishes first would start its own turn
ahead of earlier ones). Collapsing first removes that reorder and the redundant
per-message classification. Different sessions run in parallel; the same session
strictly in order.

Neither runtime can inject context into a running agent (pi-ai is a stateless
completion client whose only mid-flight primitive is `AbortSignal`), so input
that arrives mid-turn is handled by finishing the current turn and running the
next batch, not by steering or aborting. The synchronous CLI `/api/chat` path
dispatches directly (not via `registry.onEvent`), so it bypasses the batcher and
its caller still gets the reply on the same request.

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

### The thread transcript — chat is not the only writer

A Slack thread is **one conversation regardless of how each message was
handled**. Most messages in a thread never reach `ChatRunner` at all: the
classifier routes a substantive question to the `answer` workflow, a build
request to `build`, and so on. Those turns are answered from a sandbox, and
`messaging_messages` is what carries them across to the next chat turn.

So two writers, kept **mutually exclusive per turn** so a turn is never
double-recorded (`src/connectors/messaging/thread-transcript.ts`):

| Turn | Writer |
|---|---|
| Chat (`handler: chat`) | `ChatRunner`, per the flow above |
| Anything else on a messaging envelope — a workflow dispatch, a router refusal, an approval or status reply | `withThreadTranscript`, which records the inbound message and wraps `envelope.reply` |
| A workflow's own output into the thread (the runner's `postComment`, live and on boot-recovery) | `recordThreadMessageForThread`, addressed by (platform, channel, thread) — the runner never sees a messaging session id |

Each writer records **only what was delivered** — after the send resolves,
inside its own error handling. The runner's Slack transport swallows and logs a
send failure, so recording outside that would write a message the user never saw
and have the next chat turn rehydrate it as fact: the same context drift, from
the other direction.

Every write also `touchSession()`s, so a thread carried entirely by workflow
turns cannot lapse into `SESSION_TIMEOUT_MS` staleness and silently re-key to a
fresh session mid-conversation. The by-thread writer deliberately looks past
that cutoff (`findActiveThreadSession(..., { includeStale: true })`): a workflow
can easily run longer than the window between a question and its answer, and
recording revives the session so the user's next message continues it.

Written text is clamped to `MAX_TRANSCRIPT_CHARS` (4 000), keeping its **tail** —
a long health report or review write-up would otherwise dominate the next chat
turn's rehydrated prompt, and a follow-up question refers back to the end.

Without this the symptom is precise and confusing: a question answered by a
workflow, followed by "can you summarise that?" in the same thread, rehydrates
an empty history and answers as if the user had just been introduced.

## Tools

Two toolsets, merged into a single tool list at construction time
(`chat-runner.ts` `mergedTools`):

### GitHub (read-only)

Ten functions wired into pi-ai at `src/engine/github/github-tools.ts`:

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
`src/engine/chat/chat-skills.ts`:

| Tool | Purpose |
|---|---|
| `read_skill` | Read the full SKILL.md for one of the chat-exposed skills. Parameters: `{ name: <enum of the loaded skill names> }`. |

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

Assembled per turn (`src/index.ts` passes a thunk; `ChatRunner.turn` resolves it):

```
systemPrompt = agentContext + chatSystemSuffix(hasGithub, { isWorkflowEnabled }) + chatSkills.catalogueXml
```

Three layers:

- `loadAgentContext()` (`src/engine/github/profiles.ts`) concatenates all
  `.md` files under `agent-context/` in alphabetical order, joined
  with `\n\n---\n\n` (see [Skills §AGENTS.md](/spec/08-skills)). Boot-stable,
  so it is read once and closed over.
- `chatSystemSuffix()` (`src/engine/chat/chat-prompt.ts`) adds the chat-specific
  constraints — read-only tools, no write actions, hand off to the
  build workflow for code changes — so the same persona file
  (`soul.md`) can serve both surfaces without contradicting itself. It is
  **composed from the enabled workflow set**, not a constant — see
  §Advertised capabilities below.
- `chatSkills.catalogueXml`
  (`src/engine/chat/chat-skills.ts → loadChatSkillCatalogue`) is the XML
  `<available_skills>` block listing each curated chat skill's name +
  description. Mirrors the catalogue pi-coding-agent emits for
  sandbox phases. The agent uses it to decide which `read_skill` call
  (if any) to make.

Which skills those are is **declared by the skills**: every skill
resolvable through the asset layer stack whose SKILL.md frontmatter sets
`chat: true`. The packaged set is `chat`, `issue-triage`, `pr-review`,
`repo-health`; an overlay can add its own or override a built-in. See
[Skills §In-process (chat)](/spec/08-skills).

## Advertised capabilities

What the agent tells a user it can do is **composed from the workflow
set**, the way the classifier prompt is (see
[Router §Intent classification](/spec/05-router)). `assembleChatPrompt()`
(`src/engine/chat/chat-prompt.ts`) renders a forkable base template —
`workflows/prompts/chat-system.md`, or `chat-system-no-github.md` when no
GitHub auth is configured — substituting two placeholders:

| Placeholder | Content |
|---|---|
| `{{workflowTriggers}}` | One deflection bullet per advertised workflow: its `chat.deflect` phrasings (quoted, ` / `-joined) and the reply that names its trigger |
| `{{triggerList}}` | The backticked `chat.trigger` phrases, then the suggestable `RESERVED_CONTROL_INTENTS` (`approve`, `reject`, `status`, `reset` — `chat` is the router's fallback, not something a user types) |

**A workflow is advertised iff it declares a `chat:` block**
(`trigger?` / `summary` / `deflect?` / `reply?` — see
[Workflow engine §Schema](/spec/06-workflow-engine)). `classification:` is
deliberately **not** the gate. A classification block means "the classifier can
tag a message with this intent"; it does not mean "a human should be told to
type this", and the two diverge in both directions:

- `demo` declares a classification block and a `routes.slack.demo` entry, but
  the Slack switch has no `demo` branch and `demo` is in `WELL_KNOWN_INTENTS`,
  so `fallbackWorkflowForIntent` returns undefined and a demo-classified
  message falls through to plain chat. Advertising it would name a dead route.
- `dependabot-ci-fix` / `dependabot-pr-merge` *are* reachable from a Slack
  message via the overlay-intent fallback, but would arrive with a repo and no
  PR number.

An entry may omit `trigger` and supply `reply` instead — a workflow that must be
explained but never typed. `repo-health` is the case: cron-only, no
classification block, but the agent still has to answer "can you do a health
report?" correctly.

Two filters apply, and they are why this is composed per turn rather than
concatenated once at boot:

1. `listAgentWorkflows()` already excludes the static `disabled.workflows`.
2. The **runtime kill switch** (`workflow_overrides`, toggled from the admin
   dashboard and enforced at dispatch in `simple.ts`) is a per-call
   `isWorkflowEnabled` predicate. It changes without an asset-version bump or a
   restart, and a workflow disabled there would otherwise still be advertised —
   typing its trigger then no-ops silently, indistinguishable from the bot
   ignoring the user.

Everything else is cached on the loader's asset version. An overlay that adds a
workflow with a `chat:` block gets it advertised with no core edit — the same
property `classification:` gives the classifier (issue #164).

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
- **A thread's transcript covers the whole thread, not just its chat
  turns.** Exactly one writer per turn — `ChatRunner` for chat,
  `thread-transcript.ts` for every other messaging path. A
  re-implementation that lets both write the same turn reintroduces the
  double-recording this split exists to prevent; one that lets neither
  write a workflow turn reintroduces the amnesia it exists to fix.
- **Tool rounds are capped.** Eight is enough; a chat that wants to
  exceed this should be redirected to a workflow.
- **History is a rolling 50-message window — the NEWEST 50.** No
  token-aware truncation. The limit must bite at the old end
  (`ORDER BY timestamp DESC, id DESC`, reversed for the caller): an
  ascending `LIMIT` keeps a long thread's opening and never shows it
  what was just said. `id` is the tiebreak because the two rows of one
  turn routinely share a whole-millisecond timestamp. A
  re-implementation that adds token-aware truncation should be careful
  to preserve assistant ↔ user pairing.
- **Screened messages reach chat with a flag, not a block.** A
  `[lastlight-flag: ...]` prefix on the user content tells the agent
  to treat it as data per `agent-context/security.md`. Chat does not
  refuse flagged content; it processes it with appropriate skepticism.
- **The system prompt is constructed once.** A change to
  `agent-context/*.md` does not propagate until the harness restarts.

## Current implementation

| Piece | File |
|---|---|
| `ChatRunner` class | `src/engine/chat/chat-runner.ts` |
| System prompt assembly, screening | `src/engine/chat/chat.ts` |
| Read-only GitHub tools | `src/engine/github/github-tools.ts` |
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
