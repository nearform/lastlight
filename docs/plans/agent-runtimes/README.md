# Pluggable agent runtimes and live sessions

> **Status (2026-10-05): design settled, spike done, not implemented.**
> Tracking umbrella: [#434](https://github.com/nearform/lastlight/issues/434).
> The decisions below come from a design review held after the
> `spike/live-sessions` spike and **override anything in files 00–09 that
> conflicts with them**. Those files are kept as background and evidence; each
> carries a banner saying what still applies.

## Two projects, not one

The original design bundled two goals that turned out to be independent:

- **A. Live sessions.** Cancel a running agent gracefully and steer it from
  the admin UI. Built on agentic-pi's native Pi path, which the spike measured
  as the strongest controllable runtime (true mid-run steer, deny with reason,
  input patching, native cost, fail-closed gate). Nothing in A needs another
  runtime.
- **B. Pluggable runtimes.** Teams can run Claude Code (and later Codex and
  OpenCode) instead of Pi. This is a **product choice**, not a quality bet:
  some teams simply want Claude Code or Codex. Evals inform the choice; they
  don't gate it.

A ships first and does not wait on B. B mostly adds degradations to A's
control surface (queued steers, no deny reason, cumulative usage), so it
declares them rather than shaping A around them.

## Architecture

```
lastlight core ──(argv + JSONL out + control JSONL in)──► agentic-pi run [--runtime X] [--control stdin]
                                                          ├─ pi (default)           → Pi SDK (native tools, steer, patch)
                                                          └─ claude|codex|opencode  → embedded acpx ⇄ ACP adapter
                                                                                         └─ MCP ⇄ agentic-pi mcp-github
```

**agentic-pi is the single seam.** Core only ever runs `agentic-pi run`. There
is no runtime fork in core, no `AgentRuntime` interface, no separate
`lastlight-agent-bridge` package and no `AgentEvent` decoder.

## Locked decisions

### Shared

1. **The event contract stays agentic-pi's `EmitterRecord` JSONL** (Pi-shaped)
   for every runtime. Core stays a typed consumer. Where an ACP runtime has to
   synthesise a field (cumulative usage on the last message, synthesised turn
   boundaries, deny reasons delivered as a follow-up turn), the **record
   itself** says so (e.g. `usage.cumulative: true`, `synthesized: true`), not
   only a capabilities header. Cross-runtime numbers in scorecards and
   dashboards use only fields every runtime reports for real: total cost, tool
   calls, wall time and outcome. The `AgentEvent` v1 schema in
   [`02`](02-agent-event-schema.md) is **not built**. Moving `EmitterRecord`
   into `lastlight-workflow-engine` later is a mechanical change if it is ever
   wanted.
2. **Static rules run in the sandbox; core handles only what the sandbox can't
   know.** Deterministic limits (turn cap, per-phase spend cap, a breaker for a
   repeated failing call, command classes, edit scope) live in agentic-pi.
   They need no channel and work on every backend, k8s included. The control
   channel exists only for decisions that need a human, an LLM judge, or state
   held in core.
3. **Any future guardian runs in core**, never in the sandbox: the LLM judge
   needs a model key that must not go in, the guardian must outlive a crashed
   sandbox, and the agent must not be able to tamper with it.

### A — live sessions ([`10`](10-live-sessions.md))

4. **The MVP is graceful cancel plus steering from the admin UI.** No steering
   from issue/PR comments or Slack. No guardian rules. No tool approvals, and
   approving a `git push` is explicitly not an approval step.
5. **Cancel = abort, then a 10 s grace period, then kill.** The existing
   "Cancel run" sends `{"type":"abort"}` first, so the transcript ends cleanly
   and the phase records its real cost as `cancelled`. There is no "stop this
   phase but continue the workflow" action.
6. **One UI verb: "Send message" = `steer`.** No `follow_up` in the UI. A steer
   that arrives after `agent_end` is rejected and reported as undelivered,
   never silently turned into a follow-up. Every message shows *sent → acked →
   landed* (the turn it was injected at), carries the actor, and appears in
   the transcript as a distinct record.
7. **The control channel is always on** for docker, smol and in-process runs
   (core always passes `--control stdin` / `run({control})`). agentic-pi stays
   opt-in by default for external npm consumers. Stdin EOF means "no more
   commands", not abort.
8. **Backends:** docker, smol, in-process and Fake carry control. k8s reports
   `control: false`; no production runs on k8s yet. A phase whose config
   *requires* control (once approvals exist) fails at dispatch on such a
   backend instead of starting and timing out.
9. **The seam is built and documented, with no rules on it.**
   `SessionControl` and `SessionObserver` are ports in
   `lastlight-workflow-engine`. Control-capable adapters return a
   `SessionControl` from `runAgent`. The orchestrator keeps an in-memory
   `executionId → SessionControl` registry (the harness, the admin API and the
   orchestrator share one process). Observers are registered in code only:
   **no `guardian:` YAML key** until a guardian exists, and **no `decide()`**
   until approvals have a first user.
10. **Steer timing stays at the turn boundary** for v1. Delivering a steer
    between tool calls within a batch is a follow-up, if the *landed* display
    shows it matters.

### B — pluggable runtimes

11. **Claude Code first**, because Nearform wants it. Codex and OpenCode follow
    in the production track.
12. **Let Claude be Claude, within parity contracts.** It keeps its own system
    prompt and built-in tools (Task subagents, TodoWrite, …). It must still
    hold to: config isolation (no ambient config, commands or skills; only the
    phase's declared skills); the same egress and web policy as Pi; and the
    same deterministic limits. Subagent cost must roll into the phase total.
13. **Static policy parity per runtime:** a native pre-execution hook where
    one exists (Claude: a `PreToolUse` hook in the isolated config home calling
    `agentic-pi hook claude-pretool`, which runs the same policy code as the Pi
    path). Otherwise a `git diff` post-check that **fails** the phase (never a
    silent revert). Each runtime declares
    `policy.coverage: {bash, edit: pre|post|none}` in `runtime_status`, and the
    conformance suite asserts it. A phase whose policy needs prevention runs
    pinned to `pi` on runtimes that can only post-check.
14. **No per-runtime prompt or skill forks.** Skills use each runtime's native
    mechanism, staged into the isolated config home. For MCP-backed runtimes,
    agentic-pi appends one generated system-prompt line mapping `github_*` to
    `mcp__lastlight__github_*`. Conformance counts tool-not-found errors.
15. **The evidence gate is conformance, not quality.** A runtime is offered
    once it does the workflow's job correctly: artifacts present 100%,
    `VERDICT` parsed, cost accurate (subagents and cancelled turns included),
    isolation held, zero tool-not-found. Human grades (first) and cost are
    **reported** per runtime in the evals dashboard so teams choose with the
    numbers, but they never block.
16. **Evals-first footprint.** Until the production track ships, `runtime` is
    set only by the evals barrel; the config loader rejects a `runtime:` key in
    workflow YAML and instance config.
17. **Production config:** the instance declares `runtimes.available` and
    `runtimes.default`. A repo picks from that list via a new `runtime` key in
    `.lastlight/` config, and sets its own models through the existing
    `models.*` key within `repoConfig.allowedModels`. Workflow YAML may pin a
    phase to `pi` only. API keys stay with the instance.
18. **Runtime/model mismatch falls back per phase.** If a phase's resolved
    model isn't runnable on the repo's runtime, that phase runs on the
    instance default runtime and a `runtime-model-mismatch` `RepoConfigWarning`
    is raised (it shows in the dashboard `RepoConfigPane` and `lastlight repo
    config validate`). It is never a silent model swap. `executions.runtime`
    (both dialects) and a per-phase runtime badge, with the fallback reason,
    make the mix visible.
19. **Claude in images:** a host-side derived image. When an instance enables
    Claude, `server update` builds a thin image `FROM` the pulled public
    sandbox image and installs the lockfile-pinned `claude-agent-acp`. Nothing
    proprietary goes into the public GHCR images. Codex (Apache-2.0) and
    OpenCode (MIT) go straight into the public images.
20. **Auth:** API keys (or the instance's existing provider route) first.
    Subscription login for ACP runtimes follows whatever
    [#401](https://github.com/nearform/lastlight/issues/401) settles for Pi.
21. **Rejected:** omnigent, herdr, rivet sandbox-agent, and routing Pi through
    `pi-acp` (see [`01b`](01b-prior-art.md), [`09`](09-risks.md) item 14).

## Work breakdown

See [`08-rollout.md`](08-rollout.md). Each item has its own issue linked from
#434.

## Files

| File | What it covers | Status |
|---|---|---|
| [`00-current-coupling.md`](00-current-coupling.md) | Every place core assumes agentic-pi | Evidence; still accurate |
| [`01-acp-and-adapters.md`](01-acp-and-adapters.md) | ACP spec state and the three adapters | Background |
| [`01b-prior-art.md`](01b-prior-art.md) | Off-the-shelf survey and the build/adopt decision | Updated 2026-10-05 |
| [`02-agent-event-schema.md`](02-agent-event-schema.md) | `AgentEvent` v1 schema | **Not built** (decision 1) |
| [`03-runtime-seam.md`](03-runtime-seam.md) | `AgentRuntime` in core | **Not built** (single seam) |
| [`04-bridge.md`](04-bridge.md) | `lastlight-agent-bridge` | **Not built**; its run flow moved into agentic-pi |
| [`05-github-mcp.md`](05-github-mcp.md) | GitHub tools over MCP | Applies, served by `agentic-pi mcp-github` |
| [`06-config-and-capabilities.md`](06-config-and-capabilities.md) | Config and capability matrix | Config superseded by decisions 16–18; matrix still useful |
| [`07-evals-harness-comparison.md`](07-evals-harness-comparison.md) | Runtimes in `apps/evals` | Applies, but the gate is conformance (decision 15) |
| [`08-rollout.md`](08-rollout.md) | Work breakdown | **Rewritten 2026-10-05** |
| [`09-risks.md`](09-risks.md) | Risks and open questions | Updated 2026-10-05 |
| [`10-live-sessions.md`](10-live-sessions.md) | Live sessions: the design and the spike results | **Current** |

## Glossary

- **Runtime:** the coding-agent harness a phase runs (`pi`, `claude`, `codex`,
  `opencode`), selected with `agentic-pi run --runtime`. Separate from the
  **model** and from the **sandbox backend** (docker / smol / k8s / none /
  gondolin).
- **ACP:** Agent Client Protocol, JSON-RPC over stdio between a client (here
  agentic-pi's `acp-runner.ts`, via embedded acpx) and an agent.
- **Adapter:** a process that speaks ACP for an agent that doesn't natively
  (`claude-agent-acp`, `codex-acp`). OpenCode speaks it natively.
- **Control channel:** JSONL commands into a running session
  (`prompt`, `steer`, `follow_up`, `abort`, later `decide`), answered by
  records on the event stream.
- **Steer:** advisory context delivered at the next turn boundary.
  **Approval:** a synchronous, fail-closed decision on a single tool call
  (deferred).
