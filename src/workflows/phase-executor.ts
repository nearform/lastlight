import { randomUUID } from "crypto";
import { execSync } from "child_process";
import type {
  ExecutorConfig,
  ExecutionResult,
  GitSandboxAccess,
} from "../engine/profiles.js";
import { executeAgent } from "../engine/agent-executor.js";
import type { StateDb } from "../state/db.js";
import type { AgentWorkflowDefinition, PhaseDefinition } from "./schema.js";
import { phaseSkillNames } from "./schema.js";
import { loadPromptTemplate, resolveSkillPaths } from "./loader.js";
import { renderTemplate, type TemplateContext } from "./templates.js";
import { evalUntilExpression } from "./loop-eval.js";
import { parseReviewerVerdict } from "./verdict.js";
import { PhaseRef } from "./phase-ref.js";
import type { DagNode } from "./dag.js";
import type { PhaseResult } from "./runner.js";
import type { StepStatus, ProgressStep } from "../notify/types.js";
import { recordError, recordExecutionMetrics, withSpan } from "../telemetry/index.js";
import { listRunningContainers } from "../admin/docker.js";

/**
 * The single per-phase executor. Constructed once per workflow run, it owns
 * every per-phase body — context / standard agent / reviewer-loop /
 * generic-loop — behind one `execute(node, outputs)` entry point. The
 * scheduler (`runner.ts`) owns the DAG, the `phases[]`/`outputs{}`
 * accumulation, and the in-memory node status; `execute` reads the current
 * outputs and returns its delta.
 *
 * Dependencies are grouped into three cohesive collaborators:
 *   - {@link PhaseRunContext}  run-scoped immutable data
 *   - {@link PhaseReporter}    progress / notification surface
 *   - {@link PhaseResolver}    model / variant / prompt / gate resolution
 *
 * This makes the executor unit-testable with fakes (see
 * `phase-executor.test.ts`), and — because both chain and explicit-DAG nodes
 * now route through the same code — loop nodes finally support the approval /
 * reply gates that the old DAG fork dropped.
 */

// ── Collaborators ────────────────────────────────────────────────────────────

/** Run-scoped immutable data shared by every phase execution. */
export interface PhaseRunContext {
  definition: AgentWorkflowDefinition;
  ctx: TemplateContext;
  config: ExecutorConfig;
  /** Single workspace shared by every phase + loop iteration of the run. */
  taskId: string;
  triggerId: string;
  githubAccess: GitSandboxAccess;
  /** Mutable scratch bag (generic-loop resume state). */
  scratch: Record<string, unknown>;
  db?: StateDb;
  workflowId?: string;
}

export interface ReportStepOpts {
  label?: string;
  insertBefore?: string;
  insert?: boolean;
  alsoNote?: boolean;
}

/** Progress / notification surface — the reporting collaborator. */
export interface PhaseReporter {
  onStart(phase: string): Promise<void>;
  onEnd(phase: string, result: PhaseResult): Promise<void>;
  /** Transition a checklist step (and optionally render a YAML message detail). */
  step(
    key: string,
    status: StepStatus,
    template?: string,
    extraCtx?: Partial<TemplateContext>,
    opts?: ReportStepOpts,
  ): Promise<void>;
  /** Render a YAML message template and post it as a standalone note. */
  message(template: string | undefined, extraCtx?: Partial<TemplateContext>): Promise<void>;
  /** Post a pre-rendered standalone message. */
  postNote(text: string): Promise<void>;
  /** Persist a phase-history entry on the workflow run. */
  persistPhase(phase: string, summary?: string): void;
  /** Mark the workflow run failed. */
  failWorkflow(errorMsg?: string): void;
}

/** Model / variant / prompt / gate resolution — the resolution collaborator. */
export interface PhaseResolver {
  modelFor(taskType: string): string | undefined;
  variantFor(taskType: string): string | undefined;
  renderPrompt(promptPath: string, extraCtx?: Partial<TemplateContext>): string;
  gateEnabled(gateName: string | undefined): boolean;
}

/** The delta a single `execute(node, outputs)` returns to the scheduler. */
export interface PhaseOutcome {
  results: PhaseResult[];
  status: "succeeded" | "failed" | "skipped";
  /** Approval / reply gate hit — scheduler returns `{ success: true, paused: true }`. */
  paused?: boolean;
  /**
   * Dedup running-skip — another instance is mid-flight on this exact phase.
   * Scheduler stops the whole run immediately with `success: false` and does
   * NOT cascade skips (it isn't a phase failure).
   */
  aborted?: boolean;
  /** Output map additions to merge into the scheduler's accumulated outputs. */
  outputVars?: Record<string, unknown>;
}

// ── Module-level helpers (moved here from runner.ts) ─────────────────────────

