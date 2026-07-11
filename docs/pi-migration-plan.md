# Migration Plan: Claude CLI → pi-mono harness

> **SUPERSEDED (2026-05-20).** The Claude → pi-mono migration was not
> executed. The codebase instead migrated to OpenCode on the
> `opencode-fork` branch (now merged), retaining the workflow runner,
> YAML schemas, permission profiles, approval gates, MCP server,
> GitHub App, dashboard contract, and DB. See `CLAUDE.md` and
> `README.md` for the current runtime story. This document is kept
> for historical reference of the design alternatives considered.

**Status:** SUPERSEDED — original draft (2026-04-27).
**Owner:** TBD
**Target architecture:** Option A — `pi-agent-core` runs on the host as a library; Docker container becomes a tool-execution sandbox via `docker exec`. `pi-mcp-adapter` brokers the existing `mcp-github-app` so it ships unchanged.

## Goals

- Replace the Claude CLI binary inside the sandbox with a library-driven agent loop (`pi-agent-core`).
- Eliminate the two-mode split between in-process chat (Anthropic SDK) and sandboxed runs (`claude --print`).
- Keep `mcp-github-app` unchanged by routing it through `pi-mcp-adapter` with `directTools: true`.
- Move per-tool permission enforcement from "static token scoping only" to "static token scoping + `beforeToolCall` gating".
- Replace stream-json parsing and on-disk Anthropic SDK jsonls with typed `AgentEvent`s persisted to SQLite.
- Preserve current non-workflow helper behavior (comment classifier, injection screener, capacity/rate-limit checks, dashboard live tail) so the cutover is complete, not just workflow-complete.

## Non-goals

