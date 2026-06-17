# Architect plan for #91 — Configurable OpenTelemetry export

## Problem Statement

Last Light already has the raw observability data needed for OTEL, but it is only persisted to local DB/session artifacts: `runPhase()` records phase start/finish rows with usage and stop reason (`src/workflows/runner.ts:286-328`), `executeAgent()` consumes every `agentic-pi` event for the dashboard shim (`src/engine/agent-executor.ts:352-359`, `src/engine/agent-executor.ts:506-520`), and chat turns compute duration/tokens/cost/stop reason in `handleChatMessage()` (`src/engine/chat.ts:115-153`). The config system has no `otel` block or Last Light-specific env overrides (`src/config.ts:68-98`, `src/config.ts:258-301`, `src/config.ts:311-364`), and startup never initializes a telemetry SDK before connectors/workflows are created (`src/index.ts:70-121`). Sandboxed runs are egress-restricted to static allowlists (`src/sandbox/egress-allowlist.ts:35-92`) and only forward GitHub/provider/web-search env (`src/engine/agent-executor.ts:113-172`), so the new `agentic-pi@0.2.6` OTEL support will not receive endpoint/header configuration or collector network access without harness changes.

Note: `.lastlight/issue-91/guardrails-report.md` was not present in this checkout when planning. Commands below use the repo guidance in `CLAUDE.md` and the latest available guardrails report pattern in `.lastlight/issue-88/guardrails-report.md`.

## Summary of what needs to change

- Upgrade `agentic-pi` from `^0.2.4` to `^0.2.6` so the harness can rely on the upstream PI OTEL implementation mentioned by the maintainer.
- Add a first-class, disabled-by-default `otel` config block plus `LASTLIGHT_OTEL_*` env overrides; standard `OTEL_*` exporter env vars remain environment-only and are consumed by OpenTelemetry/agentic-pi.
- Add a `src/telemetry/` module that initializes/shuts down OpenTelemetry, exposes no-op-safe span/metric/log helpers, normalizes attributes, and redacts content unless explicitly enabled.
- Instrument workflow runs, workflow phases, agent executions, PI event streams, and chat turns at existing chokepoints.
- Forward only allowlisted OTEL env vars into in-process/gondolin/docker PI executions when `otel.enabled && otel.forwardToSandbox`.
- Derive OTLP collector hostnames from standard endpoint env vars and optional config, include them in strict sandbox egress allowlists for both gondolin and docker firewall generation.
- Document configuration, metadata-only defaults, content opt-in risk, sandbox forwarding, and egress behavior.

## Files to modify — exhaustive manifest

### Dependencies and config

1. `package.json:50-64` (`dependencies`)
   - Change `"agentic-pi": "^0.2.4"` to `"agentic-pi": "^0.2.6"`.
   - Add OpenTelemetry dependencies:
     - `"@opentelemetry/api"`
     - `"@opentelemetry/sdk-node"`
     - `"@opentelemetry/sdk-metrics"`
     - `"@opentelemetry/sdk-logs"`
     - `"@opentelemetry/exporter-trace-otlp-http"`
     - `"@opentelemetry/exporter-metrics-otlp-http"`
     - `"@opentelemetry/exporter-logs-otlp-http"`
     - `"@opentelemetry/resources"`
     - `"@opentelemetry/semantic-conventions"`
   - Use `npm install agentic-pi@^0.2.6 <otel packages...>` so versions resolve consistently.

2. `package-lock.json:18-21`, `package-lock.json:46-49`, `package-lock.json:6635-6653`
   - Regenerate via `npm install` so `agentic-pi` resolves to `0.2.6` and all OTEL packages are locked.

3. `config/default.yaml:6-15`
   - Add disabled defaults near `models`/`sandbox`:
     ```yaml
     otel:
       enabled: false
       serviceName: lastlight
       includeContent: false
       forwardToSandbox: true
       strict: false
       collectorHosts: []
     ```
   - Keep endpoint/headers out of YAML; operators use standard `OTEL_*` env vars.

4. `src/config.ts:47-98` (interfaces)
   - Add exported `OtelConfig`:
     ```ts
     export interface OtelConfig {
       enabled: boolean;
       serviceName: string;
       includeContent: boolean;
       forwardToSandbox: boolean;
       strict: boolean;
       collectorHosts: string[];
     }
     ```
   - Add `otel: OtelConfig;` to `LastLightConfig`.