/**
 * Reject shell commands containing mustache template markers to prevent
 * accidental template injection into until_bash values.
 */
function validateShellCommand(cmd: string): void {
  if (cmd.includes("{{")) {
    throw new Error(`until_bash command rejected: contains template marker '{{'. Render templates before passing to shell.`);
  }
}

/**
 * Build the agent prompt for a phase, handling both `prompt:` (template file)
 * and `skill:`/`skills:` (skill references) phase definitions.
 */
export function buildPhasePrompt(
  phase: PhaseDefinition,
  ctx: TemplateContext,
  extraCtx?: Partial<TemplateContext>,
): string {
  const fullCtx = extraCtx ? { ...ctx, ...extraCtx } : ctx;

  if (phase.prompt) {
    const template = loadPromptTemplate(phase.prompt);
    return renderTemplate(template, fullCtx);
  }

  const skills = phaseSkillNames(phase);
  if (skills.length) {
    const [primary, ...rest] = skills;
    const contextLines = Object.entries(fullCtx)
      .filter(([, v]) => v !== undefined && v !== null)
      .map(([k, v]) => `${k}: ${typeof v === "object" ? JSON.stringify(v) : v}`)
      .join("\n");
    const others = rest.length
      ? `Other skills available if you need them: ${rest.join(", ")}.`
      : "";
    return [
      `Use the **${primary}** skill to handle this request.`,
      others,
      "",
      "Context:",
      contextLines,
    ]
      .filter((line) => line !== "")
      .join("\n");
  }

  throw new Error(`Phase "${phase.name}" has neither prompt: nor skills: — cannot build prompt`);
}

/**
 * Overlay per-phase executor config fields (`unrestricted_egress`,
 * `web_search`, resolved skill paths) onto the run-level config.
 */
export function phaseConfigFor(config: ExecutorConfig, phase: PhaseDefinition): ExecutorConfig {
  const skills = phaseSkillNames(phase);
  const skillPaths = skills.length ? resolveSkillPaths(skills) : undefined;

  if (
    phase.unrestricted_egress === undefined &&
    phase.web_search === undefined &&
    !skillPaths
  ) {
    return config;
  }
  const next: ExecutorConfig = { ...config };
  if (phase.unrestricted_egress !== undefined) {
    next.unrestrictedEgress = phase.unrestricted_egress;
  }
  if (phase.web_search !== undefined) {
    next.webSearch = phase.web_search;
  }
  if (skillPaths) {
    next.skillPaths = skillPaths;
  }
  return next;
}

/** Check if an error was caused by manual termination (OOM/cancel/kill). */
export function isTerminated(error?: string): boolean {
  if (!error) return false;
  const lower = error.toLowerCase();
  return (
    lower.includes("terminated") ||
    lower.includes("killed") ||
    lower.includes("exit undefined") ||
    (lower.includes("container") && lower.includes("not running"))
  );
}

function pickResult(r: ExecutionResult): Pick<ExecutionResult, "success" | "output" | "error"> {
  return { success: r.success, output: r.output, error: r.error };
}

