/**
 * The durable-execution seam for code-defined workflows (spike — see
 * docs/plans/durable-workflows/).
 *
 * A {@link DurableStep} is the minimum an embedded durable runtime must give a
 * workflow function: memoized steps, durable signal waits, durable sleeps. The
 * workflow function is re-invoked from the top after a crash or a park; every
 * `run`/`waitForSignal`/`sleep` whose name already completed returns its
 * persisted result instead of re-executing. Names MUST be unique and
 * deterministic within one run — never derive them from `Date.now()` or random.
 *
 * Engine-pure: the concrete runtime (OpenWorkflow today) is wired by the app.
 */

/** JSON-serialisable value. Everything a step returns is persisted as JSON, so step results must be plain data. */
export type Json = string | number | boolean | null | Json[] | { [key: string]: Json };

export interface DurableStep {
  /** Run `fn` once per run; on replay return its persisted output. */
  run<T>(name: string, fn: () => Promise<T>): Promise<T>;
  /**
   * Park the run until `signal` is delivered (or `timeout` elapses → null).
   * The process may exit while parked; the run resumes on any worker.
   */
  waitForSignal<T>(name: string, signal: string, timeout?: string): Promise<{ data: T } | null>;
  /** Park the run for `duration` (e.g. "10m", "3d"). */
  sleep(name: string, duration: string): Promise<void>;
}

/**
 * Signal names are global in the runtime, so they are scoped to the run that
 * waits on them. The app's approval endpoints compute the same name.
 */
export function approvalSignal(runId: string, gate: string): string {
  return `lastlight:approval:${runId}:${gate}`;
}