5. `src/config.ts:198-304` (`loadConfig()`)
   - After `fileCfg` is built, compute `const otel = parseOtelConfig(fileCfg.otel);`.
   - Add `otel` to `effectivePublic` with non-secret fields only.
   - Add `otel` to the returned `config` object.
   - Do not copy `OTEL_EXPORTER_OTLP_HEADERS` or any `OTEL_*` env values into `publicConfig`.

6. `src/config.ts:311-364` (`normalizeFileConfig()`)
   - Include `otel: OtelConfig` in the return type.
   - Parse `const otelRaw = isPlainObject(raw.otel) ? raw.otel : {};`.
   - Add `otel: normalizeOtelFileConfig(otelRaw)` to the returned object.

7. `src/config.ts:430-455` (near `parseBoolWithDefault()`)
   - Add helpers:
     - `normalizeOtelFileConfig(raw: Record<string, unknown>): OtelConfig`
     - `parseOtelConfig(file: OtelConfig): OtelConfig`
     - `parseCollectorHosts(raw: unknown, path: string): string[]`
     - `parseOtelCollectorHostsFromEnv(env = process.env): string[]` or import from telemetry/egress helper if placed there.
   - Env overrides to support:
     - `LASTLIGHT_OTEL_ENABLED`
     - `LASTLIGHT_OTEL_SERVICE_NAME`
     - `LASTLIGHT_OTEL_INCLUDE_CONTENT`
     - `LASTLIGHT_OTEL_FORWARD_TO_SANDBOX`
     - `LASTLIGHT_OTEL_STRICT`
     - `LASTLIGHT_OTEL_COLLECTOR_HOSTS` (comma-separated hostnames)
   - Default behavior: `enabled=false`; do **not** auto-enable solely because `OTEL_*` is present.
   - `serviceName`: prefer `LASTLIGHT_OTEL_SERVICE_NAME`, then `OTEL_SERVICE_NAME`, then YAML/default `lastlight`.

### New telemetry modules

8. `src/telemetry/index.ts` (new)
   - Own all OpenTelemetry setup and no-op behavior.
   - Export:
     - `initTelemetry(config: OtelConfig, opts?: { packageVersion?: string }): Promise<void> | void`
     - `shutdownTelemetry(): Promise<void>`
     - `isTelemetryEnabled(): boolean`
     - `withSpan<T>(name: string, attrs: TelemetryAttributes, fn: (span: Span | undefined) => Promise<T> | T): Promise<T>`
     - `recordWorkflowRunStart(attrs)`, `recordWorkflowRunEnd(attrs)` or a generic `recordCounter` wrapper if preferred.
     - `recordExecutionMetrics(surface: "workflow" | "phase" | "agent" | "chat", resultAttrs)`
     - `recordError(surface, error, attrs)`
     - `safeSpanAttributes(attrs, opts?)`
     - `safeMetricAttributes(attrs)`
     - `getOtelEnvForSandbox(env?: NodeJS.ProcessEnv): Record<string, string>`
     - `OTEL_SANDBOX_ENV_ALLOWLIST`.
   - `OTEL_SANDBOX_ENV_ALLOWLIST` must include only OTEL-related keys, at least:
     - `OTEL_SERVICE_NAME`
     - `OTEL_RESOURCE_ATTRIBUTES`
     - `OTEL_TRACES_EXPORTER`
     - `OTEL_METRICS_EXPORTER`
     - `OTEL_LOGS_EXPORTER`
     - `OTEL_EXPORTER_OTLP_ENDPOINT`
     - `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT`
     - `OTEL_EXPORTER_OTLP_METRICS_ENDPOINT`
     - `OTEL_EXPORTER_OTLP_LOGS_ENDPOINT`
     - `OTEL_EXPORTER_OTLP_PROTOCOL`
     - `OTEL_EXPORTER_OTLP_TRACES_PROTOCOL`
     - `OTEL_EXPORTER_OTLP_METRICS_PROTOCOL`
     - `OTEL_EXPORTER_OTLP_LOGS_PROTOCOL`
     - `OTEL_EXPORTER_OTLP_HEADERS`
     - `OTEL_EXPORTER_OTLP_TRACES_HEADERS`
     - `OTEL_EXPORTER_OTLP_METRICS_HEADERS`
     - `OTEL_EXPORTER_OTLP_LOGS_HEADERS`
     - `OTEL_ATTRIBUTE_VALUE_LENGTH_LIMIT`
     - `OTEL_ATTRIBUTE_COUNT_LIMIT`
     - `OTEL_BSP_MAX_QUEUE_SIZE`
     - `OTEL_BSP_SCHEDULE_DELAY`
     - `OTEL_METRIC_EXPORT_INTERVAL`
   - Initialize OpenTelemetry only when `config.enabled` is true.
   - Set `service.name` from config unless `OTEL_SERVICE_NAME` is already set.
   - Use warn-and-continue when initialization/export setup fails and `strict=false`; throw when `strict=true`.
   - Use bounded metric attributes only: workflow name, phase name, repo, sandbox backend, model, runtime, surface, success, stop reason. Do not use trigger ids, session ids, branch names, raw error stacks, prompts, issue titles, or tool outputs as metric attrs.

