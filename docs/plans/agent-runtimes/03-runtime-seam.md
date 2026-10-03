# 03 — The runtime seam in core

## Principle

The engine's `AgentPort` stays exactly as it is. The seam goes **between
isolation and invocation**, which today are fused inside each `Sandbox`
adapter. A sandbox should know how to run an argv somewhere and stream its
stdout back. A runtime should know which argv to run and how to read what
comes back.

## `AgentRuntime` (new: `apps/server/src/engine/runtimes/`)

```ts
interface AgentRuntime {
  id: "agentic-pi" | "claude-code" | "codex" | "opencode";
  protocol: "pi" | "acp";
  capabilities: RuntimeCapabilities;            // matrix in 06
  supportsBackend(b: SandboxBackend): boolean;  // ACP runtimes: never gondolin
  translateModel(spec: string):
    { ok: true; id: string } | { ok: false; reason: string };
  buildInvocation(spec: AgentRunSpec, target: InvocationTarget): AgentInvocation;
  createDecoder(): (line: Record<string, unknown>) => AgentEvent[];
  /** agentic-pi on none/gondolin only — the existing in-process path. */
  runInProcess?(spec: AgentRunSpec, onEvent: (e: AgentEvent) => void):
    Promise<AgentRunSummary>;
}

/** Runtime-neutral; replaces the agentic-pi-shaped RunAgentOpts. */
interface AgentRunSpec {
  model: string; thinking?: ThinkingLevel; profile?: string;
  cwd: string; contextFile: string; skillDirs?: string[];
  webSearch: boolean; webSearchProvider?: string;
  commandPolicy?: CommandPolicy; gateTimeoutSeconds: number;
  timeoutSeconds: number; maxTurns?: number;
  githubApiBaseUrl?: string; providers?: ProviderOverrides;
  env: Record<string, string>;
}

interface AgentInvocation { argv: string[]; env: Record<string, string>; stdin: string }
```

Two implementations ship: `PiRuntime` (`agentic-pi run …`, Pi decoder from the
bridge package) and `AcpRuntime(id)` (`lastlight-agent-bridge run --runtime
<id> …`, AgentEvent pass-through decoder).

## Splitting `Sandbox.runAgent`

`Sandbox.runAgent(taskId, prompt, RunAgentOpts, onEvent)` becomes pure
transport:

```ts
execAgent(taskId: string, inv: AgentInvocation,
          onLine: (line: Record<string, unknown>) => void):
  Promise<{ exitCode: number; timedOut: boolean; stderrTail: string }>;
```

| Backend | `execAgent` |
|---|---|
| docker | `docker exec -i -e K=V … <ctr> <argv…>` — **argv, not `sh -c`**. The per-flag charset allowlists (`docker.ts:378-449`) go away with the shell string |
| smol | `smolvm machine exec … -- <argv…>` (already shell-free) |
| kubernetes | generic pod script: `"$@" < PROMPT_FILE; rc=$?` plus the existing artifact-upload and cgroup-usage blocks. The whole argv is bound positionally, so it stays injection-proof and runtime-agnostic |
| none | host child process with cwd, env and a **kill timer** (process group). A new capability: in-process agents can't be killed today |
| gondolin | agentic-pi only, via `runInProcess` |

`provision`, `stageSkills`, `sandboxPathFor`, `runCommand`, `dispose` and
`usage` are unchanged.

## Orchestrator flow (`runAgentIn`, `orchestrator.ts:347`)

1. Resolve the runtime: `config.runtime` → `runtimes.default` → `agentic-pi`.
   Check `supportsBackend`.
2. Build the `AgentRunSpec` from what `prepareRun` already computes.
3. Call `runtime.runInProcess` if it exists and the backend is none or
   gondolin. Otherwise call `sandbox.execAgent(runtime.buildInvocation(spec))`.
4. Pipe every line through `runtime.createDecoder()`. Send the resulting
   `AgentEvent`s to the accumulator, the shim, the span tree and the log.

## Consumers move to AgentEvent

| Today | After |
|---|---|
| `RunResultAccumulator.feed(piRecord)` → agentic-pi `RunResult` | `feed(AgentEvent)` → core-owned **`AgentRunSummary`** |
| `finalizeFromRunResult`, `mapStopReason`, `extractAgentError`, `reclassifySuccess` | same logic over `run.completed` / `run.error` / `usage` |
| `AgenticShim.translate(piRecord)` | `translate(AgentEvent)`. **It writes the same Claude-SDK-style envelopes**, so the server dashboard, the evals dashboard and `apps/evals/src/metrics.ts` don't change |
| `telemetry/pi-events.ts` `AgentSpanTree` | renamed to agent-events; LLM spans carry totals when per-message usage is absent |
| `"agent.runtime": "agentic-pi"` literals | `runtime.id` |

## Engine and state changes

- `ExecutorConfig.runtime?: string` and `ExecutionResult.runtime?: string`.
  `AgentPort` is unchanged.
- `variant` keeps Pi's ladder (`off…xhigh`) as the **normalized thinking
  vocabulary**. Each runtime maps it to its own levels (see
  [`06`](06-config-and-capabilities.md)).
- `ExecutionResult.extensions` is reinterpreted as "component status"; the
  column name stays.
- New `runtime` column on `executions`, migrated on **both dialects** per
  `apps/server/src/state/CLAUDE.md`.

## What the in-process path keeps

agentic-pi on `none`/`gondolin` keeps calling `run()` in-process. That path is
the evals default and the only way gondolin works. Its records go through the
same Pi decoder, so there is exactly one translation. An optional later step:
run agentic-pi as a host child on `none` too, which gives it the kill timer and
equal process overhead in harness comparisons.
