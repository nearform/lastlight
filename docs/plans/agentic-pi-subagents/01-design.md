# Design — in-process subagents for agentic-pi

Route 2 from the exploration: children are **`AgentSession`s created inside the
agentic-pi process**, not spawned `pi` or `agentic-pi` subprocesses.

## Why in-process, given spawn is cheap

The spike showed process startup is ~1s, so *latency* is not the argument.
The argument is capability and control:

- A spawned bare `pi` gets none of our stack — no 36 `github_*` tools, no
  profile gate, no web/file search, no sandbox tool overrides, no
  `githubAuthEnv` isolation, no telemetry. Subagents that cannot call GitHub are
  useless for review and code-fix work.
- A spawned `agentic-pi run` keeps the tools but re-mints an installation token
  per child, re-runs skill discovery, cannot nest a Gondolin sandbox, and has no
  route to forked context (there is no `--resume`).
- In-process children reuse the already-built extension result, the already-
  minted token, and the live sandbox handle — and are the only way to get
  forked context at all.

## Pi SDK primitives this rests on

All public, no deep imports (agentic-pi hard rule #3):

- `createAgentSession` restores prior messages from whatever `SessionManager` it
  is handed — `core/sdk.js:81` calls `sessionManager.buildSessionContext()`.
- `DefaultResourceLoader` accepts `systemPrompt` / `appendSystemPrompt`
  (`core/resource-loader.d.ts`), so a child gets its own persona without
  touching Pi internals.
- `SessionManager.inMemory(cwd)` — fresh context.
- `session.exportToJsonl(path)` + `SessionManager.forkFrom(path, cwd)` — forked
  context, including under `--no-session` (export materialises the in-memory
  branch).
- `CreateAgentSessionOptions.tools` is an allowlist across *all* tools, custom
  ones included, so per-agent tool scoping is one option.

Pi has no built-in subagent tool. It does ship a reference extension
(`examples/extensions/subagent/`) whose **agent-definition format and tool
ergonomics we should copy**, and whose subprocess execution model we should not.

## Surface

### The tool

One custom tool, `subagent`, registered from a new
`src/extensions/subagent/`. Three modes, matching the upstream example so the
shape is familiar:

| mode | params | notes |
| --- | --- | --- |
| single | `{ agent, task, context? }` | |
| parallel | `{ tasks: [{agent, task, context?}, …] }` | max 8, 4 concurrent |
| chain | `{ chain: [{agent, task}, …] }` | `{previous}` placeholder |

`context: "fresh" | "forked"` per task, defaulting to the agent definition's
declared default, defaulting to `fresh`.

### Agent definitions

Markdown + frontmatter, identical to upstream's format so definitions port
both ways:

```markdown
---
name: scout
description: Fast codebase recon, returns compressed findings
tools: read, grep, find, ls
model: anthropic/claude-haiku-4-5
context: fresh
---
System prompt body.
```

Discovered from operator-mapped directories via a new **`--agent-dir <path>`**
flag that mirrors `--skill` exactly — normalise tilde/relative to absolute, drop
missing, warn. That reuses a proven delivery path: lastlight already stages
per-phase skill bundles into the workspace and passes repeated `--skill` flags
(`apps/server/src/sandbox/docker.ts:385-392`), so overlays can ship agents with
no code change.

**Project-local `.pi/agents/*.md` discovery is off, with no flag to turn it on
in phase 1.** A repo-controlled file that becomes a system prompt for an agent
holding a GitHub token is a privilege-escalation primitive, and unlike
interactive Pi we run against untrusted PRs with no human at the keyboard.

### Child construction

Extract a `createChildSession` factory from the tail of `runner.ts:291-301`.

Reused from the parent, built once: `modelRuntime`, `modelRegistry`,
`settingsManager`, `sandbox.customTools`, `github.customTools` (and its minted
token), `webSearch.customTools`, `fileSearch.packageDir`.

Built per child: a `DefaultResourceLoader` carrying the agent's system prompt, a
`SessionManager` (`inMemory` for fresh, `forkFrom` for forked), an `Emitter`
with its own session id, and its own telemetry mapper.

## The parts that are not just "call the SDK twice"

### Event stream

`Emitter` stamps a single `sessionId` per record (`emitter.ts:66-77`). Child
records get their own `sessionId` plus `parentSessionId` and
`parentToolCallId`, emitted through the same sink so the JSONL stays one
stream. Two new parent-stream events, `subagent_start` / `subagent_end`.

All of it **gated**: a run that spawns no subagent emits nothing new, so the
golden fixtures stay byte-identical. This is the pattern already used for
`max_steps_reached` and `skills_status`, and it is what keeps agentic-pi hard
rule #2 satisfiable.

### Usage rollup — non-negotiable

`session.getSessionStats()` is per-session (`runner.ts:507`). Child cost is
invisible to the dashboard and to lastlight's spend tracking unless the parent
sums children into its terminal `usage_snapshot`. The spike burned 73% of its
spend inside children; shipping without the rollup would mean every fan-out run
under-reports cost by roughly 4x. Given the history in
`lastlight-review-sweep-spend-loop`, this ships in phase 1 or the feature does
not ship.

### Telemetry

`telemetry/mapper.ts:96` holds a **single** `turnSpan`, and every `turn_start`
abandons the previous one. Concurrent children on one mapper shred the span
tree. Each child needs its own mapper, rooted at the parent's `subagent` tool
span.

### The lastlight shim

`apps/server/src/engine/event-shim.ts` maps `message_end` → assistant envelope,
`tool_execution_end` → `tool_result` (paired through `seenToolCalls`), and
`usage_snapshot` → the terminal `result` envelope. Un-namespaced child events
would produce orphan tool results and a second `result` line. The shim must
drop or nest anything carrying `parentSessionId`, and ignore child
`usage_snapshot`s in favour of the parent's rolled-up one.

### Filesystem contention

In lastlight's real deployment the sandbox is `--sandbox none` — the container
*is* the sandbox — so parallel children share one worktree. Pi exports
`withFileMutationQueue` for exactly this and our Gondolin ops do not use it.

**Phase 1 children are read-only** (no `write`/`edit`/`bash` in the default
allowlist). That is also what the spike ran, and it covers the case that
motivated this — parallel analysis. Parallel *editing* needs a worktree per
child and is explicitly deferred.

### Budgets

- **Depth 1.** Children do not get the `subagent` tool in their `customTools`.
  Registration-time, not a runtime check — mirrors agentic-pi hard rule #5.
- Concurrency 4, fan-out 8 (upstream's numbers).
- Per-child `--max-steps` default, independent of the parent's.
- An aggregate cost ceiling that aborts outstanding children when crossed.
- A child's GitHub profile may **narrow** the parent's, never widen it.

## Attacking the two overheads the spike measured

**Context re-establishment** → forked mode. The spike's children each burned
3–4 tool calls rediscovering orientation the parent already had, and `child-cli`
went to `dist/` because it had no shared conventions. A forked child starts from
the parent's branch and skips all of it.

**The synthesis tail** (36s, 4.2k output tokens) → a return contract. The agent
definition declares what a child returns, the tool result is hard-capped (much
tighter than upstream's 50KB), and long output goes to an artifact path the
parent references rather than re-emits. The parent should route child output,
not retype it.

## Phasing

1. **Factory + fresh children.** Extract `createChildSession`, ship the tool
   with `single` and `parallel`, read-only children, gated events, usage
   rollup, depth-1 and concurrency caps. Fixtures for a subagent run.
2. **Forked context.** `exportToJsonl` + `forkFrom`, `context` param, and a
   measurement rerunning the spike's task to confirm the rediscovery tax is
   actually gone.
3. **lastlight wiring.** `--agent-dir` staging alongside `skillDirs`, shim
   nesting, telemetry child spans, overlay-shipped agent definitions.
4. **Deferred.** Chain mode, per-child worktrees for parallel editing, depth > 1.

## Non-goals

Spawning `pi` or `agentic-pi` subprocesses. Nested sandboxes. Project-local
agent discovery. MCP (hard rule #1).