9. `src/telemetry/pi-events.ts` (new)
   - Export `recordPiEvent(record: Record<string, unknown>, opts: { includeContent: boolean; span?: Span; surface: "agent" | "chat"; sessionId?: string; workflowName?: string; phaseName?: string; model?: string }): void`.
   - Map PI event types to metadata-only span events/log records by default:
     - `session`: id, cwd/project slug if already sanitized, runtime/version if present.
     - `message_end`: role, content block count, content block types, usage token/cost metadata; omit text/tool args unless includeContent.
     - `tool_execution_end`: tool/toolName, isError, duration/status/error class/message; omit result/output unless includeContent.
     - `extension_status`: extension, status, mode/provider/toolCount/reason.
     - `usage_snapshot`: turns/tokens/cost.
     - `fatal_error`: error name/message only; no stack unless includeContent.
   - Export `sanitizePiEvent(record, includeContent)` for direct unit testing.
   - Add truncation when `includeContent=true` (recommended cap: 4096 chars per attribute) to avoid oversized OTEL payloads.

### Startup and workflow config propagation

10. `src/index.ts:1-27` (imports)
    - Import `readFileSync` already exists; either reuse it to read package version or import package JSON if TS config allows.
    - Add imports from `./telemetry/index.js`:
      - `initTelemetry`
      - `shutdownTelemetry`
      - `getOtelCollectorHosts` if collector parsing lives there, otherwise from egress helper.

11. `src/index.ts:70-121` (`main()` startup)
    - After `validateConfig(config)` at `src/index.ts:92`, call `initTelemetry(config.otel, { packageVersion })` before any connectors, schedulers, DB workflows, or chat runner are constructed.
    - Log a concise line such as `[otel] enabled service=... forwardToSandbox=... includeContent=...` when enabled and `[otel] disabled` when disabled.
    - Register graceful shutdown for `SIGINT`/`SIGTERM` to call `shutdownTelemetry()` before process exit. If adding handlers, preserve existing behavior and avoid double shutdown.

12. `src/index.ts:111-116` (egress firewall generation)
    - Change `writeEgressFirewallConfigs(config.stateDir)` to `writeEgressFirewallConfigs(config.stateDir, config.otel.enabled && config.otel.forwardToSandbox ? config.otel.collectorHosts : [])`.

13. `src/index.ts:134-144` (`new ChatRunner(...)` config)
    - No API change required for `ChatRunner`; chat harness telemetry should be in `handleChatMessage()`.
    - Ensure any package-version/resource initialization already happened before chat runner construction.

14. `src/index.ts:470-493` (`runSimpleWorkflow` executor config object inside `dispatchWorkflow`)
    - Add `otel: config.otel` to the `ExecutorConfig` passed to `runSimpleWorkflow` so phases know whether to forward OTEL env and add collector hosts.

15. `src/index.ts:730-785` (chat event handling)
    - Leave DB persistence unchanged.
    - No direct OTEL call needed here if `src/engine/chat.ts` instruments `handleChatMessage()`; otherwise wrap the call there with a `withSpan("lastlight.chat.turn", ...)` and record metrics on both success and catch.

### Executor/profile changes

16. `src/engine/profiles.ts:1-30` (`ExecutorConfig`)
    - Import `type { OtelConfig }` from `../config.js`.
    - Add optional `otel?: OtelConfig` to `ExecutorConfig` with a comment: controls OTEL env forwarding and PI event redaction for workflow phase runs.
    - Update stale docker comment at `src/engine/profiles.ts:32-35` from proxy wording to DNS/nginx firewall wording while touching this area.

