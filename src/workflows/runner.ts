import type {
  ExecutorConfig,
  GitAccessProfile,
  GitSandboxAccess,
} from "../engine/profiles.js";
import type { StateDb } from "../state/db.js";
import type { PhaseHistoryEntry } from "../state/db.js";
import type { ModelConfig, VariantConfig } from "../config.js";
import { resolveModel, resolveVariant } from "../config.js";
import type { AgentWorkflowDefinition } from "./schema.js";
import { loadPromptTemplate } from "./loader.js";
import { renderTemplate, type TemplateContext } from "./templates.js";
import { buildDag, getReadyNodes, getNodesToSkip, isComplete } from "./dag.js";
import {
  PhaseExecutor,
  isTerminated,
  type PhaseReporter,
  type PhaseResolver,
  type PhaseRunContext,
  type ReportStepOpts,
} from "./phase-executor.js";
import type { ProgressReporter, StepStatus, ProgressStep } from "../notify/types.js";
import { collapseDetail } from "../notify/render.js";

// `isTerminated` used to live here; re-exported for API stability.
export { isTerminated };

/**
 * Map of approval gate name → enabled. Gate names are arbitrary strings
 * declared in YAML (`phase.approval_gate`, `phase.loop.approval_gate`); a
 * gate pauses only if the corresponding key is `true` here.
 */
export type ApprovalGateConfig = Record<string, boolean>;

export interface PhaseResult {
  phase: string;
  success: boolean;
  output: string;
  error?: string;
}

export interface RunnerCallbacks {
  onPhaseStart?: (phase: string) => Promise<void>;
  onPhaseEnd?: (phase: string, result: PhaseResult) => Promise<void>;
  postComment?: (body: string) => Promise<void>;
  /**
   * In-place "task list" progress surface. When set (workflows that opt in via
   * `status_checklist: true`), the runner drives this instead of posting a new
   * comment per phase. When unset, the runner falls back to `postComment`.
   */
  reporter?: ProgressReporter;
  /**
   * Fires once the workflow_runs row is known. Used by the Slack dispatch path
   * to post the "Starting <skill>" reply with a deep link to the run.
   */
  onRunStart?: (runId: string) => Promise<void>;
}

export interface WorkflowResult {
  success: boolean;
  phases: PhaseResult[];
  prNumber?: number;
  paused?: boolean;
}

export function gitAccessProfileForWorkflow(workflowName: string): GitAccessProfile {
  switch (workflowName) {
    case "build":
    case "pr-fix":
      return "repo-write";
    case "pr-review":
      return "review-write";
    case "issue-triage":
    case "issue-comment":
    case "pr-comment":
    case "explore":
    case "security-review":
      return "issues-write";
    case "security-feedback":
      return "repo-write";
    default:
      return "read";
  }
}

export function gitSandboxAccessForWorkflow(
  workflowName: string,
  owner: string,
  repo: string,
  prePopulateBranch?: string,
  runId?: string,
): GitSandboxAccess {
  const profile = gitAccessProfileForWorkflow(workflowName);
  return {
    owner,
    repo,
    profile,
    // Never forward the App PEM into sandboxes. The harness already mints a
    // profile-scoped token and forwards it as GITHUB_TOKEN, so the agent gets
    // github tools in static-token mode without the App private key ever
    // entering the sandbox.
    allowMcpAppAuth: false,
    prePopulateBranch,
    runId,
    // Read-only workflows never need git history — clone at --depth 1. Only
    // the code-pushing profiles (build / pr-fix / security-feedback) keep the
    // deeper clone for rebase/amend headroom.
    shallow: profile !== "repo-write",
  };
}

// ── Unified workflow scheduler ───────────────────────────────────────────────

/**
 * Run an agent workflow defined by a YAML definition.
 *
 * Every workflow executes as a DAG: workflows that declare no `depends_on`
 * are run as a synthesized chain (each phase depends on the one before it),
 * reproducing the old linear semantics including the failure cascade. Ready
 * nodes are executed **one at a time in declaration order** (sequential).
 * Each node's body — context / standard agent / reviewer-loop / generic-loop,
 * plus approval and reply gates — lives in {@link PhaseExecutor}; the
 * scheduler here owns the DAG, the `phases[]`/`outputs{}` accumulation, and
 * the in-memory node status.
 */
