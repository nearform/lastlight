# 08 — Rollout

> **Rewritten 2026-10-05** after the design review recorded in the
> [README](README.md). The earlier P0–P6 phases assumed a core runtime seam, an
> `AgentEvent` decoder and a separate bridge package; none of those is built
> (single seam: everything goes through `agentic-pi run`). P0, the spike, is
> done (`spike/live-sessions`, results in [`10`](10-live-sessions.md)).

Each item is its own issue, linked from the umbrella
[#434](https://github.com/nearform/lastlight/issues/434). Each ships
independently and leaves `main` releasable. Evals support is built into each
item, never deferred.

```
1 static run limits ──┐
                      ├──► 3 Claude Code runtime (evals-first) ──► 4 runtimes in production
2 live sessions ──────┘       (needs 1 for policy parity)
5 guardian + approvals: parked until an LLM-judge use case exists (builds on 2)
```

## 1 — agentic-pi static run limits ([#437](https://github.com/nearform/lastlight/issues/437))

Static rules run in the sandbox (README decision 2).

- `--max-cost-usd`: a per-phase spend ceiling from agentic-pi's per-message
  cost.
- A repeated-failure breaker: the same failing tool call N times ends the run.
- `edit_scope`: a command-policy glob that blocks write/edit outside it, with
  a reason.
- A new stop reason (e.g. `budget_exceeded`) that core classifies as a
  failure, never success. Phase config passes the limits through.

**Accept when:** each limit has an AI-free test and a JSONL fixture (hard
rule 2), core classifies each stop reason correctly, and default runs with no
limit set are byte-identical.

## 2 — Live sessions: graceful cancel and admin-UI steer ([#438](https://github.com/nearform/lastlight/issues/438))

[`10`](10-live-sessions.md) has the design.

- agentic-pi: harden `--control stdin` from the spike, with `ControlCommand`
  and the control records in `EmitterRecord`; port `test/control.test.ts`; a
  fixture per new record type.
- `SessionControl` / `SessionObserver` ports in `lastlight-workflow-engine`;
  adapters for docker, smol, in-process and Fake; k8s reports
  `control: false`.
- Core always passes control; an in-memory `executionId → SessionControl`
  registry; observers set from code only.
- Cancel = abort → 10 s grace → kill; the phase records `cancelled` with its
  real cost; the run is `cancelled`.
- Admin UI "Send message" (steer only) with sent/acked/landed state and the
  actor; the shim renders control records.
- The seam documented in `apps/server/src/workflows/CLAUDE.md` and the spec.

**Accept when:** an AI-free mechanism test drives steer, abort and steer after
the end through the Fake sandbox; one live docker run shows a steer landing
and a graceful cancel with cost recorded; cancel works on in-process and smol,
not only docker.

## 3 — Claude Code runtime, evals-first ([#439](https://github.com/nearform/lastlight/issues/439))

- agentic-pi: `acp-runner.ts` (embedded acpx) and `mcp-github`, marked
  experimental in its CLAUDE.md and `--help`. Pi-shaped records with
  synthesised fields marked per record (README decision 1). Hard rule 1
  relaxed to "the Pi path never uses MCP".
- The GitHub tools refactored into a Pi-free core (see
  [`05`](05-github-mcp.md)), with a schema-parity test against
  `PROFILE_TOOLS`; an `exports` map replacing the deep `agentic-pi/dist/*`
  imports.
- Parity contracts: isolated config home, the same egress/web policy, the same
  limits; the `PreToolUse` hook (`agentic-pi hook claude-pretool`); declared
  `policy.coverage`; native skill staging; the generated tool-name line;
  `thinking`, `--gate-timeout` and `--max-steps` mapped; subagent cost rolled
  up.
- Core: `runtime` on `ExecutorConfig`, set only by the evals barrel; the
  config loader rejects `runtime:` in workflow YAML and instance config.
- Evals: a `--runtime` arm axis with scorecard provenance, shown in the evals
  dashboard.

**Accept when:** the $0 conformance suite passes: artifact written and
`VERDICT` parsed; a blocked command returns its reason; an out-of-scope edit
is prevented; `cost > 0` and matches provider usage (subagents and cancelled
turns included); tool names canonical; zero tool-not-found; the AGENTS.md
canary is obeyed; the ambient-skill canary is **not** visible. Then the
reported (non-gating) comparison: pr-review `pi × sonnet` vs
`claude × sonnet`, `--repeats 4`, train + blind, human grades first, with cost
per case, shared with Nearform.

## 4 — Runtimes in production ([#440](https://github.com/nearform/lastlight/issues/440))

- Config: `runtimes.available` / `runtimes.default` in instance config; a repo
  `runtime` key in `.lastlight/` (schema in `packages/shared`), validated
  against `available`; workflow YAML can pin a phase to `pi` only.
- A per-phase fallback on runtime/model mismatch with a
  `runtime-model-mismatch` warning; `executions.runtime` on **both** dialects;
  a phase runtime badge with the fallback reason.
- The Claude image: `server update` builds a host-side derived image with the
  lockfile-pinned `claude-agent-acp` when an instance enables Claude.
- Codex and OpenCode, in the public images, each with its own declared
  degradations asserted by the conformance suite.

**Accept when:** a Nearform repo runs pr-review on Claude in production end to
end; a mismatch shows the warning and the badge; the conformance suite passes
per runtime with degradations asserted, not skipped.

## 5 — Guardian agents and tool approvals, parked ([#441](https://github.com/nearform/lastlight/issues/441))

Builds on item 2's seam: a `guardian:` phase config, `decide()` on
`SessionControl`, approvals that fail closed, and dispatch-time refusal on
backends without control. Opened when there's a concrete LLM-judge use case
with an eval behind it.

## Later / not planned

- k8s control (a dial-out `/internal/sandbox-control` WebSocket) and k8s
  execution for ACP runtimes, once production runs on k8s.
- Steering from issue/PR comments and Slack.
- Subscription login for ACP runtimes: follows
  [#401](https://github.com/nearform/lastlight/issues/401).
- `session/load` resume.