17. `src/engine/agent-executor.ts:1-23` (imports)
    - Import telemetry helpers:
      - `withSpan`, `recordExecutionMetrics`, `recordError`, `getOtelEnvForSandbox`, `safeSpanAttributes`
      - `recordPiEvent` from `../telemetry/pi-events.js`
      - egress helper if collector host merge is implemented outside `egress-allowlist.ts`.

18. `src/engine/agent-executor.ts:83-190` (`executeAgent()` env construction)
    - After provider/web-search env setup, if `config.otel?.enabled && config.otel.forwardToSandbox`, merge `getOtelEnvForSandbox()` into `ghEnv`.
    - Also set a content opt-in env that `agentic-pi@0.2.6` understands if upstream documents one; if unknown after inspecting v0.2.6 types, use a Last Light-specific env (`LASTLIGHT_OTEL_INCLUDE_CONTENT`) only if PI supports it. Do not invent unconsumed env silently; document the chosen upstream key in comments.
    - Ensure disabled or `forwardToSandbox=false` means no `OTEL_*` values are added.

19. `src/engine/agent-executor.ts:184-201` (`executeAgent()` backend dispatch)
    - Wrap docker and in-process calls in a top-level `withSpan("lastlight.agent.execute", attrs, ...)` or wrap inside `executeInProcess`/`executeDocker` if span attributes depend on backend-specific state.
    - Attributes: `agent.runtime=agentic-pi`, `sandbox.backend`, `task.id` (trace only, not metrics), `repo`, `github.profile`, `model`, `variant`, `web_search.enabled`, `unrestricted_egress`.

20. `src/engine/agent-executor.ts:323-325` (gondolin `allowedHttpHosts`)
    - Merge collector hosts into strict allowlist:
      ```ts
      const extraHosts = config.otel?.enabled && config.otel.forwardToSandbox ? config.otel.collectorHosts : [];
      const allowedHttpHosts = config.unrestrictedEgress ? [ALLOW_ALL_SENTINEL] : mergeAllowlist(DEFAULT_ALLOWLIST, extraHosts);
      ```
    - Use the same host normalization/dedup helper as docker firewall generation.

21. `src/engine/agent-executor.ts:352-359` (in-process `onEvent`)
    - After `acc.feed(record)` and `shim.feed(record)`, call `recordPiEvent(record, { includeContent: config.otel?.includeContent === true, surface: "agent", workflowName/phaseName if available, model })`.
    - To avoid hunting for phase names, add optional fields to `ExecutorConfig` (`workflowName?: string`, `phaseName?: string`) or pass attrs through `runPhase()` as `telemetryContext`; use one chosen approach consistently. Preferred: add `telemetry?: { workflowName; phaseName; triggerId; workflowRunId }` to `ExecutorConfig`.

22. `src/engine/agent-executor.ts:362-383` (in-process catch)
    - Record `recordError("agent", err, attrs)` and failure metrics before returning synthesized `ExecutionResult`.

23. `src/engine/agent-executor.ts:392` and `src/engine/agent-executor.ts:545` (`finalizeFromRunResult(...)` calls)
    - After finalization, record duration/tokens/cost/turns/stop reason metrics using the returned `ExecutionResult`.
    - Either make `finalizeFromRunResult()` accept telemetry attrs or record immediately after it returns in `executeInProcess()`/`executeDocker()`.

24. `src/engine/agent-executor.ts:409-426` (`executeDocker()` egress/createTaskSandbox)
    - No change to `createTaskSandbox` shape unless required; `env: ctx.env` already forwards container env.
    - Ensure `ctx.env` includes OTEL vars only when enabled/forwarded.

25. `src/engine/agent-executor.ts:488-506` (docker `sandboxEnv` passed to `agentic-pi run`)
    - Include OTEL vars in `sandboxEnv` too, not only container env, because `agentic-pi run --sandbox none` then forwards `--sandbox-env` into the run environment. Preserve git identity keys.
    - Validate values against `src/sandbox/docker.ts:336-345`; headers containing single quotes/newlines will currently fail. Either document this limitation or add safe base64/escaping support in `docker.ts`. Preferred v1: reject with a clear warning and do not pass unsafe header values rather than breaking shell quoting.

26. `src/engine/agent-executor.ts:506-520` (docker `onLine`)
    - After `acc.feed(record)` and `shim.feed(record)`, call `recordPiEvent(...)` with same metadata-only behavior as in-process.