export async function runWorkflow(
  definition: AgentWorkflowDefinition,
  ctx: TemplateContext,
  config: ExecutorConfig,
  callbacks: RunnerCallbacks,
  db?: StateDb,
  models?: ModelConfig,
  approvalConfig?: ApprovalGateConfig,
  workflowId?: string,
  variants?: VariantConfig,
): Promise<WorkflowResult> {
  const phases: PhaseResult[] = [];
  const outputs: Record<string, unknown> = {};
  const { taskId } = ctx;
  // Slack-originated runs carry an explicit `slack:` trigger id — everything
  // else (GitHub webhook, CLI) uses the legacy owner/repo#N shape.
  const triggerId = (ctx.triggerIdOverride as string | undefined)
    || `${ctx.owner}/${ctx.repo}#${ctx.issueNumber}`;

  // Load scratch state from the workflow run so generic loops can resume
  // iteration at the right index and templates can read {{scratch.*}}.
  const scratch: Record<string, unknown> = ctx.scratch
    ? { ...(ctx.scratch as Record<string, unknown>) }
    : (db && workflowId ? { ...(db.runs.getRun(workflowId)?.scratch ?? {}) } : {});
  ctx.scratch = scratch;

  const prePopulateBranch = typeof ctx.prePopulateBranch === "string"
    ? ctx.prePopulateBranch
    : undefined;
  const githubAccess = gitSandboxAccessForWorkflow(definition.name, ctx.owner, ctx.repo, prePopulateBranch, workflowId);
  const notify = callbacks.postComment || (async () => {});
  const reporter = callbacks.reporter;
  const onStart = callbacks.onPhaseStart || (async () => {});
  const onEnd = callbacks.onPhaseEnd || (async () => {});

  // Terminal step key — dynamic loop steps (re-review / fix cycles) are
  // inserted just above it so the checklist reads top-to-bottom in run order.
  const lastPhaseKey = [...definition.phases]
    .reverse()
    .find((p) => (p.type ?? "agent") !== "context")?.name;

  const modelFor = (taskType: string): string | undefined =>
    models ? resolveModel(models, taskType) : undefined;
  const variantFor = (taskType: string): string | undefined =>
    variants ? resolveVariant(variants, taskType) : undefined;

  /** Render a prompt template with current context + outputs. */
  const renderPrompt = (promptPath: string, extraCtx?: Partial<TemplateContext>): string => {
    const template = loadPromptTemplate(promptPath);
    return renderTemplate(template, { ...ctx, phaseOutputs: outputs, ...(extraCtx || {}) });
  };

  /**
   * Render a YAML message template and post it as a *standalone* message.
   * Routes through `reporter.note()` when the in-place checklist is active,
   * else the legacy `postComment`.
   */
  const notifyMessage = async (
    template: string | undefined,
    extraCtx?: Partial<TemplateContext>,
  ): Promise<void> => {
    if (!template) return;
    const rendered = renderTemplate(template, { ...ctx, phaseOutputs: outputs, ...(extraCtx || {}) });
    if (!rendered.trim()) return;
    if (reporter) await reporter.note(rendered);
    else await notify(rendered);
  };

  /** Post a pre-rendered standalone message (already-built string). */
  const postNote = async (text: string): Promise<void> => {
    if (!text.trim()) return;
    if (reporter) await reporter.note(text);
    else await notify(text);
  };

  /** Transition a checklist step (and optionally render a YAML message detail). */
  const reportStep = async (
    key: string,
    status: StepStatus,
    template?: string,
    extraCtx?: Partial<TemplateContext>,
    opts?: ReportStepOpts,
  ): Promise<void> => {
    const rendered = template
      ? renderTemplate(template, { ...ctx, phaseOutputs: outputs, ...(extraCtx || {}) }).trim()
      : "";
    if (reporter) {
      const detail = collapseDetail(rendered);
      if (opts?.insert) {
        const step: ProgressStep = { key, label: opts.label ?? key, status, detail };
        await reporter.insertStep(step, opts.insertBefore ?? lastPhaseKey);
      } else {
        await reporter.step(key, status, detail);
      }
      if (opts?.alsoNote && rendered) await reporter.note(rendered);
    } else if (rendered) {
      await notify(rendered);
    }
  };

  /** Persist a phase transition to the DB workflow run. */
  const persistPhase = (phase: string, summary?: string) => {
    if (db && workflowId) {
      const entry: PhaseHistoryEntry = {
        phase,
        timestamp: new Date().toISOString(),
        success: true,
        summary,
      };
      db.runs.appendPhase(workflowId, phase, entry);
    }
  };

  /** Mark the workflow run as failed. */
  const failWorkflow = (errorMsg?: string) => {
    if (db && workflowId) {
      db.runs.finishRun(workflowId, "failed", { error: errorMsg });
    }
  };

  /** Should an approval gate with this name actually pause the workflow? */
  const gateEnabled = (gateName: string | undefined): boolean =>
    !!gateName && approvalConfig?.[gateName] === true;

  // ── Collaborators ───────────────────────────────────────────────────────────

  const runScope: PhaseRunContext = {
    definition,
    ctx,
    config,
    taskId,
    triggerId,
    githubAccess,
    scratch,
    db,
    workflowId,
  };
  const phaseReporter: PhaseReporter = {
    onStart,
    onEnd,
    step: reportStep,
    message: notifyMessage,
    postNote,
    persistPhase,
    failWorkflow,
  };
  const phaseResolver: PhaseResolver = {
    modelFor,
    variantFor,
    renderPrompt,
    gateEnabled,
  };
  const executor = new PhaseExecutor(runScope, phaseReporter, phaseResolver);

  // ── Schedule ─────────────────────────────────────────────────────────────────

  const dag = buildDag(definition.phases, { chainIfNoDeps: true });

  while (!isComplete(dag)) {
    // Honour a cancel that landed during the previous phase's execution.
    if (db && workflowId) {
      const latest = db.runs.getRun(workflowId);
      if (latest?.status === "cancelled") {
        console.log(`[runner] ${definition.name} cancelled — stopping`);
        return { success: false, phases };
      }
    }

    // Skip nodes whose trigger rule fails (deps terminal, rule unsatisfied).
    // This is how a failure cascades to the end of a chain as skips. Skips are
    // recorded in the executions ledger — the single source of truth the
    // dashboard derives phase status from.
    const toSkip = getNodesToSkip(dag);
    for (const node of toSkip) {
      node.status = "skipped";
      phases.push({ phase: node.name, success: true, output: "Skipped (trigger rule not satisfied)" });
      db?.executions.recordSkippedPhase(
        `${definition.name}:${node.name}`,
        triggerId,
        workflowId,
        githubAccess.repo,
      );
      await reportStep(node.name, "skipped");
    }

    const ready = getReadyNodes(dag);
    if (ready.length === 0) {
      if (toSkip.length === 0) break; // stuck (shouldn't happen in a valid DAG)
      continue; // only had skips — loop to process downstream
    }

    // Sequential: run the earliest-declared ready node, one at a time.
    // Resume is ledger-driven: a completed phase's `runPhase` call returns
    // skipped:done via `shouldRunPhase`, so re-running from the top is safe.
    const node = ready[0];
    node.status = "running";

    let outcome;
    try {
      outcome = await executor.execute(node, outputs);
    } catch (err) {
      // An agent call threw (OOM / unexpected). Mark the node failed so the
      // failure cascades to downstream skips, mirroring a normal failure.
      console.error(`[runner] Phase "${node.name}" threw unexpectedly:`, err);
      phases.push({ phase: node.name, success: false, error: String(err), output: "" });
      node.status = "failed";
      continue;
    }
    for (const r of outcome.results) phases.push(r);
    if (outcome.outputVars) Object.assign(outputs, outcome.outputVars);

    if (outcome.aborted) {
      // Dedup running-skip — another instance owns this phase. Stop without
      // cascading skips; this isn't a phase failure.
      return { success: false, phases };
    }
    if (outcome.paused) {
      return { success: true, phases, paused: true };
    }
    node.status = outcome.status;
  }

  // ── Workflow wrap-up ──────────────────────────────────────────────────────
  //
  // If the definition declares an `on_success.set_phase` terminal marker on any
  // phase, record it so the DB row shows the workflow as fully complete. Also
  // opportunistically extract a PR number from the terminal phase's output.
  const anyFailed = phases.some((p) => !p.success);
  const success = !anyFailed;

  let prNumber: number | undefined;
  let prUrl: string | undefined;
  const terminalPhase = [...definition.phases].reverse().find((p) => p.on_success?.set_phase);
  if (terminalPhase) {
    const terminalResult = phases.find((p) => p.phase === terminalPhase.name);
    const prMatch = terminalResult?.output?.match(/#(\d+)/);
    if (prMatch) prNumber = parseInt(prMatch[1], 10);
    const urlMatch = terminalResult?.output?.match(/https?:\/\/[^\s)]+\/pull\/\d+/);
    if (urlMatch) prUrl = urlMatch[0];
  }

  if (success) {
    if (db && workflowId) {
      // Fold the `on_success.set_phase` terminal marker into the same
      // transaction as the status flip so the dashboard never sees one
      // without the other.
      const terminalMarker = terminalPhase?.on_success?.set_phase
        ? { phase: terminalPhase.on_success.set_phase, summary: prNumber ? `PR #${prNumber}` : undefined }
        : undefined;
      db.runs.finishRun(workflowId, "succeeded", terminalMarker ? { terminalMarker } : {});
    }
  } else {
    const firstFailure = phases.find((p) => !p.success);
    failWorkflow(firstFailure?.error || "workflow failed");
  }

  if (reporter) {
    if (success && prNumber && terminalPhase) {
      const link = prUrl ? `[PR #${prNumber}](${prUrl})` : `PR #${prNumber}`;
      await reporter.step(terminalPhase.name, "done", link);
    }
    const prSuffix = prNumber ? ` — PR #${prNumber}` : "";
    await reporter.noteTerminal(
      success
        ? `✅ **${definition.name} complete**${prSuffix}.`
        : `❌ **${definition.name} failed** — see the checklist above for the failing step.`,
    );
  }

  return { success, phases, prNumber };
}