function issueNumberFromTrigger(triggerId: string): number | undefined {
  const m = triggerId.match(/#(\d+)$/);
  return m ? Number(m[1]) : undefined;
}

/** Check if a sandbox container is actually running for a given taskId prefix. */
async function isContainerAlive(taskId: string): Promise<boolean> {
  try {
    const containers = await listRunningContainers();
    return containers.some((c) => c.taskId === taskId);
  } catch {
    return false;
  }
}

type RunPhaseResult =
  | { result: ExecutionResult; executionId: string; skipped: false }
  | { result: ExecutionResult; skipped: false }
  | { skipped: true; reason: "running" | "done" };

/**
 * Run a single agent phase with DB-tracked deduplication. Moved verbatim from
 * runner.ts — the dedup ledger (`shouldRunPhase`) is the single source of
 * truth for resume, so re-running from the top skips completed phases here.
 */
export async function runPhase(
  workflowName: string,
  phaseName: string,
  taskId: string,
  triggerId: string,
  prompt: string,
  config: ExecutorConfig,
  db?: StateDb,
  modelOverride?: string,
  workflowRunId?: string,
  githubAccess?: GitSandboxAccess,
  variantOverride?: string,
): Promise<RunPhaseResult> {
  const dedupKey = `${workflowName}:${phaseName}`;
  const attrs = {
    "workflow.name": workflowName,
    "phase.name": phaseName,
    "workflow.run_id": workflowRunId,
    "trigger.id": triggerId,
    "task.id": taskId,
    repo: githubAccess?.repo,
    "issue.number": issueNumberFromTrigger(triggerId),
    "sandbox.backend": config.sandbox,
    model: modelOverride || config.model,
  };
  return withSpan("lastlight.workflow.phase", attrs, async (span) => {
    if (db) {
      const status = db.executions.shouldRunPhase(dedupKey, triggerId, workflowRunId);

      if (status === "running") {
        const alive = await isContainerAlive(taskId);
        if (alive) {
          console.log(`[runner] Phase ${phaseName} is already running (container alive) — skipping`);
          span?.addEvent("lastlight.workflow.phase.skipped", { reason: "running" });
          return { skipped: true, reason: "running" };
        }
        console.log(`[runner] Phase ${phaseName} was running but container is dead — cleaning up`);
        db.executions.markStaleAsFailed(dedupKey, triggerId, workflowRunId);
      } else if (status === "done") {
        console.log(`[runner] Phase ${phaseName} already completed successfully — skipping`);
        span?.addEvent("lastlight.workflow.phase.skipped", { reason: "done" });
        return { skipped: true, reason: "done" };
      }

      const executionId = randomUUID();
      db.executions.recordStart({
        id: executionId,
        triggerType: "webhook",
        triggerId,
        skill: dedupKey,
        repo: githubAccess?.repo,
        issueNumber: issueNumberFromTrigger(triggerId),
        startedAt: new Date().toISOString(),
        workflowRunId,
      });

      const baseConfig = modelOverride ? { ...config, model: modelOverride } : config;
      const phaseConfigBase = variantOverride ? { ...baseConfig, variant: variantOverride } : baseConfig;
      const phaseConfig: ExecutorConfig = {
        ...phaseConfigBase,
        telemetry: { workflowName, phaseName, triggerId, workflowRunId },
      };
      try {
        const result = await executeAgent(prompt, phaseConfig, {
          taskId,
          githubAccess,
          onSessionId: (sessionId) => {
            try {
              db.executions.recordSessionId(executionId, sessionId);
            } catch (err) {
              console.warn(`[runner] Failed to persist session id mid-run for ${phaseName}:`, err);
            }
          },
        });

        db.executions.recordFinish(executionId, {
          success: result.success,
          error: result.error,
          turns: result.turns,
          durationMs: result.durationMs,
          sessionId: result.sessionId,
          costUsd: result.costUsd,
          inputTokens: result.inputTokens,
          cacheCreationInputTokens: result.cacheCreationInputTokens,
          cacheReadInputTokens: result.cacheReadInputTokens,
          outputTokens: result.outputTokens,
          apiDurationMs: result.apiDurationMs,
          stopReason: result.stopReason,
          extensionStatus: result.extensions ? JSON.stringify(result.extensions) : undefined,
        });
        span?.setAttributes({ success: result.success, stop_reason: result.stopReason ?? "unknown" });
        recordExecutionMetrics("phase", { ...attrs, success: result.success, stop_reason: result.stopReason, durationMs: result.durationMs, costUsd: result.costUsd, inputTokens: result.inputTokens, outputTokens: result.outputTokens });
        return { result, executionId, skipped: false };
      } catch (err) {
        recordError("phase", err, attrs);
        throw err;
      }
    }

    const baseConfig = modelOverride ? { ...config, model: modelOverride } : config;
    const phaseConfigBase = variantOverride ? { ...baseConfig, variant: variantOverride } : baseConfig;
    const phaseConfig: ExecutorConfig = { ...phaseConfigBase, telemetry: { workflowName, phaseName, triggerId, workflowRunId } };
    const result = await executeAgent(prompt, phaseConfig, { taskId, githubAccess });
    recordExecutionMetrics("phase", { ...attrs, success: result.success, stop_reason: result.stopReason, durationMs: result.durationMs, costUsd: result.costUsd, inputTokens: result.inputTokens, outputTokens: result.outputTokens });
    return { result, skipped: false };
  });
}

// ── PhaseExecutor ────────────────────────────────────────────────────────────

const MAX_PREV_OUTPUT_BYTES = 10 * 1024; // cap accumulated generic-loop output at 10KB

export class PhaseExecutor {
  constructor(
    private readonly run: PhaseRunContext,
    private readonly reporter: PhaseReporter,
    private readonly resolver: PhaseResolver,
  ) {}

  /**
   * Execute one DAG node and return its delta. The scheduler accumulates
   * `results` into `phases[]`, merges `outputVars` into the shared outputs
   * map, and maps `status`/`paused`/`aborted` onto node state + run control.
   */
  async execute(
    node: DagNode,
    outputs: Readonly<Record<string, unknown>>,
  ): Promise<PhaseOutcome> {
    const phase = this.run.definition.phases.find((p) => p.name === node.name);
    if (!phase) {
      // Unknown node — shouldn't happen; treat as a no-op success.
      return { results: [{ phase: node.name, success: true, output: "" }], status: "succeeded" };
    }

    const phaseType = phase.type ?? "agent";
    if (phaseType === "context") return this.runContext(phase);

    if (!phase.prompt && !phase.skill) {
      console.warn(`[runner] Phase "${phase.name}" has type=agent but neither prompt: nor skill: — skipping`);
      return { results: [], status: "succeeded" };
    }

    if (phase.loop) return this.runReviewerLoop(phase, outputs);
    if (phase.generic_loop) return this.runGenericLoop(phase, outputs);
    return this.runStandard(phase, outputs);
  }

  // ── Per-phase bodies ───────────────────────────────────────────────────────

  private async runContext(phase: PhaseDefinition): Promise<PhaseOutcome> {
    await this.reporter.onStart(phase.name);
    const result: PhaseResult = { phase: phase.name, success: true, output: "Context assembled" };
    // Persist a phase_history entry so the dashboard marks context phases done.
    this.reporter.persistPhase(phase.name, "Context assembled");
    await this.reporter.onEnd(phase.name, result);
    return { results: [result], status: "succeeded" };
  }

  /** Resolve model + variant for a phase/task, honouring YAML templates first. */
  private resolveModelVariant(
    template: string | undefined,
    variantTemplate: string | undefined,
    taskName: string,
    fallbackTask?: string,
  ): { model?: string; variant?: string } {
    const ctx = this.run.ctx;
    const modelRaw = template ? renderTemplate(template, ctx) : undefined;
    const model = modelRaw || this.resolver.modelFor(taskName)
      || (fallbackTask ? this.resolver.modelFor(fallbackTask) : undefined);
    const variantRaw = variantTemplate ? renderTemplate(variantTemplate, ctx) : undefined;
    const variant = variantRaw || this.resolver.variantFor(taskName)
      || (fallbackTask ? this.resolver.variantFor(fallbackTask) : undefined);
    return { model, variant };
  }

  private async runPhaseCall(
    label: string,
    prompt: string,
    phase: PhaseDefinition,
    model?: string,
    variant?: string,
  ): Promise<RunPhaseResult> {
    const { definition, config, db, workflowId, githubAccess, taskId, triggerId } = this.run;
    return runPhase(
      definition.name,
      label,
      taskId,
      triggerId,
      prompt,
      phaseConfigFor(config, phase),
      db,
      model,
      workflowId,
      githubAccess,
      variant,
    );
  }

  private async runStandard(
    phase: PhaseDefinition,
    outputs: Readonly<Record<string, unknown>>,
  ): Promise<PhaseOutcome> {
    const phaseName = phase.name;
    await this.reporter.onStart(phaseName);
    await this.reporter.step(phaseName, "running", phase.messages?.on_start);

    const { model, variant } = this.resolveModelVariant(phase.model, phase.variant, phaseName);
    const prompt = buildPhasePrompt(phase, this.run.ctx, { phaseOutputs: outputs });

    const pr = await this.runPhaseCall(phaseName, prompt, phase, model, variant);

    if (pr.skipped) {
      if (pr.reason === "running") {
        await this.reporter.message(phase.messages?.on_skipped_done);
        return { results: [], status: "failed", aborted: true };
      }
      const result: PhaseResult = { phase: phaseName, success: true, output: "Already completed" };
      this.reporter.persistPhase(phaseName, "Already completed (deduplicated)");
      await this.reporter.onEnd(phaseName, result);
      await this.reporter.step(phaseName, "done", phase.messages?.on_skipped_done);
      return { results: [result], status: "succeeded" };
    }

    const result: PhaseResult = { phase: phaseName, ...pickResult(pr.result) };
    await this.reporter.onEnd(phaseName, result);

    const rawOutput = pr.result.output ?? "";
    const outputVars: Record<string, unknown> = { [phaseName]: rawOutput };
    if (phase.output_var) outputVars[phase.output_var] = rawOutput;

    if (!pr.result.success) {
      if (!isTerminated(pr.result.error)) {
        await this.reporter.step(phaseName, "failed", phase.messages?.on_failure);
      }
      this.reporter.failWorkflow(pr.result.error);
      return { results: [result], status: "failed", outputVars };
    }

    // on_output rules (BLOCKED).
    if (phase.on_output) {
      const blocked = await this.evaluateBlocked(phase, pr.result.output ?? "");
      if (blocked === "fail") {
        const failResult: PhaseResult = {
          phase: phaseName,
          success: false,
          output: pr.result.output ?? "",
          error: "BLOCKED",
        };
        return { results: [failResult], status: "failed", outputVars };
      }
    }

    // Approval gate.
    if (phase.approval_gate && this.resolver.gateEnabled(phase.approval_gate) && this.run.db && this.run.workflowId) {
      await this.pauseForApproval(
        phaseName,
        phase.approval_gate,
        `${phaseName} complete — awaiting ${phase.approval_gate} approval.`,
        "approve",
        phase.approval_gate_message,
        { gateKey: phase.approval_gate },
      );
      return { results: [result], status: "succeeded", paused: true, outputVars };
    }

    this.reporter.persistPhase(phaseName);
    await this.reporter.step(phaseName, "done", phase.messages?.on_success);
    return { results: [result], status: "succeeded", outputVars };
  }

  /**
   * Evaluate the `contains_BLOCKED` rule. Returns "fail" when the workflow
   * should fail, or "continue" when the marker is absent or bypassed.
   */
  private async evaluateBlocked(
    phase: PhaseDefinition,
    output: string,
  ): Promise<"fail" | "continue"> {
    const rule = phase.on_output?.contains_BLOCKED;
    if (!rule) return "continue";
    if (!output.toUpperCase().includes("BLOCKED")) return "continue";

    const ctx = this.run.ctx;
    const hasUnlessLabel = rule.unless_label && ctx.issueLabels.includes(rule.unless_label);
    const titleMatches = (() => {
      if (!rule.unless_title_matches) return false;
      if (rule.unless_title_matches.length > 200) return false;
      if (/[+*]\{0,\}.*[+*]/.test(rule.unless_title_matches) || /(\([^)]*[+*][^)]*\))[+*?]/.test(rule.unless_title_matches)) return false;
      try {
        return new RegExp(rule.unless_title_matches, "i").test(ctx.issueTitle || "");
      } catch {
        return false;
      }
    })();

    if (hasUnlessLabel || titleMatches) {
      await this.reporter.message(rule.bypass_message || phase.messages?.on_blocked_bypassed);
      return "continue";
    }
    if (rule.action === "fail") {
      this.run.db?.executions.markLatestAsFailed(
        `${this.run.definition.name}:${phase.name}`,
        this.run.triggerId,
        rule.message || "BLOCKED",
        this.run.workflowId,
      );
      this.reporter.failWorkflow(rule.message || "BLOCKED");
      const blockedTemplate = rule.message || phase.messages?.on_blocked;
      if (blockedTemplate) await this.reporter.step(phase.name, "blocked", blockedTemplate);
      return "fail";
    }
    return "continue";
  }

  /**
   * Persist + pause for an approval/reply gate, atomically. The approval
   * insert, the `waiting_approval` phase marker, the optional scratch persist
   * (loops record their iteration/cycle state here), and the run pause all
   * happen in one transaction via `db.runs.pauseForApproval` — a partial
   * failure can't leave the run paused without its gate, or vice versa.
   */
  private async pauseForApproval(
    stepKey: string,
    gate: string,
    summary: string,
    kind: "approve" | "reply",
    message: string | undefined,
    extraCtx: Partial<TemplateContext>,
    scratchPatch?: Record<string, unknown>,
  ): Promise<void> {
    const { db, workflowId, ctx } = this.run;
    if (!db || !workflowId) return;
    const approvalId = randomUUID();
    db.runs.pauseForApproval(
      workflowId,
      {
        id: approvalId,
        workflowRunId: workflowId,
        gate,
        summary,
        kind,
        requestedBy: ctx.sender,
        createdAt: new Date().toISOString(),
      },
      {
        phase: "waiting_approval",
        summary: `Waiting for ${kind === "reply" ? "reply" : "approval"}: ${gate} (${approvalId})`,
      },
      scratchPatch,
    );
    await this.reporter.step(stepKey, "awaiting", message, extraCtx, { alsoNote: true });
  }

  private async runReviewerLoop(
    phase: PhaseDefinition,
    outputs: Readonly<Record<string, unknown>>,
  ): Promise<PhaseOutcome> {
    const loop = phase.loop!;
    const phaseName = phase.name;
    const MAX_CYCLES = loop.max_cycles;
    const { db, workflowId, triggerId, scratch } = this.run;
    const wf = this.run.definition.name;
    const results: PhaseResult[] = [];
    let approved = false;
    let fixCycles = 0;

    // Loop resume state. When the loop pauses at `loop.approval_gate` after a
    // REQUEST_CHANGES verdict, we persist the cycle we paused at so that on
    // resume we can tell "approved — continue with the fix cycle" apart from
    // "review approved → done". Without this, a dedup-`done` review on resume
    // would be misread as APPROVED and skip the required fix. (#94 follow-up)
    const loopKey = `rloop:${phaseName}`;
    const slot = (scratch[loopKey] as Record<string, unknown> | undefined) ?? {};
    const pausedAtCycle = typeof slot.pausedAtCycle === "number" ? slot.pausedAtCycle : undefined;

    while (!approved && fixCycles <= MAX_CYCLES) {
      const reviewLabel =
        fixCycles === 0
          ? PhaseRef.review(phaseName).format()
          : PhaseRef.recheck(phaseName, fixCycles).format();

      await this.reporter.onStart(reviewLabel);
      await this.reporter.step(
        reviewLabel,
        "running",
        loop.messages?.on_cycle_start,
        { cycle: fixCycles + 1, maxCycles: MAX_CYCLES },
        fixCycles === 0
          ? undefined
          : { insert: true, label: `${phase.label ?? phaseName} (cycle ${fixCycles + 1})` },
      );

      const reviewPrompt =
        fixCycles === 0
          ? buildPhasePrompt(phase, this.run.ctx, { phaseOutputs: outputs, fixCycle: fixCycles })
          : this.resolver.renderPrompt(loop.on_request_changes.re_review_prompt, { phaseOutputs: outputs, fixCycle: fixCycles });

      const { model, variant } = this.resolveModelVariant(phase.model, phase.variant, phaseName);
      const rr = await this.runPhaseCall(reviewLabel, reviewPrompt, phase, model, variant);

      // Derive this review's verdict. A dedup-`done` review (resume) is NOT
      // assumed approved — re-parse the verdict from its persisted output.
      let verdict: string | undefined;
      const reviewRan = !rr.skipped;
      if (rr.skipped) {
        if (rr.reason === "running") {
          await this.reporter.message(phase.messages?.on_skipped_done);
          return { results, status: "failed", aborted: true };
        }
        const prevOutput = db?.executions.getPhaseOutput(`${wf}:${reviewLabel}`, triggerId, workflowId) ?? "";
        verdict = parseReviewerVerdict(prevOutput).verdict;
        results.push({ phase: reviewLabel, success: true, output: "Already completed" });
      } else {
        results.push({ phase: reviewLabel, ...pickResult(rr.result) });
        await this.reporter.onEnd(reviewLabel, results[results.length - 1]);
        const reviewerOutput = (rr.result.output || "").trim();
        const parsed = parseReviewerVerdict(reviewerOutput);
        verdict = parsed.verdict;
        if (parsed.viaFallback) {
          console.warn(
            `[runner] Reviewer output missing VERDICT: marker — using fallback detection (isApproved=${verdict === "APPROVED"})`,
          );
        }
        // Persist the review output so a resumed run can re-derive this verdict.
        const execId = "executionId" in rr ? rr.executionId : undefined;
        if (execId && db) db.executions.recordOutputText(execId, reviewerOutput);
      }

      const isApproved = verdict === "APPROVED";

      if (isApproved) {
        approved = true;
        if (reviewRan) this.reporter.persistPhase(reviewLabel, "APPROVED");
        await this.reporter.step(reviewLabel, "done", loop.messages?.on_approved, { cycle: fixCycles + 1 });
      } else if (fixCycles < MAX_CYCLES) {
        fixCycles++;
        if (reviewRan) this.reporter.persistPhase(reviewLabel, "REQUEST_CHANGES");

        // Approval gate before the fix loop. Pause only on a *fresh* gate hit:
        // not when the fix for this cycle has already run (gate was approved in
        // a prior entry), and not when we're resuming right after approving
        // exactly this cycle's gate.
        if (this.resolver.gateEnabled(loop.approval_gate) && db && workflowId) {
          const fixLabel = PhaseRef.fix(phaseName, fixCycles).format();
          const fixAlreadyDone = db.executions.shouldRunPhase(`${wf}:${fixLabel}`, triggerId, workflowId) === "done";
          const resumingThisGate = pausedAtCycle === fixCycles;
          if (!fixAlreadyDone && !resumingThisGate) {
            scratch[loopKey] = { ...slot, pausedAtCycle: fixCycles };
            await this.pauseForApproval(
              reviewLabel,
              loop.approval_gate!,
              `Reviewer requested changes (cycle ${fixCycles}/${MAX_CYCLES}) on phase ${phaseName}.`,
              "approve",
              loop.messages?.on_pause_for_approval,
              { cycle: fixCycles, maxCycles: MAX_CYCLES, gateKey: loop.approval_gate },
              { [loopKey]: scratch[loopKey] },
            );
            return { results, status: "succeeded", paused: true };
          }
        }

        await this.reporter.step(reviewLabel, "done", loop.messages?.on_request_changes, {
          cycle: fixCycles,
          maxCycles: MAX_CYCLES,
        });

        // Fix phase.
        const fixLabel = PhaseRef.fix(phaseName, fixCycles).format();
        await this.reporter.onStart(fixLabel);
        await this.reporter.step(
          fixLabel,
          "running",
          loop.messages?.on_fix_start,
          { cycle: fixCycles, maxCycles: MAX_CYCLES },
          { insert: true, label: `Fix (cycle ${fixCycles})` },
        );

        const { model: fixModel, variant: fixVariant } = this.resolveModelVariant(
          loop.on_request_changes.fix_model,
          loop.on_request_changes.fix_variant,
          `${phaseName}_fix`,
          phaseName,
        );
        const fixPromptRendered = this.resolver.renderPrompt(loop.on_request_changes.fix_prompt, {
          phaseOutputs: outputs,
          fixCycle: fixCycles,
        });

        const fr = await this.runPhaseCall(fixLabel, fixPromptRendered, phase, fixModel, fixVariant);

        if (fr.skipped) {
          if (fr.reason === "running") {
            await this.reporter.message(phase.messages?.on_skipped_done);
            return { results, status: "failed", aborted: true };
          }
          results.push({ phase: fixLabel, success: true, output: "Already completed" });
        } else {
          results.push({ phase: fixLabel, ...pickResult(fr.result) });
          await this.reporter.onEnd(fixLabel, results[results.length - 1]);

          if (!fr.result.success) {
            if (!isTerminated(fr.result.error)) {
              await this.reporter.step(fixLabel, "failed", loop.messages?.on_fix_failed, {
                cycle: fixCycles,
                maxCycles: MAX_CYCLES,
              });
            }
            break;
          }
          this.reporter.persistPhase(fixLabel);
          await this.reporter.step(fixLabel, "done");
        }
      } else {
        this.reporter.persistPhase(reviewLabel, "REQUEST_CHANGES — max cycles reached");
        await this.reporter.step(reviewLabel, "blocked", loop.messages?.on_max_cycles, {
          cycle: fixCycles,
          maxCycles: MAX_CYCLES,
        }, { alsoNote: true });
        break;
      }
    }

    const outputVars: Record<string, unknown> = {};
    if (phase.output_var) outputVars[phase.output_var] = { approved, cycles: fixCycles };
    // The loop node itself succeeds as a scheduling unit — even at max cycles
    // the linear runner continued to the next phase. Individual review/fix
    // results carry their own success flags for the run-level rollup.
    return { results, status: "succeeded", outputVars };
  }

  private async runGenericLoop(
    phase: PhaseDefinition,
    outputs: Readonly<Record<string, unknown>>,
  ): Promise<PhaseOutcome> {
    const loop = phase.generic_loop!;
    const phaseName = phase.name;
    const MAX_ITER = loop.max_iterations;
    const { db, workflowId, scratch, config } = this.run;
    const results: PhaseResult[] = [];

    // Reply-gate loops resume mid-flight: read the saved iteration from scratch.
    const scratchKey = loop.scratch_key;
    const scratchSlot = (scratchKey
      ? (scratch[scratchKey] as Record<string, unknown> | undefined) ?? {}
      : {}) as Record<string, unknown>;
    const resumeFromIter =
      loop.gate_kind === "reply" && typeof scratchSlot.iteration === "number"
        ? Math.min(scratchSlot.iteration as number, MAX_ITER)
        : 0;

    let iteration = resumeFromIter;
    let complete = false;
    let previousOutput =
      (scratchSlot.lastOutputExecutionId && db
        ? db.executions.getExecutionOutput(scratchSlot.lastOutputExecutionId as string) ?? ""
        : (scratchSlot.lastOutput as string | undefined) ?? "");

    await this.reporter.step(phaseName, "running");

    while (!complete && iteration < MAX_ITER) {
      iteration++;
      const iterLabel = PhaseRef.iter(phaseName, iteration).format();
      await this.reporter.onStart(iterLabel);

      const iterCtx: Partial<TemplateContext> = {
        iteration,
        maxIterations: MAX_ITER,
        previousOutput: loop.fresh_context ? "" : previousOutput,
        phaseOutputs: outputs,
        scratch,
      };
      const prompt = buildPhasePrompt(phase, this.run.ctx, iterCtx);
      const { model, variant } = this.resolveModelVariant(phase.model, phase.variant, phaseName);

      const ir = await this.runPhaseCall(iterLabel, prompt, phase, model, variant);

      if (ir.skipped) {
        if (ir.reason === "running") {
          await this.reporter.message(phase.messages?.on_skipped_done, { iteration });
          return { results, status: "failed", aborted: true };
        }
        results.push({ phase: iterLabel, success: true, output: "Already completed" });
        complete = true;
        break;
      }

      results.push({ phase: iterLabel, ...pickResult(ir.result) });
      await this.reporter.onEnd(iterLabel, results[results.length - 1]);

      if (!ir.result.success) {
        if (!isTerminated(ir.result.error)) {
          await this.reporter.step(phaseName, "failed", phase.messages?.on_failure, { iteration });
        }
        this.reporter.failWorkflow(ir.result.error);
        const outputVars = phase.output_var
          ? { [phase.output_var]: { completed: false, iterations: iteration } }
          : undefined;
        return { results, status: "failed", outputVars };
      }

      const iterOutput = ir.result.output || "";
      if (!loop.fresh_context) {
        const combined = previousOutput ? `${previousOutput}\n${iterOutput}` : iterOutput;
        previousOutput = combined.length > MAX_PREV_OUTPUT_BYTES ? combined.slice(-MAX_PREV_OUTPUT_BYTES) : combined;
      }

      let conditionMet = false;
      if (loop.until) {
        conditionMet = evalUntilExpression(loop.until, {
          output: iterOutput,
          scratch,
          ...Object.fromEntries(
            Object.entries(this.run.ctx)
              .filter(([, v]) => typeof v === "string")
              .map(([k, v]) => [k, v as string]),
          ),
        });
      }
      if (!conditionMet && loop.until_bash) {
        try {
          validateShellCommand(loop.until_bash);
          execSync(loop.until_bash, { timeout: 30_000, stdio: "pipe", cwd: config.sandboxDir ?? config.cwd });
          conditionMet = true;
        } catch {
          conditionMet = false;
        }
      }

      const iterExecutionId = "executionId" in ir ? ir.executionId : undefined;
      if (iterExecutionId && db) db.executions.recordOutputText(iterExecutionId, iterOutput);

      if (conditionMet) {
        complete = true;
        if (scratchKey && db && workflowId) {
          const slot: Record<string, unknown> = { ...scratchSlot, iteration, ready: true };
          if (iterExecutionId) slot.lastOutputExecutionId = iterExecutionId;
          delete slot.lastOutput;
          db.runs.mergeScratch(workflowId, { [scratchKey]: slot });
          scratch[scratchKey] = slot;
        }
        this.reporter.persistPhase(iterLabel, `iteration ${iteration} — condition met`);
        await this.reporter.step(phaseName, "done");
        break;
      }

      // Interactive gate between iterations.
      if (loop.interactive && !complete && db && workflowId) {
        const isReply = loop.gate_kind === "reply";
        const gateMsg = loop.gate_message
          ? renderTemplate(loop.gate_message, { ...this.run.ctx, phaseOutputs: outputs, iteration, maxIterations: MAX_ITER, scratch })
          : `Loop iteration ${iteration}/${MAX_ITER} complete.`;

        let gateScratchPatch: Record<string, unknown> | undefined;
        if (scratchKey) {
          const slot: Record<string, unknown> = {
            ...(scratch[scratchKey] as Record<string, unknown> | undefined),
            iteration,
          };
          if (iterExecutionId) slot.lastOutputExecutionId = iterExecutionId;
          delete slot.lastOutput;
          scratch[scratchKey] = slot;
          gateScratchPatch = { [scratchKey]: slot };
        }

        const approvalId = randomUUID();
        // One transaction: persist the iteration scratch, create the pending
        // gate, append the waiting_approval marker, and pause the run.
        db.runs.pauseForApproval(
          workflowId,
          {
            id: approvalId,
            workflowRunId: workflowId,
            gate: iterLabel,
            summary: gateMsg,
            kind: isReply ? "reply" : "approve",
            requestedBy: this.run.ctx.sender,
            createdAt: new Date().toISOString(),
          },
          {
            phase: "waiting_approval",
            summary: `Waiting for ${isReply ? "reply" : "approval"}: ${iterLabel} (${approvalId})`,
          },
          gateScratchPatch,
        );
        await this.reporter.step(phaseName, "awaiting");

        if (isReply) {
          const parts = [iterOutput.trim(), gateMsg.trim()].filter(Boolean);
          if (parts.length > 0) await this.reporter.postNote(parts.join("\n\n---\n\n"));
        } else {
          await this.reporter.postNote(
            `**${phaseName} iteration ${iteration}/${MAX_ITER} complete** — approval required to continue.\n\n` +
              `${gateMsg}\n\n` +
              `**To continue:** comment \`@last-light approve\`\n` +
              `**To abort:** comment \`@last-light reject [reason]\``,
          );
        }
        return { results, status: "succeeded", paused: true };
      }

      this.reporter.persistPhase(iterLabel);
    }

    if (!complete) {
      await this.reporter.step(phaseName, "failed", phase.messages?.on_failure, {
        iteration,
        maxIterations: MAX_ITER,
      });
    }

    const outputVars = phase.output_var
      ? { [phase.output_var]: { completed: complete, iterations: iteration } }
      : undefined;
    return { results, status: "succeeded", outputVars };
  }
}

// Keep a re-export path stable for any external consumer of these helpers.
export type { ProgressStep };