- Swapping providers away from Anthropic (pi-ai supports it; we don't pursue it in this plan).
- Replacing the workflow runner, approval-gate semantics, or YAML schemas.
- Rewriting `mcp-github-app` natively in pi (deferred to Phase 8).
- Changing the dashboard UI beyond what the new event log requires (see Phase 4 *Dashboard UI* sub-section).

## Architectural shift

| | Today | After |
|---|---|---|
| Agent runtime | `claude` binary inside Docker container | `Agent` from `@mariozechner/pi-agent-core` in harness Node process |
| Tool execution | Inside container (claude → mcp-github-app + bash/read/write/edit) | On host for read-only tools; via `docker exec` for shell/file tools that need isolation |
| Stream parsing | Line-by-line stream-json (`src/engine/executor.ts:240–273`) | `session.subscribe((event: AgentEvent) => …)` |
| Session storage | Anthropic SDK jsonls under `claude-home/projects/-<cwd>/` | SQLite `executions_events` table, optional pi `SessionManager` jsonl mirror |
| Permission model | Token scoping + `--dangerously-skip-permissions` | Token scoping + `beforeToolCall` per-workflow allowlist |
| MCP integration | `claude` reads `.mcp.json`, spawns `mcp-github-app` | `pi-mcp-adapter` reads `.mcp.json`, spawns `mcp-github-app`, registers tools as native via `directTools: true` |
| Two execution modes | sandbox (CLI) + chat (SDK) | Single `Agent`-based path; chat is just a long-lived `Agent` per Slack thread |

---

## Phase 0 — Spike & validation (target: 1–2 days)

**Goal:** prove the load-bearing assumptions before committing to the migration. If any of these fails, replan before Phase 1.

**Work:**

1. New branch `pi-migration`, add deps:
   - `@mariozechner/pi-agent-core@<exact-version>`
   - `@mariozechner/pi-ai@<exact-version>`
   - `pi-mcp-adapter@<exact-version>`
   - `@modelcontextprotocol/sdk` (transitive, but lock the version we want)
2. Write `scripts/pi-spike.ts` that:
   - Builds an `Agent` with system prompt = concat of `agent-context/*.md`.
   - Loads `mcp-github-app` via `pi-mcp-adapter` with `directTools: true`.
   - Runs one prompt: "Fetch the title of issue nearform/lastlight#1".
   - Logs every `AgentEvent` and the final `usage.cost`.
3. Audit `pi-mcp-adapter` source (~30 min): confirm it's not doing anything surprising with credentials, that it respects `env` interpolation, and that `directTools` registration produces the expected tool surface.
4. Confirm the Anthropic provider in `pi-ai`:
   - **Reality check:** current `pi-mono` uses Pi's own `auth.json` + OAuth provider flow, not Claude Code's on-disk credential format. Verify whether we will:
     - store Pi auth in a Last Light-owned path (preferred),
     - build a one-time import bridge from Claude credentials,
     - or switch the harness to API-key mode.
   - Exercise token refresh and restart behavior with that chosen auth path, not just an interactive one-shot login.
   - Has Opus 4.7 1M registered (`packages/ai/src/models.generated.ts`); if not, document the one-line addition.
   - Applies `cacheControl: { type: "ephemeral" }` to system prompt + tools + last user msg automatically (existing today; just verify).
5. Confirm `pi-mcp-adapter` direct-tools cold-start behavior:
   - With `directTools: true` and an empty metadata cache, do the desired tools exist immediately or only after cache population / reconnect?
   - If cache prewarming is required, document the harness startup step explicitly.
6. Confirm `Agent.subscribe()` backpressure characteristics against SQLite writes:
   - Subscribers are awaited; if we append events synchronously, slow DB writes will lengthen turn latency.
   - Measure whether per-event inserts are cheap enough or whether we need a small in-process queue/batcher.

**Deliverables:**
- Working spike script.
- A 1-page write-up of `pi-mcp-adapter` audit findings: pin version, list any patches we'd want.
- Verified-or-not list for caching, 1M context, auth path, direct-tools cold start, and subscriber backpressure.

**Validation:** spike completes a real github tool call against a real repo and reports cost. If it doesn't, we stop.

**Risks:**
- `pi-mcp-adapter` may not pass `env` correctly into the spawned MCP process — would block subscription auth.
- `pi-ai` Anthropic OAuth path is Pi-native (`auth.json`), not Claude-native — this is a design choice to make, not just a verification checkbox.
- 1M Opus variant not in pi's model registry — small patch, but a patch.
- `pi-mcp-adapter` direct tools may depend on pre-existing metadata cache — would affect our bootstrap path and first-run behavior.
- Awaited event subscribers may make naive `execution_events` persistence materially slower than the CLI/jsonl path.

**Exit criteria:** auth path chosen and tested, direct-tools bootstrap behavior understood, subscriber write strategy chosen, and the spike runs end-to-end.

---

## Phase 1 — Parallel executor behind a flag (target: 3–5 days)

**Goal:** ship a new `pi-executor.ts` that runs **one** workflow (read-only, low-risk) end-to-end, gated by a feature flag. Old executor untouched. We can roll back by flipping the flag.

**Work:**

1. New file `src/engine/pi-executor.ts` exporting an `executePiAgent(opts): Promise<ExecutionResult>` with the same return shape as today's `executeAgent`.
2. Internals:
   - Build `Agent` with `convertToLlm` from `pi-coding-agent` (or hand-rolled — see mom `agent.ts:11`).
   - Load system prompt: existing `loadAgentContext()` from `src/engine/executor.ts:101`.
   - For skill phases: load `skills/<name>/SKILL.md` and append (existing template-render logic stays).
   - Configure `pi-mcp-adapter` extension in-process, pointing at `mcp-github-app/src/index.js` with `directTools: true`. Pass `GIT_TOKEN` via `env` interpolation.
   - Decide config ownership explicitly:
     - keep generating a project `.mcp.json` as shared input,
     - optionally generate a Pi-owned override (`.pi/mcp.json`) only if adapter-specific settings are needed,
     - do **not** assume the adapter reads only one template file.
   - If direct tools require warm metadata cache, prewarm it during startup / first-run instead of assuming they exist immediately.
   - Subscribe to `AgentEvent`s; aggregate `usage.input/output/cacheRead/cacheWrite/cost.total` across `message_end` events into the existing `ExecutionResult` shape.
   - Map `assistantMsg.stopReason` → existing subtype values (success/error/max_turns).
3. Feature flag: `PI_EXECUTOR_WORKFLOWS` env var, comma-separated workflow names. `runner.ts:runPhase()` checks the flag and dispatches to old or new executor.
4. Wire it for `repo-health.yaml` only.
5. Run weekly health workflow against a test repo on staging; compare output and cost to baseline.

**Deliverables:**
- `src/engine/pi-executor.ts` (~400 LOC).
- Feature flag plumbing in `runner.ts`.
- One-page comparison: tokens used, cost, output diff (old vs new) for the same `repo-health` run.

**Validation:** running `npm run cli -- health <repo>` with the flag enabled produces a comparable health report; cost within 10% of old; no harness errors.

**Out of scope:**
- `repo-write` workflows (these need PEM-mount rethink — Phase 2).
- Changing the dashboard reader (Phase 4).
- The chat path (Phase 5).

**Risks:**
- `AgentEvent.message_end.usage.cost.total` may not exactly match `result.total_cost_usd` from the CLI; document the delta.
- Approval gates not yet wired — won't trip in `repo-health` (no gates), but Phase 6 must address.
- Adapter startup may expose only the proxy tool on a cold cache even with `directTools: true`; plan for that explicitly or pick proxy mode for the first flag rollout.

**Exit criteria:** at least three successful staging runs of `repo-health` via `pi-executor`; cost and output reviewed and accepted.

---

## Phase 2 — Sandbox model migration (target: 3–5 days)

**Goal:** stop running the agent inside Docker. Container becomes the boundary for shell-level tools only.

**Work:**

1. New module `src/engine/executors/`:
   - `LocalExecutor` — runs commands on the host (in the per-task worktree dir).
   - `DockerExecutor` — `docker exec ${container} sh -c …` against a long-lived container per task. Mirror mom's pattern (`packages/mom/src/sandbox.ts:71`).
   - Both implement an `Executor` interface with `exec(cmd, opts)` and `getWorkspacePath(hostPath)`.
2. Add an explicit `WorkspaceManager` / bootstrap step before executor selection:
   - clone or fetch the target repo,
   - create/resume the per-run worktree/branch,
   - mount or expose that workspace to whichever executor is used.
   Current Last Light sandboxing only provisions a task directory; it does **not** currently perform repo checkout/worktree setup in the executor path.
3. Build a small set of native pi tools (TypeBox-schema'd) that wrap the executor: `bash`, `read`, `write`, `edit`. Most can be lifted from `packages/coding-agent/src/core/tools/` or `packages/mom/src/tools/`.
4. Decide which workflows need DockerExecutor:
   - `repo-health` / `pr-review` / `issue-triage` (read-only): `LocalExecutor` is fine — agent only reads via github tools.
   - `build` / `pr-fix` (`repo-write`): keep `DockerExecutor` — running tests, npm install, etc. inside container preserves the "agent can't break the host" property.
5. Refactor `src/sandbox/docker.ts`:
   - Keep the per-task container provisioning (clone repo, mount data volume, set up worktree).
   - Remove `claude` invocation entirely — the harness no longer execs into the container.
   - Container becomes a long-lived process (`tail -f /dev/null` style, mom-pattern).
   - Drop `~/.claude/` symlinks; drop `ALLOW_APP_PEM` mount logic (PEM stays on the host now).
6. Keep `GIT_TOKEN` minting in `src/engine/git-auth.ts` unchanged. Token passes via `docker exec ${container} env GIT_TOKEN=… …` per command, not container-wide env.
7. Decide where Pi auth lives for host-side agent calls:
   - service-owned `stateDir/pi-auth.json` (preferred),
   - shared `~/.pi/agent/auth.json`,
   - or API key mode.
   This is separate from GitHub App token handling and should not be left implicit.

**Deliverables:**
- `src/engine/executors/{local,docker}.ts`.
- Native pi tools for bash/read/write/edit wired to executor.
- Updated `src/sandbox/docker.ts` (probably renamed `src/sandbox/container.ts`) that no longer invokes claude.

**Validation:**
- A `build` workflow run produces a successful PR end-to-end via `pi-executor` + `DockerExecutor`. Diff the resulting PR vs a baseline.
- Verify on the production server that the container has no agent-side artifacts (`/home/agent/workspace/.claude` etc.).

**Out of scope:**
- Removing the container entirely. We could later — for read-only workflows — but it's a separate decision.
- Changing how `mcp-github-app` runs (it stays on the host, spawned by `pi-mcp-adapter`).

**Risks:**
- `bash` tool in the new world can have surprises around PWD, signals, and process trees. Mom has solved this; lift their `killProcessTree` and timeout handling (`packages/mom/src/sandbox.ts:103–135`) verbatim.
- File-edit tools need careful path validation against the worktree root — port `src/sandbox/`'s existing checks.
- "Keep per-task container provisioning (clone repo, mount volume, set up worktree)" is aspirational relative to today's code. We need to build and test the repo-bootstrap layer, not assume it already exists.

**Exit criteria:** a `build` workflow on a test repo passes through Phase 1 + Phase 2 with no claude-CLI involvement.

---

## Phase 3 — Permission gates via `beforeToolCall` (target: 1–2 days)

**Goal:** enforce `GitAccessProfile` per-tool-call, not just at token-mint time.

**Work:**

1. Define a per-profile tool allowlist (extending the existing `GITHUB_PERMISSION_PROFILES` in `src/engine/executor.ts:57`):
   - `read`: read-only github tools + `read`/`grep`/`find`. No `bash`, no `write`/`edit`, no comment-posting.
   - `issues-write`: read tools + `create_issue` / `update_issue` / `add_issue_comment`. No `bash`, no `write`/`edit`.
   - `review-write`: read tools + PR review tools + `add_issue_comment`.
   - `repo-write`: everything except destructive ops (kept as a denylist: `delete_repository`, `force_push`, etc.).
2. In `pi-executor.ts`, attach `beforeToolCall` to the `Agent` config:
   ```ts
   beforeToolCall: async ({ toolCall, context }) => {
     const allowed = ALLOWLIST[opts.profile];
     if (!allowed.has(toolCall.name)) {
       return { block: true, reason: `Tool ${toolCall.name} not allowed in profile ${opts.profile}` };
     }
   }
   ```
3. Token scoping in `git-auth.ts` stays as defense-in-depth.
4. Leverage the actual hook semantics from `pi-agent-core`:
   - `beforeToolCall` runs **after** argument validation,
   - the requesting assistant message is already in agent state,
   - blocked tools return an error-style tool result instead of crashing the loop.
   This is good news for policy enforcement, but we should design to those exact semantics.

**Deliverables:**
- Allowlist constants per profile.
- `beforeToolCall` wired in `pi-executor.ts`.
- Tests: per profile, a representative blocked call returns the expected error tool-result and the loop continues without crashing.

**Validation:** integration test that runs an `issue-triage` workflow with a prompt designed to tempt a `bash` call; assert `beforeToolCall` blocks it and the run completes cleanly.

**Risks:** an over-restrictive allowlist will make agents flounder. Start with the existing CLI's `--allowedTools` set as the source of truth (currently inferred); be willing to widen.

**Exit criteria:** all four profiles tested with both an allowed and a blocked tool call.

---

## Phase 4 — Session storage & dashboard reader (target: 4–6 days)

**Goal:** replace Anthropic-SDK jsonl reading with a SQLite-backed event log. Dashboard live-tail keeps working.

**Work:**

1. New table `execution_events` carrying enough identity to preserve current dashboard semantics:
   ```sql
   CREATE TABLE execution_events (
     id INTEGER PRIMARY KEY,
     execution_id TEXT NOT NULL REFERENCES executions(id),
     session_id TEXT NOT NULL,           -- logical session (workflow run id, chat thread id, …)
     parent_session_id TEXT,             -- subagent / side-session parent; NULL for root
     source TEXT NOT NULL,               -- 'workflow' | 'chat' | 'subagent' | 'system'
     correlation_id TEXT,                -- tool_call_id / message_id when applicable
     seq INTEGER NOT NULL,
     event_type TEXT NOT NULL,
     payload_json TEXT NOT NULL,
     ts INTEGER NOT NULL,
     UNIQUE(execution_id, seq)
   );
   CREATE INDEX idx_exec_events_exec ON execution_events(execution_id, seq);
   CREATE INDEX idx_exec_events_session ON execution_events(session_id, seq);
   CREATE INDEX idx_exec_events_parent ON execution_events(parent_session_id) WHERE parent_session_id IS NOT NULL;
   ```
   These fields exist specifically because today's dashboard groups main sessions with side-session `agent-*.jsonl` files for workflow runs while **not** doing that for chat threads (`src/admin/sessions.ts:207–215`, `src/admin/chat-session-reader.ts:13`). A flat `execution_id`-only schema would regress that behavior.
2. Introduce a `SessionEventSource` abstraction for the admin API:
   - historical read,
   - live tail / SSE stream,
   - source detection (SQLite vs legacy jsonl).
   The current dashboard is not just a reader; it tails concrete files on disk.
3. In `pi-executor.ts`, subscribe to events and persist them through that abstraction. Keep writes cheap; if subscriber backpressure is measurable, batch or queue inserts rather than making the LLM loop wait on every row write.
4. Rewrite `src/admin/sessions.ts` (`SessionReader`) to read from the new source instead of raw jsonls. Map `AgentEvent` types to the dashboard's existing `JsonlMessage` shape (or update the dashboard — easier; the schema is much cleaner now).
5. Rewrite `src/admin/chat-session-reader.ts` similarly, but preserve its current "one logical thread, no sibling side-session pollution" behavior.
6. Migration plan: don't backfill. Old executions keep reading from jsonls until they're aged out of the dashboard's default 30-day window. New executions write to `execution_events` only. Prefer automatic source selection over a user-visible `legacy=true` query parameter.
7. Decide on pi `SessionManager` jsonl: do we also let pi write its own jsonls under `~/.pi/agent/sessions/`? Probably **yes** as a debugging convenience (lets you `pi --resume` a session locally), but the harness reads from SQLite, not from those files.

### Dashboard UI work (in `dashboard/`)

The dashboard consumes a stable API contract — `Session` and `Message` types from `dashboard/src/api.ts`, processed by `dashboard/src/timeline/processor.ts` into `TimelineItem`s. The migration touches the dashboard along three axes:

**A. Contract-preservation (low risk, mechanical) — must do**

1. Admin SSE endpoints (`/admin/api/sessions`, `/admin/api/chat-sessions`, and their per-session message streams in `useMessageStream.ts`) keep the same JSON shape. The new `SessionEventSource` translates `AgentEvent` → the existing `BaseMessage` shape (`type: "user" | "assistant" | "tool_use" | "tool_result"`) so `dashboard/src/timeline/processor.ts:25` doesn't change.
2. `Session.sessionType` field (consumed by `dashboard/src/sessionTypes.ts:23–40`) keeps the same values — `architect`, `executor`, `reviewer`, `triage`, `health`, `chat`, etc. These are runner phase names and don't change in this migration.
3. Tool names stay stable in proxy/MCP-adapter mode: github MCP tool names are passed through verbatim by `pi-mcp-adapter`, and `bash`/`read`/`write`/`edit` lift from pi-coding-agent with their existing names. `dashboard/src/timeline/toolFamily.ts:75` and `toolRenderers.tsx` keep working unchanged.

**B. New event types we should surface — should do**

Pi exposes events the dashboard doesn't render today. Fold them into the timeline as `MetaMessage` items so they're visible without disrupting the message/tool-pair flow:

1. `compaction_start` / `compaction_end` — render as "Context compacted: N → M tokens" meta row. Useful given pi's auto-compaction is on by default.
2. `auto_retry_start` / `auto_retry_end` — render as "Retrying (n/N) after rate-limit/5xx". Pi has built-in exponential-backoff retry; users will see them happen.
3. `thinking_start` / `thinking_update` / `thinking_end` — already shown via thinking content blocks today, no change needed if we keep the content-block shape.
4. `agent_start` / `agent_end`, `turn_start` / `turn_end` — useful for showing turn boundaries; render as subtle dividers.

Each new event type needs: a `MetaMessage` subtype, a renderer in `dashboard/src/components/timeline/MetaMessage.tsx`, and an icon (existing lucide-react set has the candidates).

**C. Permission-block telemetry — should do**

Phase 3 introduces `beforeToolCall { block: true, reason }`. These produce error-style tool results today. Add a small UI pill ("Blocked by policy: {reason}") in `dashboard/src/components/timeline/ToolPair.tsx` so policy blocks are distinguishable from genuine tool failures.

**D. Out of scope here — schedule with Phase 8**

If/when we rewrite `mcp-github-app` as native pi tools (Phase 8), tool names may change (`github_create_issue` vs `mcp__github__create_issue`). `dashboard/src/timeline/toolFamily.ts` classification and `toolRenderers.tsx` per-tool render rules would need updates at that point. Defer.

**Deliverables:**
- New table + migration.
- Updated `SessionReader` / `ChatSessionReader` translating `AgentEvent` → `BaseMessage`.
- Dashboard `MetaMessage` renderers for compaction / auto-retry / agent-turn boundaries.
- Dashboard policy-block pill in `ToolPair.tsx`.
- No change to `Session`/`Message` types in `dashboard/src/api.ts` — that's the test of whether contract preservation succeeded.

**Validation:**
- A live-running execution shows tool calls, assistant messages, and final result in the dashboard within 1s of emission.
- A historical execution from before the migration still renders (legacy reader path).

**Risks:**
- Event volume: a long agent loop with thousands of tool calls could write a lot of rows. SQLite handles this fine (<100k rows/run), but watch the DB grow.
- `payload_json` size — we serialize whole tool call args/results. Add a max size and truncate with a `truncated: true` flag.
- Parent/child session relationships matter for dashboard fidelity. A flat execution-id-only event log will be simpler to write but won't preserve current workflow-session rendering behavior.
- Because `Agent.subscribe()` listeners are awaited, event persistence is on the hot path unless we explicitly buffer.

**Exit criteria:** dashboard "live tail" works against new events; `ChatSessionReader.getMessages()` returns the same content as before for a Slack thread.

---

## Phase 5 — Chat skill migration (target: 2–3 days)

**Goal:** drop direct `query()` calls from `@anthropic-ai/claude-agent-sdk`; use a long-lived `Agent` per Slack thread.

**Work:**

1. Refactor `src/engine/chat.ts`:
   - Import from `@mariozechner/pi-agent-core` instead of `@anthropic-ai/claude-agent-sdk`.
   - `getOrCreateAgent(threadId)` — caches one `Agent` per Slack thread, mom-style (`packages/mom/src/agent.ts:392`).
   - On thread resume: load prior messages from `execution_events` (or `messaging_messages`, whichever exists per thread) and seed `agent.state.messages`.
   - Configure `pi-mcp-adapter` with the chat-allowlist from `chat.ts:68` (`ALLOWED_MCP_TOOLS`).
   - Apply same `beforeToolCall` gating as Phase 3, but with the chat-specific allowlist.
   - Decide whether to use raw `Agent` or wrap it in a small session helper of our own. In pi-mono, long-lived apps commonly layer `SessionManager` / `AgentSession` behavior on top for resume, event sync, and context reloads; if we stay raw, we own all of that logic explicitly.
2. Subscribe to events; format for Slack mrkdwn the same way today's chat does.
3. Verify thread continuity: send "hello", reply, send another message in the same thread, agent remembers context.
4. Token / cost accounting per chat turn writes into `executions` (triggerType=`chat`) — same as today.

**Deliverables:**
- Rewritten `src/engine/chat.ts`.
- Per-thread `Agent` cache with eviction (LRU or TTL) to bound memory.

**Validation:**
- Slack: send a message, get a reply with tool calls. Reply in the thread; verify the agent has prior context.
- Cost reports in admin dashboard match Phase 1 baseline.

**Risks:**
- Long-lived `Agent` instances accumulate memory. Mom evicts via channel-runner cache; we mirror that.
- A crash mid-conversation must not lose the thread. Periodically persist `agent.state.messages` to DB, or rely on the event log to reconstruct on next message.

**Exit criteria:** chat workflows pass an end-to-end Slack thread test with multi-turn context.

---

## Phase 6 — Workflow runner & approval gates (target: 2–3 days)

**Goal:** make all workflows (not just `repo-health`) run through `pi-executor`. Approval-gate semantics preserved.

**Work:**

1. Remove the per-workflow `PI_EXECUTOR_WORKFLOWS` flag; all phase types now go through `pi-executor`.
2. Approval-gate flow (existing in `src/workflows/runner.ts:577–601` and `src/workflows/resume.ts`):
   - Preserve the current ownership boundary: the **runner** decides when a phase is complete and when to pause; approval is not an agent-native sentinel today.
   - Persist both agent messages/events **and** runner workflow state (`currentPhase`, `scratch`, `nodeStatuses`, pending approval kind).
   - On resume (`@last-light approve`): rebuild the workflow context first, then either:
     - skip forward to the next phase,
     - or deliberately re-enter the owning phase for reply-gates / loop resumes.
   - Treat "fresh Agent from prior messages" as only one ingredient; it is not sufficient on its own to preserve current semantics.
3. Reviewer-loop verdict parsing (`runner.ts:554`): unchanged — text content of last assistant message is the same in both worlds.
4. Cron-kind workflows: same code path, just dispatched by the scheduler.

**Deliverables:**
- All workflows running via `pi-executor`.
- Approval gate tested end-to-end with a synthetic `build` workflow.

**Validation:**
- Trigger a `build` on a test repo; pause at `post_architect`; reply `@last-light approve`; verify the workflow resumes and produces a PR.
- Cron `repo-health` runs nightly and produces a Slack post identical in shape to today's.

**Risks:**
- Resume-from-DB-into-fresh-Agent is the highest-risk piece. Test it heavily — multi-step approvals, edits between approval and resume, etc.

**Exit criteria:** all six workflow types pass an integration test.

---

## Phase 7 — Cleanup & cutover (target: 2 days)

**Goal:** delete the old code paths; the system runs on pi-mono only.

**Work:**

1. Delete `src/engine/executor.ts` (the CLI invocation), keeping only `pi-executor.ts` (rename to `executor.ts`).
2. Delete `claude` CLI install from `Dockerfile` and `sandbox.Dockerfile`.
3. Delete `~/.claude/` symlink logic from `deploy/sandbox-entrypoint.sh`.
4. Drop env vars: `CLAUDE_HOME_DIR`, `CLAUDE_MODEL` rename to `PI_MODEL` (alias kept for one release).
5. Remove `@anthropic-ai/claude-agent-sdk` dep.
6. Remove `mcp-config.tmpl.json` if pi-mcp-adapter manages config another way; otherwise keep as input to pi-mcp-adapter's `.mcp.json`.
7. Update `CLAUDE.md`, `README.md`, `src/workflows/CLAUDE.md` to reflect the new architecture.
8. Migrate or replace the remaining Claude-specific helper paths. These are easy to forget because they are outside the main executor/chat path, but Phase 7 is not complete until each is addressed:
   - **`src/engine/classifier.ts`** — small haiku-class LLM call, no tools. Direct port to `pi-ai`'s `complete()` / `streamSimple()`. Lowest risk; ~1 hour.
   - **`src/engine/screen.ts`** — same shape as classifier (haiku, no tools, advisory output). Same migration pattern; ~1 hour.
   - **`src/cron/rate-limits.ts`** — **needs redesign, not port.** Today execs `claude --output-format stream-json` and parses Anthropic's `rate_limit_event` from the stream (`rate-limits.ts:51–65`). `pi-ai` exposes per-call `usage` but does not surface `rate_limit_event` headers in the same shape. Options: (a) reach into `pi-ai`'s Anthropic provider response headers directly, (b) keep a one-shot `claude` CLI dependency just for this cron, (c) drop proactive capacity probing and rely on observed errors. Pick one in Phase 0 if the answer affects auth strategy; otherwise schedule a sub-task here.
   - **`CLAUDE_MODELS` / `CLAUDE_HOME_DIR` / related admin wiring** — env-var rename + dashboard label updates. Mechanical.
9. Production rollout:
   - Stage on the production server (`ssh root@85.9.213.18 /home/lastlight/deploy.sh`) for 24h.
   - Roll back plan: revert the deploy commit; the old container image is still in the registry.

**Deliverables:**
- Clean diff: ~1500 LOC removed, ~800 LOC added net.
- Updated docs.
- Production deploy.

**Validation:**
- 24h soak on production with a low-volume repo.
- Compare cost for the same workflows before vs after.

**Exit criteria:** zero references to the Claude CLI in `src/`, `deploy/`, `Dockerfile`. All workflows green for 24h.

---

## Phase 8 — Optional: native github tools (deferred, target: 3–5 days when scheduled)

**Goal:** drop `mcp-github-app` as a separate process; reimplement its tool surface as native pi tools.

**Why optional:** with `pi-mcp-adapter` and `directTools: true`, the MCP layer is essentially invisible. But it's a process-and-IPC overhead we no longer strictly need. Removing it saves a subprocess per execution and removes a dependency.

**Work:**

1. Inventory tools in `mcp-github-app/src/index.ts`. Likely 10–15 functions: list/create issue, comment, list PRs, get PR, request review, etc.
2. Reimplement each as a TypeBox-schema'd pi tool against Octokit.
3. Drop `pi-mcp-adapter` dep.
4. Drop `mcp-github-app/`.

**Deliverables:** ~10 functions in `src/tools/github/*.ts`, drop two packages, drop one subprocess per run.

**Validation:** all workflows still pass.

**Dashboard impact:** if native tools are renamed (e.g. `mcp__github__create_issue` → `github_create_issue`), update `dashboard/src/timeline/toolFamily.ts` classification and any name-keyed rules in `dashboard/src/timeline/toolRenderers.tsx`. Mechanical; ~half a day.

**Out of scope of this plan:** any other MCP servers we'd want (figma, browser, etc.) — those keep going through pi-mcp-adapter.

---

## Cross-cutting concerns

### Models & 1M context

`pi-ai`'s `models.generated.ts` declares `contextWindow: 1000000` for the relevant Anthropic models, so 1M is exposed per-model rather than via a beta header. **Phase 0 must verify** the Opus 4.7 1M variant we use today is registered. If not, it's a one-line PR to pi-mono (or a workspace patch).

### Prompt caching

Pi-ai applies `cacheControl: { type: "ephemeral" }` automatically on system prompt + tools + last user message. `PI_CACHE_RETENTION=long` enables 1h TTL where supported. Today we rely on the SDK's defaults, which are similar; expect parity, verify in Phase 0.

### Auth (subscription mode)

Pi-ai has a Pi-native OAuth path and `AuthStorage` (`auth.json`), with automatic refresh and locking. It does **not** natively read Claude Code's credential files the way this draft previously assumed. We need an explicit Last Light auth strategy:
- dedicated service-owned `auth.json` path in `stateDir`,
- custom import/bridge from Claude credentials,
- or API-key mode.

Do not leave this as "we'll see in Phase 0" if the rollout plan depends on subscription auth remaining unchanged.

### MCP config ownership

`pi-mcp-adapter` reads and merges multiple config locations (`~/.config/mcp/mcp.json`, `~/.pi/agent/mcp.json`, `.mcp.json`, `.pi/mcp.json`) and registers direct tools from metadata cache. The migration should decide:
- which file Last Light owns,
- whether Pi-owned overrides are generated,
- how adapter-specific settings (`directTools`, lifecycle, auth) are persisted,
- how metadata cache is prewarmed for non-interactive harness runs.

Assuming "the harness writes one `.mcp.json` template and the adapter reads only that" is too simplistic.

### Observability

Today we parse `total_cost_usd`, `duration_api_ms`, `num_turns` from the CLI's `result` event. After migration:
- `cost`: sum `assistantMsg.usage.cost.total` across all `message_end`s.
- `duration_api_ms`: harness times `agent.prompt()` call.
- `num_turns`: count `turn_start` events.

This is per-execution, written into `executions` as today.

### Session/event semantics

Today's dashboard behavior depends on more than "messages exist":
- workflow sessions may include subordinate `agent-*.jsonl` side sessions,
- chat threads intentionally do **not** sweep in sibling side sessions,
- live tail is file-based today.

The new event store has to preserve those distinctions explicitly or the admin UX will regress.

### Subscriber backpressure

`Agent.subscribe()` listeners are awaited in registration order. Persisting events inside the subscriber is valid, but it is on the agent's hot path. Keep inserts cheap, or buffer/batch them behind a small queue if profiling shows noticeable latency.

### Workspace bootstrap

The new executor model needs an explicit repo bootstrap layer: clone/fetch, worktree creation/resume, branch selection, and workspace-path translation. Current Last Light executor/sandbox code does not already provide the full "clone + worktree + mount" flow this draft originally implied.

### Versioning & vendoring

Pi packages are at v0.70.x with frequent breaking changes. **Pin exact versions** in `package.json` (no `^`). For `pi-mcp-adapter` (single-maintainer, third-party), consider vendoring or forking after Phase 0 audit.

### Rollback

Each phase is reversible until Phase 7. Phase 1's flag means we can ship, observe, and roll back. Phase 7 is the point of no return — schedule it after at least a week of all-workflows-on-pi running.

---

## Testing strategy

### The trust boundary changes

This is the single biggest concern of the migration and deserves explicit treatment.

**Today:** the agent process runs *inside* the Docker container. The container is the trust boundary. A bug in a tool's path validation, or a tool that bypasses validation entirely, can only corrupt container state — never the host.

**After Option A:** the agent process runs *on the host*. The trust boundary moves to **each individual tool implementation**:
- `read`/`write`/`edit`/`bash` against a workflow worktree → must dispatch through `DockerExecutor` to the container (or `LocalExecutor` for read-only host operations on the worktree dir, with strict path validation).
- GitHub API tools (`mcp-github-app` via `pi-mcp-adapter`) → run on host, but only do HTTPS to api.github.com with a scoped token. Same as today, since `mcp-github-app` already ran in the container only to be called from there; running it on the host doesn't change what it can do.

The risk we accept: a tool author who forgets to route through the executor gets host-level access by accident. We mitigate this with **structural** controls (lint, registration audit, runtime guard), not just behavioral tests.

### Mitigations baked into the tool layer

These belong in Phase 2 (sandbox model) but list them here so the test plan can reference them:

1. **Tool registration discipline.** Every tool declares an `isolationMode` at registration: `host-readonly` (github API, classifier, screen) | `host-fs-readonly` (`read`, `grep`, `find` against worktree) | `sandboxed` (`bash`, `write`, `edit` — must use `DockerExecutor` for write-capable workflows). The pi-executor refuses to start if any registered tool lacks a declared mode.
2. **Lint rule.** No file under `src/tools/` may import `fs`, `node:fs/promises`, `child_process`, or `node:child_process` directly. Filesystem and shell access must go through the `Executor` interface. Enforced in CI; bypass requires explicit `// allowlist: <reason>` with code review.
3. **Profile × mode matrix.** Each `GitAccessProfile` declares which `isolationMode`s it allows. `repo-write` permits `sandboxed` (must execute in container); `read` does not permit `sandboxed` at all. Asserted at agent construction time.
4. **Path validation as a first-class library.** A single `WorkspaceGuard` module is the only code path that resolves user-supplied paths. Tools call `guard.resolve(path)` which rejects absolute paths, `..` traversal, symlink escape, and resolves against the workspace root. Tools never `path.resolve()` themselves.

### Test categories

#### 1. Static / build-time

- **Tool import lint.** ESLint rule scanning `src/tools/**` for forbidden imports. CI gate.
- **Tool registry audit.** A test that imports the production tool registry and asserts: every tool has `isolationMode` set; every workflow profile's allowlist references only registered tools; no `sandboxed` tool appears in a profile that disables sandboxing.
- **No `claude` references after Phase 7.** A test that greps `src/`, `deploy/`, `Dockerfile` for `claude` (excluding tests and changelogs). Ratchets toward zero across phases.

#### 2. Unit

- **`LocalExecutor` / `DockerExecutor`** — shell escape (lift `shellEscape` from mom's `sandbox.ts:184`), signal/abort propagation, timeout enforcement, output truncation at 10MB, exit-code passthrough. Use a fixture container in CI.
- **`WorkspaceGuard`** — property-based tests (fast-check or similar) over: `..`, `../../`, absolute paths, paths with embedded null bytes, paths through symlinks pointing outside the workspace, paths through `/dev/null` and `/proc/*`. Must reject all.
- **`beforeToolCall` policy** — for each profile, table-driven test asserting (a) every disallowed tool is blocked with the expected reason, (b) every allowed tool runs.
- **`pi-mcp-adapter` config precedence** — given fixture configs in all four locations, assert the adapter merges in the documented order.
- **Event-stream → `BaseMessage` translator** (Phase 4) — given a recorded `AgentEvent[]` fixture, assert deterministic `BaseMessage[]` output that round-trips through the dashboard timeline processor without errors.

#### 3. Integration

- **Executor with real container.** Spin up a fresh container, run `bash echo $$ > /tmp/x; cat /tmp/x`, assert PID and contents come from the container (not host PIDs/files). Repeat for `write`/`edit`/`read`.
- **MCP adapter with fake server.** A test MCP server in `tests/fixtures/fake-mcp-server.ts` that returns canned tool definitions and echoes args. Assert direct-tools registration, env interpolation (set a sentinel `${TEST_TOKEN}`, verify it reached the server's `process.env`), and lifecycle (lazy: not connected until first call; eager: connected at startup).
- **End-to-end agent with mocked provider.** A `FakeProvider` for `pi-ai` that replays recorded responses. Run the full Phase 1 `executePiAgent` against it; assert events flow into `execution_events`, cost aggregates correctly, `ExecutionResult` matches.

#### 4. Sandbox-boundary tests (the new critical category)

These are the tests that justify the trust-boundary claim. **Each one targets a specific way the migration could regress isolation.**

- **Host-leak negative test (`read`/`bash` profile).** Build a workflow with `read` profile. Send a prompt that tries to read `/etc/passwd`. Assert: `beforeToolCall` blocks it; the run completes; `/etc/passwd` content does not appear in any event payload.
- **Container-vs-host file test.** Drop a sentinel file at `/sentinel-host` on the test host and `/sentinel-container` in the test container. Run `bash cat /sentinel-host /sentinel-container 2>&1` under `repo-write`. Assert only the container sentinel content appears in output.
- **Path-escape test.** For each fs tool (`read`/`write`/`edit`), feed paths: `/etc/foo`, `~/foo`, `../../foo`, `./../../etc/foo`, a symlinked file pointing outside workspace. Each must reject before touching the filesystem.
- **`docker exec` injection test.** Feed `bash` commands containing `$(echo pwned > /tmp/pwn)`, `; cat /etc/shadow`, backticks, `\n`-separated payloads. Assert the shell-escape layer prevents command-chain injection — the literal payload should be visible in the result, not executed as separate commands.
- **App PEM containment test.** With a `repo-write` workflow active, run `bash cat /app/data/secrets/app.pem` inside the container. Must fail (file not present in container post-Phase 2). Run the same on the host process: must also fail (the harness reads the PEM but doesn't expose it on a path readable by the agent runtime).
- **Token-scope test.** Mint a token for a `read` profile against a fixture repo. Run a workflow that tries `bash gh repo edit` (or the github MCP equivalent of a write). The token should be rejected by the GitHub API (defense in depth, even if `beforeToolCall` somehow lets the call through).
- **Network-egress baseline (optional, run during Phase 0).** With `tcpdump` or equivalent, run the spike script and confirm outbound connections are limited to `api.anthropic.com`, `api.github.com`, and the configured MCP server endpoints. Catches surprises in `pi-mcp-adapter` or `pi-ai` deps.

#### 5. Differential / golden

- **Per-workflow replay.** A small fixture set: 5–10 curated tasks per workflow type (`repo-health`, `pr-review`, `issue-triage`, `build`, `pr-fix`). For each, run the old executor and the new pi-executor against the same input and a reset target repo. Assert:
  - Output text similarity ≥ 0.85 (cosine on assistant messages, tolerating phrasing drift).
  - Set of tool names called is identical.
  - Final repo state byte-identical (for `build`/`pr-fix`).
  - Cost within 10%, token count within 15%.
- **Recorded `AgentEvent` corpus.** Capture a corpus of real `AgentEvent` streams in Phase 1 staging runs; replay them against the dashboard translator to lock down the contract.

#### 6. Adapter / third-party trust

- **`pi-mcp-adapter` source audit checklist (Phase 0).**
  - Read every line of `src/credentials/*` and `src/transport/*` (or equivalents).
  - Confirm: no telemetry, no eval/`new Function`, no writes outside the configured `.mcp.json` paths, no unexpected child processes beyond the declared MCP servers.
  - Confirm npm tarball matches GitHub source for the pinned version.
  - Decision: vendor or fork after audit.
- **Pi packages SBOM diff per release.** When bumping pi versions, run `npm ls --all` before/after and require human sign-off if new transitive deps appear.

#### 7. Resume / state

- **Workflow approval gate.** Trigger a `build`, pause at `post_architect`, kill the harness, restart it, post `@last-light approve`. Assert workflow resumes from the correct phase, agent has prior messages, the produced PR is identical to a non-interrupted run.
- **Chat thread durability.** Open a Slack thread, send 10 messages with restarts in between. Assert context is preserved (agent answers a callback question from message 3 correctly at message 10).

#### 8. Observability

- **Cost reconciliation.** Synthetic workflow with known token counts (set via `FakeProvider`). Assert `executions.cost` and `tokens` columns match within 1%.
- **Live tail SSE.** Dashboard SSE shows new events within 1 second of emission. Test with a 60-second run that emits ~50 events.

#### 9. Production canary

- **Phase 1.** Run `repo-health` weekly on `nearform/lastlight` for two cycles before promoting any other workflow. Compare cost, run duration, output structure to the prior month's baseline.
- **Phase 2–6.** Per-phase canary on a staging repo for 24 hours minimum. Roll forward only after zero unexpected errors.
- **Phase 7.** Production soak for one week with all-workflows-on-pi before deleting the old executor code.

### Test infrastructure to build (Phase 0–2)

- `tests/fixtures/test-target-repo/` — a small repo with stable issues, PRs, and a known build that the fixture tasks reference. Versioned in this repo or a sibling repo.
- `tests/fixtures/fake-mcp-server.ts` — minimal MCP stdio server with canned tools, used by integration tests.
- `tests/helpers/fake-provider.ts` — `pi-ai` provider stub that replays recorded `AgentMessageEvent` streams.
- `tests/helpers/recorded-events/` — corpus of real `AgentEvent[]` recordings for replay.
- `tests/helpers/sandbox-harness.ts` — utility for spinning up a one-shot test container with the post-Phase 2 entrypoint, used by sandbox-boundary tests.
- `tests/helpers/diff-runner.ts` — runs the same prompt through both old and new executors against a reset target repo, returns a diff report.

### What we can't easily test

- **Long-tail MCP servers** — only the ones we install. Anything users plug in via `.mcp.json` post-deploy is on them. Document this clearly in the README.
- **Real rate-limit behavior** — pi's auto-retry needs production traffic to validate. Mitigation: keep the existing rate-limit cron (Phase 7 redesign) running in shadow mode for a release.
- **Continuous secret-scanning** — point-in-time tests can't tell us we haven't quietly logged the App PEM somewhere new. Mitigation: run `gitleaks` and similar in CI; redact known secrets in event payloads before persistence.

### Test work allocation per phase

| Phase | Tests added |
|---|---|
| 0 | Adapter audit checklist; network-egress baseline; fake-provider scaffold |
| 1 | `executePiAgent` integration with `FakeProvider`; cost-reconciliation unit; first 2 workflow differential goldens |
| 2 | All sandbox-boundary tests; `LocalExecutor`/`DockerExecutor` unit suite; `WorkspaceGuard` property tests; tool import lint rule |
| 3 | `beforeToolCall` policy table tests per profile; profile × isolation-mode matrix |
| 4 | Event-stream → `BaseMessage` translator unit + golden; live-tail SSE integration; recorded-event corpus |
| 5 | Chat-thread durability; per-thread `Agent` cache eviction |
| 6 | Workflow approval-gate resume integration; reviewer-loop verdict parser unchanged-test |
| 7 | "no `claude` references" CI gate at zero; full differential suite re-run; production-soak runbook |
| 8 | Renamed-tool dashboard renderer tests |

---

## Effort summary

| Phase | Estimate | Reversible? |
|---|---|---|
| 0. Spike + adapter audit + fake-provider scaffold | 2–3 days | trivially |
| 1. Parallel executor + first differential goldens | 4–6 days | flag-flip |
| 2. Sandbox model + workspace bootstrap + boundary tests | 7–9 days | revert sandbox.ts |
| 3. Permission gates + profile policy tests | 2–3 days | revert |
| 4. Session storage + dashboard UI + translator goldens | 7–9 days | dual-read window |
| 5. Chat migration + thread-durability tests | 3–4 days | revert chat.ts |
| 6. Runner + gates + approval-resume tests | 3–4 days | revert |
| 7. Cleanup + production soak | 3 days | last-mile only |
| 8. Native github (deferred) | 3–5 days | when scheduled |

**Total (Phases 0–7): ~4.5–5.5 weeks of focused work.** Estimates now include test scaffolding called out in the *Testing strategy* section. They assume Phase 0 doesn't surface a blocker. The four largest sources of estimate fragility are (a) workspace-bootstrap design in Phase 2 (we are *adding* a layer the current sandbox doesn't own), (b) session-identity model in Phase 4 (must preserve workflow-vs-chat dashboard semantics), (c) dashboard `AgentEvent`→`BaseMessage` translation fidelity, and (d) sandbox-boundary test coverage in Phase 2 (this is what justifies the trust-boundary claim — under-testing it defeats the migration). Phase 8 anytime after.

## Open questions

1. **Subscription auth strategy** — do we use a Last Light-owned Pi `auth.json`, build a one-time Claude-credential import bridge, or switch the harness to API-key mode?
2. **Model registration** — is Opus 4.7 1M in pi-ai's registry? (Phase 0.)
3. **`pi-mcp-adapter` audit** — anything to be wary of in the exact pinned version we ship, especially around direct-tools cold start, config precedence, and OAuth?
4. **Container lifecycle** — long-lived per-task vs spawned-per-run? (Phase 2.)
5. **Pi's `SessionManager` jsonls** — write them as a debug aid, or skip? (Phase 4.)
6. **API-key vs OAuth in production** — do we want to switch to API key now that pi makes both equally easy? (Phase 7.)