27. `src/engine/agent-executor.ts:756-857` (`finalizeFromRunResult()`)
    - Keep return shape unchanged.
    - Optionally add a local `executionResultAttributes(result)` helper near this function if metric code needs normalized values.

### Workflow instrumentation

28. `src/workflows/runner.ts:1-20` (imports)
    - Import `withSpan`, `recordExecutionMetrics`, and `recordError` from telemetry.

29. `src/workflows/runner.ts:252-330` (`runPhase()`)
    - Extend signature with a final `telemetryContext` object or derive from existing args:
      - `workflowName`, `phaseName`, `workflowRunId`, `triggerId`, `repo`, `issueNumber`, `prNumber`, `modelOverride`, `variantOverride`, `sandbox`, `taskId`.
    - Wrap the execution and DB finish in `withSpan("lastlight.workflow.phase", ...)`.
    - Add span attrs before execution and completion attrs after `executeAgent()` returns.
    - Change `db.recordStart()` from `repo: undefined, issueNumber: undefined` at `src/workflows/runner.ts:292-293` to use `ctx.repo`/`ctx.issueNumber` by passing those values down from `runWorkflow()`.
    - On skipped `running`/`done`, record a bounded counter/event but do not emit duration metrics as if executed.

30. `src/workflows/runner.ts:407-432` (`runWorkflow()` beginning)
    - Wrap the whole workflow body in `withSpan("lastlight.workflow.run", attrs, async () => { ...existing body... })`.
    - Because this function is large, implement via an inner `async function runWorkflowInner()` to avoid a huge indentation-only diff.
    - Attributes: `workflow.name`, `workflow.run_id`, `trigger.id` (trace only), `repo`, `issue.number`, `pr.number`, `task.id`, `sandbox.backend`.

31. `src/workflows/runner.ts:671-690`, `src/workflows/runner.ts:787-799`, `src/workflows/runner.ts:958-970`, and all other `runPhase(...)` call sites
    - Add the new telemetry/context argument and ensure loop-generated phase labels (`reviewer_2`, `reviewer_fix_1`, `socratic_iter_1`, DAG phase labels) are passed exactly as the execution row skill suffix uses them.
    - Search `runPhase(` in `src/workflows/runner.ts` and update every call; do not leave DAG path out.

32. `src/workflows/runner.ts:1296-1682` (`runDagWorkflow()`)
    - Instrument DAG phase calls the same way as linear phases.
    - Ensure parallel spans are independent child spans under the workflow span if context propagation works; otherwise use explicit attrs to correlate.

33. `src/workflows/simple.ts:85-199` (`runSimpleWorkflow()`)
    - Add workflow-run start/end metrics around `runWorkflow()` if not fully covered inside `runWorkflow()`.
    - Ensure the `TemplateContext` already includes owner/repo/issue/pr/task/branch (`src/workflows/simple.ts:179-197`, `src/workflows/simple.ts:284-308`); no DB schema change required.

### Chat instrumentation

34. `src/engine/chat.ts:1-6` (imports)
    - Import telemetry helpers and `recordPiEvent`.

35. `src/engine/chat.ts:101-170` (`handleChatMessage()`)
    - Wrap function body in `withSpan("lastlight.chat.turn", attrs, ...)`.
    - Trace attrs: `messaging.session_id` (trace only), `messaging.sender` (trace only if acceptable), `model`, `agent.session_id`, `stop_reason`, `success`.
    - Metrics attrs: surface=`chat`, model, success, stop_reason only.
    - Record duration/tokens/cost/turns metrics on success and failure.
    - When `writeChatShim()` synthesizes PI-like records, also call `recordPiEvent()` for the same `message_end` and `tool_execution_end` records, or centralize by building records once and feeding both shim and telemetry.

36. `src/engine/chat.ts:188-241` (`writeChatShim()`)
    - Refactor repeated synthetic record literals into local variables so each record is fed to both `shim.feed(record)` and `recordPiEvent(record, { surface: "chat", includeContent: current config includeContent })`.
    - If passing config here is awkward, record only turn-level telemetry in `handleChatMessage()` and leave PI-like chat shim events out of v1; document this choice in comments/tests. Preferred: include chat PI-like events metadata-only.

### Sandbox egress

