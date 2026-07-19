import { randomUUID } from "node:crypto";
import type {
  ExecutorConfig,
  ExecutionResult,
  GitSandboxAccess,
  CommandSpec,
} from "./types.js";
import type { AgentWorkflowDefinition, PhaseDefinition } from "./schema.js";
import { phaseSkillNames } from "./schema.js";
import { renderTemplate, type TemplateContext } from "./templates.js";
import { evalUntilExpression } from "./loop-eval.js";
import { parseReviewerVerdict } from "./verdict.js";
import { PhaseRef } from "./phase-ref.js";
import type { DagNode } from "./dag.js";
import type {
  AgentPort,
  AssetLoader,
  EnginePorts,
  LivenessPort,
  ObservabilityPort,
  PhaseOutcome,
  PhaseReporter,
  PhaseResolver,
  PhaseResult,
  WorkflowStateStore,
} from "../ports/ports.js";

// Re-export the collaborator/result port types so existing importers of the
// old `./phase-executor.js` path (runner, tests) keep resolving them here.
export type {
  PhaseReporter,
  PhaseResolver,
  PhaseOutcome,
  PhaseResult,
  ReportStepOpts,
} from "../ports/ports.js";

/**
 * The single per-phase executor. Constructed once per workflow run, it owns
 * every per-phase body — context / standard agent / reviewer-loop /
 * generic-loop — behind one `execute(node, outputs)` entry point. The
 * scheduler (`core/scheduler.ts`) owns the DAG, the `phases[]`/`outputs{}`
 * accumulation, and the in-memory node status; `execute` reads the current
 * outputs and returns its delta.
 *
 * Dependencies are grouped into cohesive collaborators:
 *   - {@link PhaseRunContext}  run-scoped immutable data
 *   - {@link PhaseReporter}    progress / notification surface
 *   - {@link PhaseResolver}    model / variant / prompt / gate resolution
 *   - {@link EnginePorts}      injected agent / asset / liveness / telemetry
 *                              seams + app-registered phase-type handlers
 *
 * This makes the executor unit-testable with fakes and keeps the engine
 * domain-agnostic (no imports of `../engine`, `../state`, `../config`, …).
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
  /** Runs + dedup-ledger store (omitted ⇒ inert gates + no ledger resume). */
  store?: WorkflowStateStore;
  workflowId?: string;
  /** Bot identity (was `getBotName()`), used in the generic-loop gate prompt. */
  botName: string;
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
 * Forward upstream phase outputs to a `bash`/`script` command as env vars
 * (`LL_OUT_<PHASE>`), so a script can read them via `process.env` / `os.environ`
 * without any shell-injection risk. Only simple single-line, reasonably-sized
 * string outputs are forwarded; larger / multi-line outputs are still reachable
 * via `{{phaseOutputs.<name>.output}}` template substitution in the command.
 */
function upstreamOutputsEnv(outputs: Readonly<Record<string, unknown>>): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(outputs)) {
    if (typeof v !== "string" || v.length === 0 || v.length > 4096) continue;
    if (/[\n\r]/.test(v)) continue;
    const key = `LL_OUT_${k.toUpperCase().replace(/[^A-Z0-9_]/g, "_")}`;
    if (/^LL_OUT_[A-Z0-9_]+$/.test(key)) env[key] = v;
  }
  return env;
}

/**
 * Build the agent prompt for a phase, handling both `prompt:` (template file)
 * and `skill:`/`skills:` (skill references) phase definitions.
 */
