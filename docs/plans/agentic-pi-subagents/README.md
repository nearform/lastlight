# agentic-pi subagents

Give the agent a way to delegate independent work to child agents with their
own context windows — fresh or forked from the parent — so parallel work
(multi-package analysis, multi-file review, competing hypotheses) is not
serialised through one context.

## Status

Spike done, design drafted, **nothing built.**

## Documents

- [00-spike-findings.md](00-spike-findings.md) — the zero-code bash-spawn
  spike, with measurements.
- [01-design.md](01-design.md) — the in-process design.

## What the spike settled

- Fan-out **works with no code at all** — a prompt plus the `bash` tool is
  enough, and the children really do run concurrently.
- On a small task it was **1.7x slower and 3.7x more expensive** than doing the
  work serially, but it also produced materially deeper analysis. The arms did
  not do the same work, so that ratio is not a like-for-like verdict.
- The overhead is **not process startup** (~1s). It is context re-establishment
  in each child, and the parent's synthesis tail.

## Locked decisions

1. **In-process child `AgentSession`s.** Not spawned `pi` (loses the 36
   `github_*` tools, the profile gate, sandbox overrides, auth isolation) and
   not spawned `agentic-pi` (re-mints tokens, cannot nest a sandbox, no route
   to forked context).
2. **Agent definitions copy upstream Pi's format** (`examples/extensions/
   subagent/`) — markdown + `name/description/tools/model` frontmatter — so
   definitions port both ways. We do not copy its subprocess execution model.
3. **Operator-supplied agent dirs only**, via a new `--agent-dir` mirroring
   `--skill`. No project-local `.pi/agents` discovery: a repo-controlled system
   prompt attached to an agent holding a GitHub token is privilege escalation,
   and we run against untrusted PRs unattended.
4. **Depth 1**, enforced at registration time by not giving children the tool.
5. **Read-only children in phase 1.** The real deployment runs `--sandbox none`,
   so parallel children share one worktree. Parallel editing needs a worktree
   per child; deferred.
6. **Usage rollup ships in phase 1 or the feature does not ship.** 73% of the
   spike's spend happened inside children; without the rollup every fan-out run
   under-reports cost ~4x.
7. **Every new event is gated** so a run with no subagent leaves the golden
   JSONL fixtures byte-identical (agentic-pi hard rule #2).

## Open question

Whether fan-out earns its cost on *real* lastlight phases rather than a
48-second toy. The spike says the win scales with per-child duration against
~43s of fixed overhead. Worth re-running the measurement against an actual
review or explore phase before committing to phase 3.