37. `src/sandbox/egress-allowlist.ts:83-92`
    - Add exported helpers:
      - `normalizeAllowlistHost(host: string): string | null`
      - `mergeAllowlist(base: readonly string[], extra?: readonly string[]): string[]`
      - `collectorHostsFromOtelEnv(env?: NodeJS.ProcessEnv): string[]`
    - `collectorHostsFromOtelEnv` must parse hostnames from:
      - `OTEL_EXPORTER_OTLP_ENDPOINT`
      - `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT`
      - `OTEL_EXPORTER_OTLP_METRICS_ENDPOINT`
      - `OTEL_EXPORTER_OTLP_LOGS_ENDPOINT`
    - Accept URLs with paths/ports; return bare hostnames only, lowercased, no leading dot, no wildcard, no port.
    - Ignore invalid/private/internal endpoints; specifically do not allow metadata literals.

38. `src/sandbox/egress-firewall-config.ts:1-4` (imports)
    - Import `mergeAllowlist` alongside `DEFAULT_ALLOWLIST`.

39. `src/sandbox/egress-firewall-config.ts:80-126` (`renderNginxStrictConf()`, `renderCorefileStrict()`)
    - Change signatures to accept optional `extraAllowlistHosts: readonly string[] = []`.
    - Build map/match lines from `mergeAllowlist(DEFAULT_ALLOWLIST, extraAllowlistHosts)`.

40. `src/sandbox/egress-firewall-config.ts:177-185` (`writeEgressFirewallConfigs()`)
    - Change signature to `writeEgressFirewallConfigs(stateDir: string, extraAllowlistHosts: readonly string[] = []): string`.
    - Pass `extraAllowlistHosts` to strict renderers.
    - Keep open-mode hard-deny behavior unchanged.

41. `src/sandbox/docker.ts:336-345` (`--sandbox-env` validation)
    - Add a focused test before changing implementation.
    - If OTEL header values with commas/equals are okay, no change. If values can contain single quotes, add safe shell escaping for single quotes instead of rejecting, or keep rejection and ensure `getOtelEnvForSandbox()` filters unsafe values with a warning.
    - Do not loosen key validation beyond uppercase snake case.

### Documentation

42. `README.md:314-341` (Environment Variables table)
    - Add rows for:
      - `LASTLIGHT_OTEL_ENABLED`
      - `LASTLIGHT_OTEL_SERVICE_NAME`
      - `LASTLIGHT_OTEL_INCLUDE_CONTENT`
      - `LASTLIGHT_OTEL_FORWARD_TO_SANDBOX`
      - `LASTLIGHT_OTEL_STRICT`
      - `LASTLIGHT_OTEL_COLLECTOR_HOSTS`
      - Standard `OTEL_EXPORTER_OTLP_ENDPOINT`, `OTEL_EXPORTER_OTLP_*_ENDPOINT`, `OTEL_EXPORTER_OTLP_HEADERS`, `OTEL_SERVICE_NAME`, `OTEL_RESOURCE_ATTRIBUTES`.
    - Mark headers as secret/env-only.

43. `README.md` (add a new subsection near environment/sandbox sections)
    - Add `### OpenTelemetry export` explaining:
      - disabled by default;
      - enable with `LASTLIGHT_OTEL_ENABLED=true`;
      - standard OTEL env vars configure endpoints/headers/protocol;
      - harness exports workflow/phase/agent/chat spans and metrics;
      - PI emits direct telemetry via `agentic-pi@0.2.6` when forwarded;
      - metadata-only default;
      - `LASTLIGHT_OTEL_INCLUDE_CONTENT=true` can export sensitive prompt/tool/result content;
      - `LASTLIGHT_OTEL_FORWARD_TO_SANDBOX=false` disables sandbox env/header forwarding;
      - collector hosts are derived from endpoint env vars or `LASTLIGHT_OTEL_COLLECTOR_HOSTS` for strict egress.

44. `.env.example:33-40` or after sandbox block at `:64-72`
    - Add commented example block:
      ```dotenv
      # ── OpenTelemetry (optional, disabled by default) ─────────────────────
      # LASTLIGHT_OTEL_ENABLED=false
      # LASTLIGHT_OTEL_SERVICE_NAME=lastlight
      # LASTLIGHT_OTEL_INCLUDE_CONTENT=false
      # LASTLIGHT_OTEL_FORWARD_TO_SANDBOX=true
      # LASTLIGHT_OTEL_STRICT=false
      # OTEL_EXPORTER_OTLP_ENDPOINT=https://otel-collector.example.com
      # OTEL_EXPORTER_OTLP_HEADERS=authorization=Bearer <token>
      # LASTLIGHT_OTEL_COLLECTOR_HOSTS=otel-collector.example.com
      ```

