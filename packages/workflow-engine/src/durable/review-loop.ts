/**
 * The reviewer → fix → re-review loop as a plain library function (spike).
 *
 * The YAML engine needs ~200 lines of resume bookkeeping for this
 * (`scratch["rloop:<phase>"].pausedAtCycle`, re-reading a skipped review's
 * verdict from the ledger, …). Here the loop variable is ordinary control
 * flow: on replay each completed review/fix step returns its persisted result,
 * so the loop walks back to exactly where it parked.
 */

import { parseReviewerVerdict, type ReviewerVerdict } from "../core/verdict.js";
import type { AgentResult, AgentStepOptions, WorkflowContext } from "./context.js";

export interface ReviewLoopOptions {
  name: string;
  review: AgentStepOptions;
  reReview: AgentStepOptions;
  fix: AgentStepOptions;
  maxCycles: number;
  /** Approval gate to pass before each fix cycle (skipped when not enabled for the run). */
  approvalGate?: { gate: string; artifact?: string; message?: string };
  messages?: {
    approved?: string;
    requestChanges?: string;
    maxCycles?: string;
    fixFailed?: string;
  };
}

export interface ReviewLoopResult {
  verdict: ReviewerVerdict;
  cycles: number;
  /** True when a human rejected a fix-cycle gate. */
  rejected: boolean;
  last: AgentResult;
}

export async function reviewLoop(ctx: WorkflowContext, opts: ReviewLoopOptions): Promise<ReviewLoopResult> {
  let review = await ctx.agent(`${opts.name}`, opts.review);
  for (let cycle = 1; ; cycle++) {
    const { verdict } = parseReviewerVerdict(review.output);
    if (verdict === "APPROVED") {
      await ctx.notify(`${opts.name}:approved:${cycle}`, opts.messages?.approved ?? "Approved", { cycle });
      return { verdict, cycles: cycle - 1, rejected: false, last: review };
    }
    if (cycle > opts.maxCycles) {
      await ctx.notify(`${opts.name}:max-cycles`, opts.messages?.maxCycles ?? "Max review cycles reached", {
        maxCycles: opts.maxCycles,
      });
      return { verdict, cycles: cycle - 1, rejected: false, last: review };
    }
    if (opts.approvalGate && ctx.gateEnabled(opts.approvalGate.gate)) {
      const decision = await ctx.approval(`${opts.approvalGate.gate}:${cycle}`, {
        summary: `Reviewer requested changes (cycle ${cycle}/${opts.maxCycles}) on ${opts.name}.`,
        artifact: opts.approvalGate.artifact,
        message: opts.approvalGate.message,
      });
      if (!decision.approved) return { verdict, cycles: cycle - 1, rejected: true, last: review };
    }
    await ctx.notify(`${opts.name}:request-changes:${cycle}`, opts.messages?.requestChanges ?? "Fixing", {
      cycle,
      maxCycles: opts.maxCycles,
    });
    const fix = await ctx.agent(`${opts.name}:fix:${cycle}`, { ...opts.fix, vars: { ...opts.fix.vars, fixCycle: cycle } });
    if (!fix.success) {
      await ctx.notify(`${opts.name}:fix-failed:${cycle}`, opts.messages?.fixFailed ?? "Fix failed", { cycle });
      return { verdict, cycles: cycle, rejected: false, last: review };
    }
    review = await ctx.agent(`${opts.name}:recheck:${cycle}`, {
      ...opts.reReview,
      vars: { ...opts.reReview.vars, fixCycle: cycle },
    });
  }
}
