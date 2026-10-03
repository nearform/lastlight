# 00 — Current coupling to agentic-pi (evidence)

Everything here was read from the tree on 2026-10-03. Line numbers drift;
re-grep before relying on one.

## The call path

```
workflows/runner.ts  runWorkflow → EnginePorts.agent (~L680)
  └ workflow-engine core/phase-executor.ts  runLedgeredPhase
      → deps.agent.runAgent(prompt, phaseConfig, {taskId, githubAccess, onSessionId, timeoutSeconds})
  └ engine/agent-executor.ts  executeAgent → prepareRun (mint token, build env)
  └ engine/executors/orchestrator.ts  runSandboxedAgent → withSandbox
      → withWorkspaceArtifacts (AGENTS.md, build assets)
      → runAgentIn (L347): skill staging, AgenticShim, RunResultAccumulator,
        AgentSpanTree, then sandbox.runAgent(taskId, prompt, RunAgentOpts, onEvent)
  └ sandbox/sandbox.ts  Sandbox.runAgent → per-backend adapter
```

Fan-out bypasses the engine port: `workflows/handlers/fanout.ts` →
`withAgentSession` → `withSandboxSession` → `runAgentIn` per branch.

## How agentic-pi is launched, per backend

| Backend | Where | What runs |
|---|---|---|
| docker | `sandbox/docker.ts:377-480` | `docker exec -i … sh -c "agentic-pi run --model … --sandbox none --gate-timeout N [--thinking] [--profile] [--web-search…] [--skill dir]… --no-skills"`, prompt on stdin. Per-flag charset allowlists exist because the argv is a `sh -c` string |
| smol | `sandbox/smol.ts:224-330` | `smolvm machine exec … -- agentic-pi run …` (no `sh -c`) |
| kubernetes | `sandbox/k8s/run-agent-script.ts`, `kubernetes-sandbox.ts:317-353` | Pod script `agentic-pi run "$1" … --no-session < PROMPT_FILE`, values bound positionally; logs streamed back (one-way) |
| none / gondolin | `sandbox/sandbox.ts:621-690` | In-process `await import("agentic-pi")` → `run({...onEvent})` |

`RunAgentOpts` (`sandbox.ts:170-220`) is agentic-pi-shaped, and its types come
from `import type { run, RunResult, ThinkingLevel } from "agentic-pi"`.

## The wire back

- Subprocess backends: JSONL on stdout → `parseLine` (`sandbox.ts:~953`) →
  `onEvent(record)`. Last 8 KB of stderr kept for errors.
- In-process: same records via `CollectorSink(onEvent)` plus the returned
  `RunResult`.
- Records: header `{type:"session",id,cwd}`, then Pi `AgentSessionEvent`s passed
  through verbatim (`message_end` with usage + cost, `tool_execution_*`,
  `agent_end{messages}`, `turn_*`, `auto_retry_*`), plus agentic-pi's own
  `extension_status`, `skills_status`, `sandbox_status`, `command_policy`,
  `usage_snapshot`, `fatal_error`, `max_steps_reached`.

## Every coupling point

**Imports**
- `sandbox/sandbox.ts:5` (types) and the dynamic `run` import
- `engine/executors/shared.ts:3` (`RunResult`, `ThinkingLevel`) — **core uses
  agentic-pi's `RunResult` as its own result DTO** (`RunResultAccumulator.build`,
  `finalizeFromRunResult`, `mapStopReason`)
- `sandbox/k8s/kubernetes-sandbox.ts:2`
- `engine/event-shim.ts:1`, `engine/chat/chat.ts:8` (`EmitterRecord`)
- Deep paths: `config/provider-registry.ts:29`
  (`agentic-pi/dist/providers.js`), `engine/executors/orchestrator.ts:25`
  (`agentic-pi/dist/command-policy.js`),
  `apps/evals/src/mechanism.test.ts:12`. agentic-pi (v0.7.0) has **no
  `exports` map**, which is the only reason these resolve.
- `apps/evals/src/phase-replay-node.ts:247` calls `run()` directly.

**Pi event semantics consumed by name**
- `RunResultAccumulator`, `extractAgentError`, `mapStopReason`,
  `reclassifySuccess` (`engine/executors/shared.ts:259-760`)
- `AgenticShim.translate` (`engine/event-shim.ts`) — writes the Claude-SDK-style
  envelope transcripts both dashboards read
- `telemetry/pi-events.ts` (`AgentSpanTree`, `recordPiEvent`),
  `telemetry/openinference.ts`
- Hardcoded `"agent.runtime": "agentic-pi"` at `engine/agent-executor.ts:427`
  and `workflows/handlers/fanout.ts:752`

**Persisted / displayed**
- `ExtensionStatusMap` / `SkillsStatus` on `ExecutionResult`
  (`workflow-engine/core/types.ts`), columns in `state/schema/{sqlite,pg}.ts`,
  rendered by `dashboard/.../PhaseDetailPanel.tsx`. **No runtime column.**

**Prompts**
- 43 files under `apps/server/{workflows,skills,agent-context}` name `github_*`
  tools literally (e.g. `github_add_issue_comment`, `github_publish`).

**Packaging**
- `apps/server/sandbox.Dockerfile` vendors agentic-pi via `pnpm deploy`;
  `deploy/sandbox-entrypoint.sh`, `scripts/dev-local.sh`,
  `deploy/native/install.sh`.

## What is already runtime-neutral

- `AgentPort` / `ExecutionResult` (minus `extensions`/`skills` naming).
- Structured outputs: final-text markers (`VERDICT:`, `BLOCKED`) and files the
  agent writes in the workspace (`.lastlight/pr-review/findings.json`, …).
- Workflow-level approvals (`approval_gate`) — nothing approves individual tool
  calls today.
- Workflow resume is ledger-driven (`executions`), not agent-session-driven.

## Stale docs found along the way

- CLAUDE.md files say the sandbox runs `agentic-pi run --format json`. No code
  passes `--format`, and `args.ts` would throw `unknown flag` if it did; JSONL
  is simply the default.
- docker and smol don't pass `--no-session`, so Pi writes a session file
  inside the container that is discarded with it. k8s and in-process do pass
  it.
- In-process (`none`) agent runs **cannot be killed** — `run()` takes no
  `AbortSignal` (`phase-replay-node.ts:248`); a wedged eval session once ran 40
  minutes.