45. `deploy/native/lastlight.env.example:20-31` or after model key block
    - Add the same OTEL example block, using `CHANGE_ME` placeholders where appropriate.

46. `CLAUDE.md` (optional but recommended, environment section near sandbox/web search)
    - Add a concise operator note mirroring the README so future agents know OTEL exists and is disabled by default.

### Tests — enumerate all touched test files

47. `src/config.test.ts`
    - Add tests for default `config.otel` values.
    - Add tests for `LASTLIGHT_OTEL_ENABLED`, `LASTLIGHT_OTEL_INCLUDE_CONTENT`, `LASTLIGHT_OTEL_FORWARD_TO_SANDBOX`, `LASTLIGHT_OTEL_STRICT`, `LASTLIGHT_OTEL_SERVICE_NAME`, and `LASTLIGHT_OTEL_COLLECTOR_HOSTS` env overrides.
    - Add test proving `OTEL_*` alone does not enable telemetry.

48. `src/config-overlay.test.ts`
    - Add overlay YAML test for `otel.enabled`, `includeContent`, `forwardToSandbox`, and `collectorHosts`.
    - Add public config test proving secret-looking accidental keys are still redacted and OTLP header env values never appear in `publicConfig`.

49. `src/telemetry/index.test.ts` (new)
    - Test no-op behavior when disabled.
    - Test `getOtelEnvForSandbox()` returns only allowlisted OTEL keys.
    - Test unsafe values are omitted or escaped according to implementation.
    - Test metric attribute normalization drops high-cardinality keys (`trigger.id`, `session.id`, branch, prompt, stack).

50. `src/telemetry/pi-events.test.ts` (new)
    - Test metadata-only redaction for `message_end` text/tool arguments and `tool_execution_end` result/output.
    - Test include-content mode includes truncated content.
    - Test extension/status/usage/fatal-error mappings.

51. `src/engine/agent-executor.test.ts`
    - Extend existing accumulator tests with env-forwarding tests.
    - Mock `agentic-pi`/sandbox creation enough to assert:
      - no OTEL env forwarded when disabled;
      - OTEL env forwarded to `applyEnv`/container env/sandboxEnv when enabled and forwardToSandbox true;
      - `forwardToSandbox=false` suppresses all OTEL env;
      - PI events are passed to `recordPiEvent` in both in-process and docker paths.

52. `src/workflows/runner.test.ts`
    - Mock telemetry helpers and assert workflow run/phase spans are emitted for:
      - standard linear phase;
      - skipped/deduped phase;
      - generic-loop phase label;
      - DAG phase.
    - Assert `db.recordStart()` now receives repo and issue number instead of undefined.

53. `src/engine/chat.test.ts` (new if no suitable existing chat test exists)
    - Mock `ChatRunner.turn()` and telemetry helpers.
    - Assert chat turn span/metrics on success and failure.
    - Assert content is not exported by default from synthetic chat PI events.

54. `src/sandbox/egress-allowlist.test.ts`
    - Add tests for `collectorHostsFromOtelEnv()` and `mergeAllowlist()`.
    - Include endpoints with scheme/path/port, duplicate hosts, invalid URLs, and metadata/private-deny cases.

55. `src/sandbox/egress-firewall-config.test.ts`
    - Add tests that extra collector hosts appear in strict nginx map/CoreDNS matches.
    - Add tests that open mode hard-deny remains unchanged.

56. `src/sandbox/docker.test.ts`
    - Add/adjust test around `--sandbox-env` validation if OTEL header escaping/filtering changes.

## Commands

`.lastlight/issue-91/guardrails-report.md` is missing in this checkout. Use these repo guardrail commands (from `CLAUDE.md` and the latest available guardrails report):

```bash
npm test
npm run build
cd dashboard && npx tsc -b
```

Optional/non-blocking check noted by prior guardrails because no lint script is configured:

```bash
npm run lint
```

If dependency changes are made, run `npm install`/`npm ci` as needed before the commands above.

## Implementation approach

1. **Dependencies first**
   - Run `npm install agentic-pi@^0.2.6` plus the OTEL packages listed above.
   - Confirm `package-lock.json` locks `agentic-pi` to `0.2.6` or newer compatible `0.2.x` satisfying the maintainer request.

