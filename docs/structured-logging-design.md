# Structured log levels for operational output — design

- **Date:** 2026-07-31
- **Status:** Implemented
- **Scope packages:** `apps/server` (lastlight-core), `packages/workflow-engine`

## Context & driver

Last Light runs in Kubernetes. Pod stdout/stderr is tailed by a Vector DaemonSet
into Loki. Vector's `pod_level` transform derives a severity by running
`parse_json` on each line and reading `parsed.level || parsed.severity ||
parsed.lvl || parsed.loglevel`, falling back to a logfmt probe and then a klog
`[IWEF]` prefix probe; anything unrecognised is left `detected_level=unknown`
(`flux-homelab:apps/logging/vector.yaml:77-120`).

Last Light currently emits **plaintext** via raw `console.*` (~692 call sites,
no logging library anywhere in the repo). So `parse_json` fails on every line,
the fallbacks miss, and the app lands in the `unknown` bucket — the exact "app to
fix at source" flag from the homelab logging decision. The dashboard's textual
line-match fallback then mislabels lines (an `info` line reading "no errors
found" surfaces under the error filter), and because today's code splits
`console.warn`/`console.error` onto stderr while `console.log` goes to stdout,
any stream-based heuristic marks every warning as an error.

This work is the **lastlight-side fulfilment of the homelab decision**
`flux-homelab:decisions/2026-07-25-structured-logs-with-levels.md` — specifically
its follow-up step 2 ("for our own / configurable workloads, enable JSON logging
with a `level` field"). Step 3 (the generic Vector `parse_json` transform) is
already deployed. **No Vector or Loki changes are required by this work.**

## Goal

Emit Last Light's **operational** logs as structured JSON lines carrying an
explicit string `level`, so Vector reads severity from the JSON body instead of
guessing, and so a `debug` tier can be filtered out at source rather than at
query time.

## Non-goals (v1)

- **No Vector / Loki changes.** The pipeline already parses a JSON `level`.
- **No CLI or evals conversion.** `packages/cli` (208 sites) and `apps/evals`
  (117 sites) are `chalk`/spinner *terminal UI*, not operator logs. Applying a
  log level to them is a category error. A future `--json` CLI mode is a separate
  effort. `apps/www` (4 sites, marketing site) is irrelevant. `packages/shared`'s
  single `console.log` (`overlay-bootstrap.ts:236`) is CLI-facing scaffolding
  (`@clack/prompts` + `chalk`), so it is excluded on the same grounds — `shared`
  is not touched.
- **No pino `redact` config.** Our messages are interpolated strings, not
  structured objects, so key-path redaction cannot catch a token already inside a
  `msg`. The rule instead is "never interpolate secrets into `msg`." Revisit if we
  later log structured objects.

## The log-line contract

One JSON object per line, written to **stderr**:

```json
{"time":"2026-07-31T09:12:04.311Z","level":"info","component":"cron","msg":"scheduled review discovery"}
```

| Field       | Meaning                                                                                                  |
| ----------- | -------------------------------------------------------------------------------------------------------- |
| `level`     | **String** from `{debug, info, warn, error, fatal}`, matching `vector.yaml:104-119`'s vocabulary.        |
| `component` | Subsystem, lifted from today's `[cron]` / `[dispatch]` / `[repo-config]` bracket prefixes.               |
| `msg`       | Human message (bracket prefix removed).                                                                   |
| `err`       | `{message, stack}` when logging an exception — so a stack trace is **one** JSON record, not N orphaned lines. |
| `time`      | ISO-8601 timestamp.                                                                                       |
| `trace_id`  | 32-hex OTel trace id, stamped automatically when a valid span is active; omitted otherwise.               |
| `span_id`   | 16-hex OTel span id, same conditions as `trace_id`.                                                        |

`component` is deliberately **not** named `ns`, which would collide with
`kubernetes_pod_namespace` in Loki queries. `trace_id` / `span_id` are added by a
pino `mixin` that reads the OTel active span (`trace.getActiveSpan()`) at emit
time — no call site threads them. `core` already depends on `@opentelemetry/api`,
so this stays inside `core` and touches neither the port nor the engine. This is
what wires **Loki ↔ Tempo** correlation (click a log line → open its trace);
Loki's derived-field extraction keys on `trace_id`. Correlation only appears where
a span is genuinely *active* on the OTel context, so `withSpan` must activate its
span (`startActiveSpan` / `context.with`), not hold a detached span object.

## Architecture — ports (keep the CLI lean)

The concrete logger is `pino`, but it must not enter the published `lastlight`
CLI's dependency tree. The dependency graph runs `workflow-engine ← shared ←
{cli, core}` (the engine is the deepest leaf), and the engine's dep-cruiser gate
(`engine-externals-zod-only`) forbids it importing any external but `zod`. So the
port that the engine must consume has to live **in the engine**, and pino has to
stay **out** of it:

1. **`LoggerPort`** — framework-free interface in
   `packages/workflow-engine/src/ports/ports.ts`, added as an **optional** field
   to the existing `EnginePorts` injection object:

   ```ts
   export interface LoggerPort {
     debug(msg: string, fields?: Record<string, unknown>): void
     info(msg: string, fields?: Record<string, unknown>): void
     warn(msg: string, fields?: Record<string, unknown>): void
     error(msg: string, fields?: Record<string, unknown>): void
     fatal(msg: string, fields?: Record<string, unknown>): void
     child(component: string): LoggerPort
   }
   ```

   A `noopLogger: LoggerPort` is exported from the engine (barrel +
   `test-support`) so the field can stay optional: each engine log scope resolves
   `const log = this.ports.logger ?? noopLogger` once. Optional keeps every commit
   green during the incremental migration and shields tests that build
   `EnginePorts` without a logger.

2. **pino adapter** in `apps/server` (core), `src/logging/logger.ts` — a small
   wrapper mapping the port to pino. It insulates callers from pino's argument
   order (`pino` is `(obj, msg)`; the port is `(msg, fields)`) and from pino
   specifics, so the backend can be swapped without touching call sites. The root
   logger is a **module-level** singleton configured from env (below), because the
   engine's adapter is constructed at module load in `runner.ts`, before
   `main()` runs.

3. **Wiring** — `apps/server/src/workflows/runner.ts` supplies the pino-backed
   `LoggerPort` at the `EnginePorts` construction site (following the existing
   `telemetryObservability` module-level-adapter pattern). Other subsystems import
   `logger('component')` from `src/logging/logger.ts` directly. The
   `agentic-pi` `onWarn` seam (`src/sandbox/sandbox.ts:573`) is repointed at a
   logger's `.warn`.

Result: pino lives only in `core`. `shared`, `workflow-engine`, and the CLI stay
pino-free (dep-cruiser enforces it). `agentic-pi` is otherwise untouched.

## Config surface

- **`LOG_LEVEL`** (pino-standard name) — default `info`; set `LOG_LEVEL=debug`
  for the debug switch. Read **directly from `process.env`** at logger-init time,
  not routed through `LastLightConfig` — the logger is constructed at module load
  before `loadConfig()` runs, and must be able to report config-load failures
  themselves. Added to the k8s deployment `env:` list so it flips without a
  rebuild.
- **`LOG_FORMAT`** = `json | pretty`, overriding auto-detection:
  - `LOG_FORMAT` set → obey it,
  - else the output stream (stderr, `process.stderr.isTTY`) is a TTY → `pretty`
    (local dev, via `pino-pretty`),
  - else → `json` (k8s / prod — no TTY, automatic).
- **All logs to stderr** (via `pino.destination(2)`). stdout stays reserved for
  data/protocol. Rationale:
  - The bug was the stdout/stderr *split*, not the fd; consolidating to one
    stream cures the mislabeling, and Vector reads `level` from the body, not
    from `.stream`, so the fd is neutral for Loki.
  - `agentic-pi`'s emitter writes its NDJSON event protocol to **stdout**
    (`emitter.ts:32`); reserving stdout for data gives one invariant that holds
    in both server and sandbox contexts.
  - Node's own runtime diagnostics (uncaught-exception stacks,
    `process.emitWarning`, `--trace-*`) are hardwired to stderr; co-locating our
    logs there keeps them correctly ordered with the runtime's output.

## Level assignment — triaged

Baseline mapping, then adjust by namespace:

- `console.error` → `error`, `console.warn` → `warn`, `console.log` → `info`.
- **Demote to `debug`:** high-frequency internal tracing namespaces — `[event]`,
  `[resume]`, `[dispatch]` per-turn chatter and similar. Decisions cluster by
  prefix (~15 namespace calls, not 137 independent judgments).
- **Promote to `fatal`:** the handful of "process is dying" logs at startup /
  unrecoverable paths.
- The `[prefix]` token is removed from `msg` and becomes the child's `component`.

The exact debug-demotion list is finalised during implementation and recorded in
the plan; the default prod level of `info` must be quiet enough that the
`debug` switch is meaningful.

## Migration order

Deepest dependency first, so each package stays green independently (typecheck +
test gate, one logical change per commit):

1. `packages/workflow-engine` — add `LoggerPort` + `noopLogger`, thread it through
   `EnginePorts`/`PhaseExecutor`/`scheduler`, convert its 9 sites.
2. `apps/server` (core) — the `src/logging/logger.ts` pino adapter (TDD), wire it
   at `runner.ts` and in `index.ts`, repoint the `agentic-pi` `onWarn` seam, then
   convert the 325 sites in subsystem-grouped batches.
3. k8s deployment env + docs.

`packages/shared` is not touched (its lone site is CLI scaffolding, excluded).

## Testing

- Inject a **capturing test logger** (a `Logger` implementation that records
  calls) and assert on `{level, component, msg}` — behaviour, not formatting.
- One adapter-level test confirms pino emits the exact envelope: string `level`,
  `component` present, written to fd 2.
- One end-to-end check pipes a real run's stderr through `parse_json` and asserts
  `.level` is set — verifying the actual Vector contract, not an assumption of it.
- Do **not** snapshot-test `pino-pretty` output.

## Follow-ups (out of scope here)

- Optional future `--json` mode for the CLI.
- Structured-object logging + pino `redact` if/when call sites start passing
  objects that could carry secrets.
- This design is the natural feeder for an OTel logs signal through the parked
  collector, should that be unparked (`level` → `SeverityNumber`, `msg` → body,
  `component`/`err` → attributes).