export function buildPhasePrompt(
  phase: PhaseDefinition,
  ctx: TemplateContext,
  assets: AssetLoader,
  extraCtx?: Partial<TemplateContext>,
): string {
  const fullCtx = extraCtx ? { ...ctx, ...extraCtx } : ctx;

  if (phase.prompt) {
    const template = assets.loadPromptTemplate(phase.prompt);
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
 * `web_search`, `sandbox_image`, resolved skill paths) onto the run-level
 * config.
 */
export function phaseConfigFor(config: ExecutorConfig, phase: PhaseDefinition, assets: AssetLoader): ExecutorConfig {
  const skills = phaseSkillNames(phase);
  const skillPaths = skills.length ? assets.resolveSkillPaths(skills) : undefined;

  if (
    phase.unrestricted_egress === undefined &&
    phase.web_search === undefined &&
    phase.sandbox_image === undefined &&
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
  if (phase.sandbox_image !== undefined) {
    next.sandboxImage = phase.sandbox_image;
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

/**
 * Classify an execution outcome as *soft* — a clean exit that produced no
 * usable output — versus *hard* (a real crash). Generic and phase-agnostic:
 * it reads only the result fields, with no notion of reviewer/socratic. Both
 * the reviewer loop and the generic loop consume it so their recovery logic
 * stays in lockstep. A soft outcome is recoverable (retry / trust an on-disk
 * artifact / advance); a hard one — terminated, fatal, tool error, non-zero
 * exit — is not. See `mapStopReason` in the executors for the stop-reason
 * vocabulary this keys off (`unknown` / `error_truncated` are the soft ones).
 */
export function isSoftOutcome(
  r: Pick<ExecutionResult, "success" | "error" | "stopReason">,
): boolean {
  if (r.success) return true;
  if (isTerminated(r.error)) return false;
  return r.stopReason === "unknown" || r.stopReason === "error_truncated";
}

function pickResult(r: ExecutionResult): Pick<ExecutionResult, "success" | "output" | "error"> {
  return { success: r.success, output: r.output, error: r.error };
}

function issueNumberFromTrigger(triggerId: string): number | undefined {
  const m = triggerId.match(/#(\d+)$/);
  return m ? Number(m[1]) : undefined;
}

/**
 * The seams the dedup ledger needs: the runs+executions store, the agent
 * runtime, container liveness, and telemetry. Threaded from the
 * {@link PhaseExecutor}'s injected {@link EnginePorts}.
 */
interface LedgerDeps {
  store?: WorkflowStateStore;
  agent: AgentPort;
  liveness: LivenessPort;
  observability: ObservabilityPort;
}

/** Check if a sandbox container is actually running for a given taskId prefix. */
async function isContainerAlive(liveness: LivenessPort, taskId: string): Promise<boolean> {
  try {
    return await liveness.isPhaseContainerAlive(taskId);
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
/**
 * The DB-tracked dedup ledger shared by agent phases ({@link runPhase}) and
 * deterministic command phases ({@link runCommandPhase}). The `run` callback
 * does the actual work and receives a session-id sink so the executions row can
 * be linked to its session jsonl mid-run. `shouldRunPhase` is the single source
 * of truth for resume — re-running from the top skips completed phases here.
 */
async function runPhaseLedger(
  attrs: Record<string, unknown>,
  meta: {
    dedupKey: string;
    phaseName: string;
    taskId: string;
    triggerId: string;
    repo?: string;
    workflowRunId?: string;
  },
  deps: LedgerDeps,
  run: (onSessionId: (sessionId: string) => void) => Promise<ExecutionResult>,
): Promise<RunPhaseResult> {
  const { dedupKey, phaseName, taskId, triggerId, repo, workflowRunId } = meta;
  const { store: db, liveness, observability } = deps;
  return observability.withSpan("lastlight.workflow.phase", attrs, async (span) => {
    if (db) {
      const status = db.executions.shouldRunPhase(dedupKey, triggerId, workflowRunId);

      if (status === "running") {
        const alive = await isContainerAlive(liveness, taskId);
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
        repo,
        issueNumber: issueNumberFromTrigger(triggerId),
        startedAt: new Date().toISOString(),
        workflowRunId,
      });

      try {
        const result = await run((sessionId) => {
          try {
            db.executions.recordSessionId(executionId, sessionId);
          } catch (err) {
            console.warn(`[runner] Failed to persist session id mid-run for ${phaseName}:`, err);
          }
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
          skillsStatus: result.skills ? JSON.stringify(result.skills) : undefined,
        });
        span?.setAttributes({ success: result.success, stop_reason: result.stopReason ?? "unknown" });
        observability.recordExecutionMetrics("phase", { ...attrs, success: result.success, stop_reason: result.stopReason, durationMs: result.durationMs, costUsd: result.costUsd, inputTokens: result.inputTokens, outputTokens: result.outputTokens });
        return { result, executionId, skipped: false };
      } catch (err) {
        observability.recordError("phase", err, attrs);
        // `run(...)` threw before it could `recordFinish` — e.g. provisioning
        // (prePopulateWorkspace) failed before the agent even started. Without
        // this the `executions` row stays `started` forever (renders `…` in the
        // CLI/dashboard instead of `✗`). The success path already finished the
        // row and returned, so this only fires on a genuine throw — no
        // double-finish.
        db.executions.recordFinish(executionId, {
          success: false,
          error: err instanceof Error ? err.message : String(err),
          stopReason: "error_fatal",
        });
        throw err;
      }
    }

    const result = await run(() => {});
    observability.recordExecutionMetrics("phase", { ...attrs, success: result.success, stop_reason: result.stopReason, durationMs: result.durationMs, costUsd: result.costUsd, inputTokens: result.inputTokens, outputTokens: result.outputTokens });
    return { result, skipped: false };
  });
}

/**
 * Run a single agent phase with DB-tracked deduplication. The dedup ledger
 * (`shouldRunPhase`) is the single source of truth for resume, so re-running
 * from the top skips completed phases here.
 */
export async function runPhase(
  workflowName: string,
  phaseName: string,
  taskId: string,
  triggerId: string,
  prompt: string,
  config: ExecutorConfig,
  deps: LedgerDeps,
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
  const baseConfig = modelOverride ? { ...config, model: modelOverride } : config;
  const phaseConfigBase = variantOverride ? { ...baseConfig, variant: variantOverride } : baseConfig;
  const phaseConfig: ExecutorConfig = {
    ...phaseConfigBase,
    telemetry: { workflowName, phaseName, triggerId, workflowRunId },
  };
  return runPhaseLedger(attrs, { dedupKey, phaseName, taskId, triggerId, repo: githubAccess?.repo, workflowRunId }, deps, (onSessionId) =>
    deps.agent.runAgent(prompt, phaseConfig, { taskId, githubAccess, onSessionId }),
  );
}

/**
 * Run a single deterministic `bash`/`script` phase, sharing the agent phase's
 * dedup ledger + executions row so it appears (and dedups on resume) exactly
 * like an agent phase — just with `turns: 0` and no model cost.
 */
export async function runCommandPhase(
  workflowName: string,
  phaseName: string,
  taskId: string,
  triggerId: string,
  spec: CommandSpec,
  config: ExecutorConfig,
  deps: LedgerDeps,
  workflowRunId?: string,
  githubAccess?: GitSandboxAccess,
  timeoutSeconds?: number,
  sandboxEnv?: Record<string, string>,
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
    model: spec.kind,
  };
  const phaseConfig: ExecutorConfig = { ...config, telemetry: { workflowName, phaseName, triggerId, workflowRunId } };
  return runPhaseLedger(attrs, { dedupKey, phaseName, taskId, triggerId, repo: githubAccess?.repo, workflowRunId }, deps, (onSessionId) =>
    deps.agent.runCommand(spec, phaseConfig, { taskId, githubAccess, onSessionId, timeoutSeconds, sandboxEnv }),
  );
}

// ── PhaseExecutor ────────────────────────────────────────────────────────────

const MAX_PREV_OUTPUT_BYTES = 10 * 1024; // cap accumulated generic-loop output at 10KB

export class PhaseExecutor {
  constructor(
    private readonly run: PhaseRunContext,
    private readonly reporter: PhaseReporter,
    private readonly resolver: PhaseResolver,
    private readonly ports: EnginePorts,
  ) {}

  /** The dedup-ledger seams, bundled from the injected ports + run store. */
  private get ledgerDeps(): LedgerDeps {
    return {
      store: this.run.store,
      agent: this.ports.agent,
      liveness: this.ports.liveness,
      observability: this.ports.observability,
    };
  }

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
    if (phaseType === "bash" || phaseType === "script") return this.runCommandBody(phase, outputs);

    // Non-generic phase types (e.g. `post-review`) are dispatched to
    // app-registered handlers — the engine owns only the generic kinds.
    const handler = this.ports.handlers?.get(phaseType);
    if (handler) return handler.execute(phase, node, outputs);

    if (!phase.prompt && phaseSkillNames(phase).length === 0) {
      console.warn(`[runner] Phase "${phase.name}" has type=agent but neither prompt: nor skills: — skipping`);
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
    const { definition, config, workflowId, githubAccess, taskId, triggerId } = this.run;
    return runPhase(
      definition.name,
      label,
      taskId,
      triggerId,
      prompt,
      phaseConfigFor(config, phase, this.ports.assets),
      this.ledgerDeps,
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
    const prompt = buildPhasePrompt(phase, this.run.ctx, this.ports.assets, { phaseOutputs: outputs });

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

      // Postcondition marker: the run must sign off with an agreed completion
      // marker. Its absence means the agent stopped without reaching an outcome
      // — a silent no-op that would otherwise report success. Fail it like any
      // phase failure (posts on_failure, records the error) so it shows red.
      const marker = phase.on_output.requires_marker;
      if (marker && !(pr.result.output ?? "").includes(marker)) {
        const error = `phase produced no outcome — missing completion marker "${marker}"`;
        await this.reporter.step(phaseName, "failed", phase.messages?.on_failure);
        this.reporter.failWorkflow(error);
        const failResult: PhaseResult = {
          phase: phaseName,
          success: false,
          output: pr.result.output ?? "",
          error,
        };
        return { results: [failResult], status: "failed", outputVars };
      }
    }

    // Approval gate.
    if (phase.approval_gate && this.resolver.gateEnabled(phase.approval_gate) && this.run.store && this.run.workflowId) {
      await this.pauseForApproval(
        phaseName,
        phase.approval_gate,
        `${phaseName} complete — awaiting ${phase.approval_gate} approval.`,
        "approve",
        phase.approval_gate_message,
        { gateKey: phase.approval_gate },
        undefined,
        phase.approval_artifact,
      );
      return { results: [result], status: "succeeded", paused: true, outputVars };
    }

    this.reporter.persistPhase(phaseName);
    // Make THIS phase's own output available to its on_success message. The
    // scheduler only merges `outputVars` into the shared outputs map after
    // execute() returns, so without this a phase referencing its own output
    // (e.g. answer's `on_success: "{{answerResult}}"`, explore's publishResult)
    // would render empty. Merge the just-produced vars into the render context.
    await this.reporter.step(phaseName, "done", phase.messages?.on_success, {
      phaseOutputs: { ...outputs, ...outputVars },
    });
    return { results: [result], status: "succeeded", outputVars };
  }

  /**
   * Body for `type: bash` / `type: script` phases. Runs a deterministic command
   * in the sandbox (no LLM), then mirrors the agent-phase lifecycle: report
   * progress, expose stdout downstream via `output_var` →
   * `{{phaseOutputs.<name>.output}}`, fail the workflow on a non-zero exit, and
   * honour an optional `approval_gate`.
   */
  private async runCommandBody(
    phase: PhaseDefinition,
    outputs: Readonly<Record<string, unknown>>,
  ): Promise<PhaseOutcome> {
    const phaseName = phase.name;
    await this.reporter.onStart(phaseName);
    await this.reporter.step(phaseName, "running", phase.messages?.on_start);

    const spec = this.buildCommandSpec(phase, outputs);
    const sandboxEnv = upstreamOutputsEnv(outputs);
    const pr = await this.runCommandPhaseCall(phaseName, phase, spec, sandboxEnv);

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

    if (phase.approval_gate && this.resolver.gateEnabled(phase.approval_gate) && this.run.store && this.run.workflowId) {
      await this.pauseForApproval(
        phaseName,
        phase.approval_gate,
        `${phaseName} complete — awaiting ${phase.approval_gate} approval.`,
        "approve",
        phase.approval_gate_message,
        { gateKey: phase.approval_gate },
        undefined,
        phase.approval_artifact,
      );
      return { results: [result], status: "succeeded", paused: true, outputVars };
    }

    this.reporter.persistPhase(phaseName);
    await this.reporter.step(phaseName, "done", phase.messages?.on_success, {
      phaseOutputs: { ...outputs, ...outputVars },
    });
    return { results: [result], status: "succeeded", outputVars };
  }

  /** Render a command/script phase's template fields into a {@link CommandSpec}. */
  private buildCommandSpec(
    phase: PhaseDefinition,
    outputs: Readonly<Record<string, unknown>>,
  ): CommandSpec {
    const ctx: TemplateContext = { ...this.run.ctx, phaseOutputs: outputs as Record<string, unknown> };
    if ((phase.type ?? "agent") === "script") {
      const script = renderTemplate(phase.script ?? "", ctx);
      return { kind: "script", script, runtime: phase.runtime ?? "js", name: phase.name.replace(/[^A-Za-z0-9_-]/g, "_") };
    }
    const command = renderTemplate(phase.command ?? "", ctx);
    // Guard against an unresolved template marker reaching the shell.
    validateShellCommand(command);
    return { kind: "bash", command };
  }

  private async runCommandPhaseCall(
    label: string,
    phase: PhaseDefinition,
    spec: CommandSpec,
    sandboxEnv: Record<string, string>,
  ): Promise<RunPhaseResult> {
    const { definition, config, workflowId, githubAccess, taskId, triggerId } = this.run;
    return runCommandPhase(
      definition.name,
      label,
      taskId,
      triggerId,
      spec,
      phaseConfigFor(config, phase, this.ports.assets),
      this.ledgerDeps,
      workflowId,
      githubAccess,
      phase.timeout_seconds,
      sandboxEnv,
    );
  }

  /**
   * Evaluate a `generic_loop.until_bash` condition INSIDE the sandbox (against
   * the persisted workspace), replacing the old harness-host `execSync`. Exit 0
   * ⇒ loop complete. The check inherits the phase's egress; no session log is
   * written (it's an internal loop condition, not a user-facing phase).
   */
  private async runUntilBash(command: string, phase: PhaseDefinition): Promise<boolean> {
    const { config, githubAccess, taskId, triggerId, definition, workflowId } = this.run;
    try {
      validateShellCommand(command);
      const res = await this.ports.agent.runCommand(
        { kind: "bash", command },
        { ...phaseConfigFor(config, phase, this.ports.assets), telemetry: { workflowName: definition.name, phaseName: `${phase.name}_until`, triggerId, workflowRunId: workflowId } },
        { taskId, githubAccess, timeoutSeconds: phase.timeout_seconds ?? 30, writeSession: false },
      );
      return res.success;
    } catch {
      return false;
    }
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
      this.run.store?.executions.markLatestAsFailed(
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
    artifact?: string,
  ): Promise<void> {
    const { store: db, workflowId, ctx } = this.run;
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
        artifact,
        requestedBy: ctx.sender,
        createdAt: new Date().toISOString(),
      },
      {
        phase: "waiting_approval",
        summary: `Waiting for ${kind === "reply" ? "reply" : "approval"}: ${gate} (${approvalId})`,
      },
      scratchPatch,
    );
    // Expose `approvalId` to the gate message template so it can deep-link to
    // the focused approval view via `{{approvalUrl}}`. Transition the checklist
    // step to "awaiting" (with a collapsed detail), then post the full prompt
    // as a standalone note: approve gates get interactive Approve/Reject buttons
    // (Slack) via `approvalNote`; reply gates stay a plain message.
    await this.reporter.step(stepKey, "awaiting", message, { ...extraCtx, approvalId });
    if (kind === "approve") {
      await this.reporter.approvalNote(message, { ...extraCtx, approvalId }, { workflowRunId: workflowId });
    } else {
      await this.reporter.message(message, { ...extraCtx, approvalId });
    }
  }

  private async runReviewerLoop(
    phase: PhaseDefinition,
    outputs: Readonly<Record<string, unknown>>,
  ): Promise<PhaseOutcome> {
    const loop = phase.loop!;
    const phaseName = phase.name;
    const MAX_CYCLES = loop.max_cycles;
    const { store: db, workflowId, triggerId, scratch } = this.run;
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
          ? buildPhasePrompt(phase, this.run.ctx, this.ports.assets, { phaseOutputs: outputs, fixCycle: fixCycles })
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
        const reviewerOutput = (rr.result.output || "").trim();
        let parsed = parseReviewerVerdict(reviewerOutput);
        let resultOverride = pickResult(rr.result);
        // Some models (e.g. gpt-5-codex) end their final turn on the
        // reviewer-verdict.md write with no trailing stdout, so the VERDICT:
        // marker is absent from stdout even though the review completed cleanly
        // — the run then mislabels a clean APPROVED as a failure AND runs a
        // needless fix cycle. When the marker is missing from stdout, trust the
        // verdict FILE (the reviewer's OUTPUT CONTRACT) and treat the phase as
        // successful. Gated to soft outcomes (clean exit / "unknown" /
        // truncated) so a hard sandbox failure can't be masked by a stale
        // verdict doc left in the persistent per-issue store.
        const soft = isSoftOutcome(rr.result);
        if (parsed.viaFallback && soft) {
          const fromFile = this.ports.verdictReader?.read({
            config: this.run.config,
            repo: String(this.run.ctx.repo),
            issueDir: typeof this.run.ctx.issueDir === "string" ? this.run.ctx.issueDir : "",
            taskId: this.run.taskId,
          });
          if (fromFile) {
            parsed = fromFile;
            resultOverride = { ...resultOverride, success: true, error: undefined };
            console.warn(
              `[runner] Reviewer stdout missing VERDICT: marker — recovered ${fromFile.verdict} from reviewer-verdict.md`,
            );
          }
        }
        verdict = parsed.verdict;
        if (parsed.viaFallback) {
          console.warn(
            `[runner] Reviewer output missing VERDICT: marker — using fallback detection (isApproved=${verdict === "APPROVED"})`,
          );
        }
        results.push({ phase: reviewLabel, ...resultOverride });
        await this.reporter.onEnd(reviewLabel, results[results.length - 1]);
        // Persist a marker-bearing output so a resumed run re-derives this exact
        // verdict (stdout may have been empty when recovered from the file).
        const persistText = /^\s*VERDICT:/im.test(reviewerOutput)
          ? reviewerOutput
          : `VERDICT: ${verdict}\n${reviewerOutput}`;
        const execId = "executionId" in rr ? rr.executionId : undefined;
        if (execId && db) db.executions.recordOutputText(execId, persistText);
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
              loop.approval_artifact,
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
    const { store: db, workflowId, scratch, config } = this.run;
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
      const prompt = buildPhasePrompt(phase, this.run.ctx, this.ports.assets, iterCtx);
      const { model, variant } = this.resolveModelVariant(phase.model, phase.variant, phaseName);

      let ir = await this.runPhaseCall(iterLabel, prompt, phase, model, variant);

      if (ir.skipped) {
        if (ir.reason === "running") {
          await this.reporter.message(phase.messages?.on_skipped_done, { iteration });
          return { results, status: "failed", aborted: true };
        }
        results.push({ phase: iterLabel, success: true, output: "Already completed" });
        complete = true;
        break;
      }

      // Soft-outcome retry: a clean-but-empty turn (stop reason unknown /
      // truncated, no usable output — not a real crash) re-runs the same round
      // up to `on_soft_failure.retries` times, under a distinct `_iter_n_retry`
      // ledger label so resume/dedup treats it as its own step. The round
      // number (`scratch.iteration`) is NOT advanced by a retry.
      const softPolicy = loop.on_soft_failure ?? { retries: 0, then: "fail" as const };
      let softAttempts = 0;
      while (!ir.result.success && isSoftOutcome(ir.result) && softAttempts < softPolicy.retries) {
        softAttempts++;
        const retryLabel = PhaseRef.iterRetry(phaseName, iteration).format();
        await this.reporter.onStart(retryLabel);
        const retry = await this.runPhaseCall(retryLabel, prompt, phase, model, variant);
        if (retry.skipped) break;
        await this.reporter.onEnd(retryLabel, { phase: retryLabel, ...pickResult(retry.result) });
        ir = retry;
      }

      // A soft outcome that survived the retries: honour the loop's policy.
      // `then: complete` treats the loop as finished (as if the `until`
      // condition matched) and advances downstream with the work gathered so
      // far — recording the iteration as a success so the run-level rollup
      // (`anyFailed` in runner.ts) stays green. `then: fail` (the default)
      // drops through to the hard-fail path below, preserving old behavior.
      if (!ir.result.success && isSoftOutcome(ir.result) && softPolicy.then === "complete") {
        const iterExecutionId = "executionId" in ir ? ir.executionId : undefined;
        results.push({ phase: iterLabel, success: true, output: ir.result.output || previousOutput || "" });
        await this.reporter.onEnd(iterLabel, results[results.length - 1]);
        complete = true;
        if (scratchKey && db && workflowId) {
          const slot: Record<string, unknown> = { ...scratchSlot, iteration, ready: true };
          if (iterExecutionId) slot.lastOutputExecutionId = iterExecutionId;
          delete slot.lastOutput;
          db.runs.mergeScratch(workflowId, { [scratchKey]: slot });
          scratch[scratchKey] = slot;
        }
        this.reporter.persistPhase(iterLabel, `iteration ${iteration} — soft outcome, advancing`);
        await this.reporter.step(phaseName, "done");
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
        conditionMet = await this.runUntilBash(loop.until_bash, phase);
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
              `**To continue:** comment \`@${this.run.botName} approve\`\n` +
              `**To abort:** comment \`@${this.run.botName} reject [reason]\``,
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