2. **Config plumbing**
   - Add `OtelConfig` and defaults in `config/default.yaml`.
   - Parse YAML and env overrides in `src/config.ts`.
   - Derive collector hosts from standard endpoint env vars and `LASTLIGHT_OTEL_COLLECTOR_HOSTS`.
   - Add config tests before moving on.

3. **Telemetry module**
   - Implement `src/telemetry/index.ts` as the only place that imports OpenTelemetry SDK packages.
   - Implement no-op-safe helpers so instrumentation sites do not need `if (enabled)` branches.
   - Implement `src/telemetry/pi-events.ts` with metadata-only sanitization and include-content truncation.
   - Unit-test redaction and allowlisted sandbox env extraction.

4. **Startup and shutdown**
   - Initialize telemetry in `src/index.ts` immediately after config validation.
   - Pass collector hosts into `writeEgressFirewallConfigs()`.
   - Register shutdown flushing.

5. **Sandbox egress**
   - Add allowlist host normalization/merge helpers.
   - Update strict nginx/CoreDNS renderers to include collector hosts.
   - Add tests around generated configs.

6. **Env forwarding to PI**
   - Extend `ExecutorConfig` with `otel` and telemetry context.
   - Merge allowlisted OTEL env into `ghEnv` only when enabled/forwarded.
   - Ensure docker `sandboxEnv` also gets OTEL env so `agentic-pi run` can pass values to the actual PI run environment.
   - Add tests for disabled/enabled/forward-disabled behavior.

7. **Instrumentation**
   - Instrument `runWorkflow()` as workflow run span.
   - Instrument `runPhase()` as phase span and metric source; pass repo/issue/pr into execution rows.
   - Instrument `executeAgent()`/backend helpers for agent execution spans, metrics, errors, and PI event logs/span-events.
   - Instrument `handleChatMessage()` for chat turn spans/metrics and optional synthetic PI events.

8. **Documentation**
   - Update README and env examples.
   - Mention `agentic-pi@0.2.6` direct telemetry support and sandbox forwarding.

9. **Verification**
   - Run targeted tests while implementing, then the full commands listed above.
   - If `npm run lint` remains missing, document it as non-blocking in the final executor summary.

## Risks and edge cases

- **OTEL SDK logs support churn:** OpenTelemetry JS logs APIs have changed across versions. Keep all SDK usage isolated in `src/telemetry/index.ts` so compile fixes are localized.
- **Disabled-by-default invariant:** Standard `OTEL_*` env vars must not auto-enable Last Light telemetry. Tests should lock this down.
- **Secret leakage:** `OTEL_EXPORTER_OTLP_HEADERS` may contain credentials. It must never enter public config or logs; forwarding to sandbox only happens behind `forwardToSandbox`.
- **Content leakage:** Prompt/message/tool-result content must be omitted unless `includeContent=true`; when included, truncate.
- **Sandbox egress:** Collector endpoints with private/internal hosts must not be allowlisted. Preserve metadata-service denies.
- **Shell quoting for docker `--sandbox-env`:** OTLP header values may contain characters currently rejected by `docker.ts`. Filter or safely escape rather than weakening validation broadly.
- **Trace cardinality:** Metrics must not use session ids, trigger ids, branches, issue titles, or raw error stacks as attributes.
- **Double export:** Parent harness exports PI events and `agentic-pi@0.2.6` may export direct telemetry. This is intentional for v1 coverage, but docs should explain it; avoid duplicate metrics if upstream emits identical metric names in the same process.
- **In-process global SDK state:** `agentic-pi` may initialize OTEL in-process too. Initialize Last Light first, and avoid calling PI telemetry setup directly unless upstream documents an idempotent API.

## Test strategy

- Unit-test config defaults/overrides/redaction in `src/config.test.ts` and `src/config-overlay.test.ts`.
- Unit-test telemetry sanitization and env allowlisting in new `src/telemetry/*.test.ts` files with no real collector.
- Unit-test egress host parsing and generated strict firewall configs in `src/sandbox/egress-allowlist.test.ts` and `src/sandbox/egress-firewall-config.test.ts`.
- Mock telemetry helpers in workflow/agent/chat tests to prove spans/metrics are called without depending on OTEL SDK internals.
- Run full server test/build commands after dependency changes.
- Dashboard typecheck is included because config/public config changes can surface through admin UI typing even if no dashboard code changes are planned.

## Estimated complexity

Complex.
