/**
 * `iterate` — the YAML `generic_loop` as a library function (spike).
 *
 * Run an agent up to `maxIterations` times until `until(output)` holds or the
 * `untilBash` check exits 0. Optional human gate between rounds (`approve` or
 * `reply`). Every round, retry, check and gate is its own named durable step,
 * so a resumed run re-enters the loop at the round it parked on.
 */

import { isTerminated } from "../core/phase-executor.js";
import type { AgentResult, AgentStepOptions, WorkflowContext } from "./context.js";

export interface IterateOptions {
  name: string;
  maxIterations: number;
  /** Agent options for round `iteration` (1-based). `previousOutput` is "" when `freshContext`. */
  agent: (round: { iteration: number; previousOutput: string; reply?: string }) => AgentStepOptions;
  until?: (output: string) => boolean;
  untilBash?: { command: string; timeoutSeconds?: number };
  freshContext?: boolean;
  onSoftFailure?: { retries: number; then: "fail" | "complete" };
  gate?: { kind: "approve" | "reply"; message: string };
}

export interface IterateResult {
  completed: boolean;
  iterations: number;
  output: string;
  /** The last agent result (failed when the loop failed). */
  last?: AgentResult;
  failed: boolean;
}

const MAX_PREV_OUTPUT = 32_000;

function soft(r: AgentResult): boolean {
  return !r.success && !isTerminated(r.error) && (r.stopReason === "unknown" || r.stopReason === "error_truncated");
}

export async function iterate(ctx: WorkflowContext, opts: IterateOptions): Promise<IterateResult> {
  let previous = "";
  let reply: string | undefined;
  let last: AgentResult | undefined;
  for (let i = 1; i <= opts.maxIterations; i++) {
    const agentOpts = opts.agent({ iteration: i, previousOutput: opts.freshContext ? "" : previous, reply });
    let r = await ctx.agent(`${opts.name}:iter:${i}`, agentOpts);
    for (let attempt = 1; soft(r) && attempt <= (opts.onSoftFailure?.retries ?? 0); attempt++) {
      r = await ctx.agent(`${opts.name}:iter:${i}:retry:${attempt}`, agentOpts);
    }
    last = r;
    if (soft(r) && opts.onSoftFailure?.then === "complete") {
      return { completed: true, iterations: i, output: r.output || previous, last, failed: false };
    }
    if (!r.success) return { completed: false, iterations: i, output: r.output, last, failed: true };

    const combined = previous ? `${previous}\n${r.output}` : r.output;
    previous = combined.length > MAX_PREV_OUTPUT ? combined.slice(-MAX_PREV_OUTPUT) : combined;

    let done = opts.until ? opts.until(r.output) : false;
    if (!done && opts.untilBash) {
      const check = await ctx.bash(`${opts.name}:check:${i}`, opts.untilBash.command, {
        timeoutSeconds: opts.untilBash.timeoutSeconds,
      });
      done = check.success;
    }
    if (done) return { completed: true, iterations: i, output: r.output, last, failed: false };

    if (opts.gate && i < opts.maxIterations) {
      const decision = await ctx.approval(`${opts.name}:gate:${i}`, {
        kind: opts.gate.kind,
        summary: `Loop ${opts.name} iteration ${i}/${opts.maxIterations} complete.`,
        message: opts.gate.message,
      });
      if (!decision.approved) return { completed: false, iterations: i, output: r.output, last, failed: true };
      reply = decision.reply;
    }
  }
  return { completed: false, iterations: opts.maxIterations, output: last?.output ?? "", last, failed: false };
}
