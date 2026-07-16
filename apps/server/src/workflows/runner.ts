import type {
  ExecutorConfig,
  GitAccessProfile,
  GitSandboxAccess,
} from "../engine/github/profiles.js";
import type { StateDb } from "../state/db.js";
import type { PhaseHistoryEntry } from "../state/db.js";
import type { ModelConfig, VariantConfig } from "../config/config.js";
import { resolveModel, resolveVariant, getBotName } from "../config/config.js";
import type { AgentWorkflowDefinition } from "./schema.js";
import { loadPromptTemplate, resolveSkillPaths } from "./loader.js";
import { renderTemplate, type TemplateContext } from "./templates.js";
import { PER_TARGET_RECREATE_WORKFLOWS } from "./target-policy.js";
import { qaImageAvailable, SANDBOX_IMAGE_QA } from "../sandbox/images.js";
import { executeAgent, executeCommand } from "../engine/agent-executor.js";
import { listRunningContainers } from "../admin/docker.js";
import { withSpan, recordExecutionMetrics, recordError } from "../telemetry/index.js";
import { isTerminated, type PhaseRunContext } from "./phase-executor.js";
import { runWorkflowCore } from "@lastlight/workflow-engine";
import type {
  EnginePorts,
  EngineSpan,
  ObservabilityPort,
  PhaseReporter,
  PhaseResolver,
  PhaseResult,
  ReportStepOpts,
  StepStatus,
  ProgressStep,
  WorkflowResult,
} from "@lastlight/workflow-engine";
import { makePostReviewHandler } from "./handlers/post-review.js";
import { fileVerdictReader } from "./handlers/verdict-reader.js";
import type { ProgressReporter } from "../notify/types.js";
import { collapseDetail } from "../notify/render.js";

// `isTerminated` used to live here; re-exported for API stability.
export { isTerminated };
export type { PhaseResult, WorkflowResult };

/**
 * Map of approval gate name → enabled. Gate names are arbitrary strings
 * declared in YAML (`phase.approval_gate`, `phase.loop.approval_gate`); a
 * gate pauses only if the corresponding key is `true` here.
 */
export type ApprovalGateConfig = Record<string, boolean>;

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
  /**
   * Public base URL of the admin dashboard (`config.publicUrl`). When set, the
   * progress checklist embeds a live-run deep link in its meta. Undefined when
   * no public URL is configured (the link is simply omitted).
   */
  publicUrl?: string;
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
    case "answer":
    case "security-review":
    // verify / qa-test / demo read the repo and post a findings/demo comment —
    // they never push code, so issues-write (contents:read + issues:write) is
    // enough.
    case "verify":
    case "qa-test":
    case "demo":
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
    // `build` recreates its workspace from the default branch on a fresh run
    // (issue #153) rather than refreshing a possibly-stale feature branch.
    recreateFromBase: PER_TARGET_RECREATE_WORKFLOWS.has(workflowName),
  };
}

// ── Default engine ports (app adapters) ──────────────────────────────────────
//
// Thin delegations to the real app functions; injected into the engine so the
// core stays domain-agnostic. Built once at module load (they hold no run
// state) except the post-review handler, which is per-run.

const defaultAgentPort: EnginePorts["agent"] = {
  runAgent: (prompt, config, opts) => executeAgent(prompt, config, opts),
  runCommand: (spec, config, opts) => executeCommand(spec, config, opts),
};

const defaultAssetLoader: EnginePorts["assets"] = {
  loadPromptTemplate: (relativePath) => loadPromptTemplate(relativePath),
  resolveSkillPaths: (names) => resolveSkillPaths(names),
};

const dockerLivenessPort: EnginePorts["liveness"] = {
  isPhaseContainerAlive: async (taskId) => {
    const containers = await listRunningContainers();
    return containers.some((c) => c.taskId === taskId);
  },
};

// The engine types the span opaquely (EngineSpan: addEvent/setAttributes) so it
// never pulls in @opentelemetry; the real OTEL `Span` satisfies that shape at
// runtime — the cast bridges the structural-vs-nominal gap while preserving T.
function obsWithSpan<T>(
  name: string,
  attrs: Record<string, unknown>,
  fn: (span?: EngineSpan) => Promise<T> | T,
): Promise<T> {
  return withSpan<T>(name, attrs, fn as (span: unknown) => Promise<T> | T);
}
const telemetryObservability: ObservabilityPort = {
  withSpan: obsWithSpan,
  recordExecutionMetrics: (surface, attrs) =>
    recordExecutionMetrics(surface as "workflow" | "phase" | "agent" | "chat", attrs),
  recordError: (surface, error, attrs) => recordError(surface, error, attrs),
};

// ── Unified workflow scheduler (composition root) ────────────────────────────

/**
 * Run an agent workflow defined by a YAML definition. This is the frozen
 * `lastlight/evals` surface — the 9-arg signature is byte-stable. It builds the
 * default engine ports, the reporter/resolver collaborators, and the run-scoped
 * {@link PhaseRunContext}, then delegates the DAG walk to `runWorkflowCore`.
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

  /**
   * Render a YAML message template and post it as an interactive approval
   * prompt — Approve/Reject buttons on rich surfaces (Slack), plain text on the
   * legacy `notify` path or a surface without buttons (GitHub).
   */
  const approvalNote = async (
    template: string | undefined,
    extraCtx: Partial<TemplateContext>,
    meta: { workflowRunId: string },
  ): Promise<void> => {
    if (!template) return;
    const rendered = renderTemplate(template, { ...ctx, phaseOutputs: outputs, ...(extraCtx || {}) });
    if (!rendered.trim()) return;
    if (reporter) await reporter.noteApproval(rendered, meta);
    else await notify(rendered);
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

  /** Fold a workflow's final synthesized result into the checklist footer. */
  const footer = async (markdown: string): Promise<void> => {
    if (reporter) await reporter.footer(markdown);
    else await notify(markdown);
  };

  /** Post the run's completion ping — terminal-ping surfaces (Slack) only. */
  const noteTerminal = async (markdown: string): Promise<void> => {
    if (reporter) await reporter.noteTerminal(markdown);
  };

  // ── Collaborators ───────────────────────────────────────────────────────────

  const runScope: PhaseRunContext = {
    definition,
    ctx,
    config,
    taskId,
    triggerId,
    githubAccess,
    scratch,
    store: db,
    workflowId,
    botName: getBotName(),
  };
  const phaseReporter: PhaseReporter = {
    onStart,
    onEnd,
    step: reportStep,
    message: notifyMessage,
    approvalNote,
    postNote,
    persistPhase,
    failWorkflow,
    footer,
    noteTerminal,
  };
  const phaseResolver: PhaseResolver = {
    modelFor,
    variantFor,
    renderPrompt,
    gateEnabled,
  };

  const ports: EnginePorts = {
    agent: defaultAgentPort,
    assets: defaultAssetLoader,
    liveness: dockerLivenessPort,
    observability: telemetryObservability,
    verdictReader: fileVerdictReader,
    handlers: new Map([
      ["post-review", makePostReviewHandler({ ctx, config, taskId, store: db, workflowId }, phaseReporter)],
    ]),
  };

  return runWorkflowCore(runScope, {
    reporter: phaseReporter,
    resolver: phaseResolver,
    ports,
    store: db,
    reporterActive: !!reporter,
    capabilities: { qaImageAvailable, qaImageName: SANDBOX_IMAGE_QA },
  }, outputs);
}
