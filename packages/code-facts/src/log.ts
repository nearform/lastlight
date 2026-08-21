/**
 * The injected logger seam.
 *
 * This package is consumed by the `lastlight` CLI, which is deliberately
 * pino-free — so nothing here may import a concrete logger, and `console.*` is
 * banned in library code (root `CLAUDE.md`). Every entry point therefore takes
 * `log: LoggerPort = noopLogger`, the same shape `validateAssets` and
 * `resolveTemplatedNumber` use.
 *
 * The interface is DECLARED here rather than imported from
 * `lastlight-workflow-engine` on purpose: WP1 specifies `code-facts` as a leaf
 * package with no `workspace:*` edges in either direction (the `agentic-pi`
 * shape), so that vendoring it into the sandbox image never drags the rest of
 * the workspace along. The shape is structurally identical to the engine's
 * `LoggerPort`, so `logger("code-facts")` from core, or the engine's own port,
 * can be passed straight in with no adapter.
 */

export interface LoggerPort {
  debug(msg: string, fields?: Record<string, unknown>): void;
  info(msg: string, fields?: Record<string, unknown>): void;
  warn(msg: string, fields?: Record<string, unknown>): void;
  error(msg: string, fields?: Record<string, unknown>): void;
  fatal(msg: string, fields?: Record<string, unknown>): void;
  child(component: string): LoggerPort;
}

export const noopLogger: LoggerPort = {
  debug() {},
  info() {},
  warn() {},
  error() {},
  fatal() {},
  child() {
    return noopLogger;
  },
};
