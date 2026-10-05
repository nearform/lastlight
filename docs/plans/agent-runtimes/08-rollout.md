# 08 — Rollout

Each phase ships independently and leaves `main` releasable. Evals support is
built **into** each phase, never deferred.

> **2026-10-05 — restructured by the single-seam decision
> ([`10`](10-live-sessions.md) S3).** The ACP runtimes live *inside*
> agentic-pi (`--runtime`), so core needs no runtime seam, decoder or
> `AgentEvent` schema: it keeps consuming Pi-shaped JSONL and only passes
> `--runtime`. The bridge package (P3) and the core `Sandbox.execAgent` split
> (P1) shrink to "agentic-pi grows `acp-runner.ts` + `mcp-github`" and "core
> passes `--runtime` + persists it". The phases below are kept for history;
> read them through that lens.

## P0 — Spike (about a week, throwaway branch)

- Run each adapter (`claude-agent-acp`, `codex-acp`, `opencode acp`) in the
  sandbox image **and** on the host. Give each a scripted task: read a file,
  run bash, edit, call a stub MCP tool, end with `VERDICT:`.
- Capture raw ACP transcripts as fixtures.
- Settle every **[UNVERIFIED]** in [`01`](01-acp-and-adapters.md) and
  [`06`](06-config-and-capabilities.md).
- **Bridge client choice:** embed `acpx`'s runtime vs a hand-rolled client on
  the ACP SDK ([`01b`](01b-prior-art.md)).
- **Clamp choice:** does a `bash` wrapper on PATH catch every shell each agent
  spawns?
- **Licensing go/no-go** for Claude in images ([`09`](09-risks.md) item 1).

**Accept when:** a fixture is committed per adapter, the verification table is
filled in, both choices are written down, and there is a licensing decision.

## P1 — Seam, Pi only, no behaviour change

- `AgentEvent` + the Pi decoder (in a new `packages/agent-bridge`, events
  module only).
- `AgentRuntime` with `PiRuntime`; `Sandbox.execAgent`; argv instead of
  `sh -c`; the generic k8s script; core-owned `AgentRunSummary`.
- Accumulator, shim and spans consume `AgentEvent`.
- `runtime` on `ExecutorConfig` / `ExecutionResult`; the `executions.runtime`
  column on **both dialects**.
- Evals: `Arm` carries `runtime` (agentic-pi only), and scorecard provenance
  stamps it.

**Accept when:**
- full CI is green;
- a **golden test** shows agentic-pi's `test/fixtures/*.jsonl` produce
  byte-identical transcripts and an identical `ExecutionResult` through the old
  and new paths;
- one pr-review eval run on agentic-pi lands inside the existing repeat band
  (`scripts/band.ts`).

## P1.5 — Live sessions on agentic-pi

See [`10-live-sessions.md`](10-live-sessions.md). `SessionControl` on the
runtime seam (stdin for docker/smol/none), `approval_*` / `control_*` in the
shim, aborted-run classification, a `guardian:` phase config, and a
maintainer steer/abort control in the dashboard.

**Accept when:** the spike's steer / deny-with-reason / abort / fail-closed
scenarios pass as an AI-free mechanism test plus one live docker run.

## P2 — GitHub core + MCP server

- The `github/core.ts` refactor and the `exports` map in agentic-pi.
- `lastlight-agent-bridge mcp-github`.

**Accept when:**
- agentic-pi fixtures are unchanged;
- `tools/list` names equal `PROFILE_TOOLS[p]` for all four profiles, with a
  schema parity test;
- the AI-free `mechanism.test.ts` fake-ACP case passes against fake-github.

## P3 — Bridge + Claude Code (`none` + docker)

- The ACP client, isolated config home, `hook claude-pretool` (plus the wrapper
  if P0 chose it), file tracking and cost.
- The `claude-code` runtime, the `--runtime` evals flag, `runAgentOnce` in the
  barrel, and the evals dashboard runtime column.
- The `lastlight-evals` skill updated.

**Accept when:**
- the **runtime conformance suite** (cheap, deterministic, Haiku-class) passes:
  - an artifact is written and `VERDICT` is parsed;
  - a blocked `npm install` returns the reason;
  - `sleep 99999` is killed at the gate;
  - tool names are canonical, `cost > 0`, and `files.changed` is correct;
  - cancel / timeout gives a clean `run.error`;
  - the AGENTS.md canary rule is obeyed;
  - the ambient-skill canary is **not** visible;
- the **harness comparison gate** passes: pr-review `agentic-pi × sonnet` vs
  `claude-code × sonnet`, `--repeats 4`, train + blind split. It is scored on
  human grades first. The F1 bands must overlap or better, post-review
  artifacts must be present in 100% of cases, and tool-not-found errors must be
  counted and reported.

## P4 — Codex + OpenCode

- Runtime configs, the permission tier, estimated cost.

**Accept when:**
- the conformance suite passes, with each runtime's documented degradations
  asserted as expected (not skipped);
- comparison arms run: `codex × gpt-5.x` vs `agentic-pi × same model`, and
  `opencode × X` vs `agentic-pi × X`.

## P5 — Breadth

- k8s and smol `execAgent` for ACP runtimes.
- Fan-out concurrency caps per (backend × runtime).
- OpenInference spans from `AgentEvent`.
- The prod dashboard `PhaseDetailPanel` runtime badge.
- `doctor` wired into `sandbox-preflight`.
- `docs-sync`: `apps/server/spec/*.md`, `apps/www`, and the CLAUDE.md fixes
  from [`00`](00-current-coupling.md).

**Accept when:** a k8s e2e run passes per runtime, a fan-out of 6 passes on
docker, and a Phoenix trace shows AGENT → TOOL with totals.

## P6 — Later

- The repo-level `runtimes` allowlist.
- Subscription OAuth (Claude Max, ChatGPT).
- `session/load` resume.
- Revisit routing agentic-pi through `pi-acp` ([`09`](09-risks.md) item 14).
