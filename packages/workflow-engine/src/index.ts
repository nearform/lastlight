/**
 * `@lastlight/workflow-engine` — the port-driven workflow engine extracted from
 * Last Light. Domain-agnostic (zod + node built-ins only); the embedding app
 * supplies the agent/asset/liveness/telemetry seams via {@link EnginePorts}.
 *
 * The `test-support` subpath (`@lastlight/workflow-engine/test-support`) ships
 * in-memory fakes; it stays a separate entry so the fakes never enter a
 * consumer's production import graph.
 */

// Core leaves + vocabulary (no cross-overlap → safe star exports).
export * from "./core/types.js";
export * from "./core/schema.js";
export * from "./core/templates.js";
export * from "./core/dag.js";
export * from "./core/verdict.js";
export * from "./core/phase-ref.js";
export * from "./core/loop-eval.js";

// Ports (interfaces + engine result vocabulary).
export * from "./ports/ports.js";

// The executor + scheduler — explicit named exports so their re-exported port
// types don't collide with the `./ports/ports.js` star export above.
export {
  PhaseExecutor,
  isTerminated,
  isSoftOutcome,
  buildPhasePrompt,
  phaseConfigFor,
  runPhase,
  runCommandPhase,
} from "./core/phase-executor.js";
export type { PhaseRunContext } from "./core/phase-executor.js";
export { runWorkflowCore } from "./core/scheduler.js";
export type { SchedulerDeps, HostCapabilities } from "./core/scheduler.js";
