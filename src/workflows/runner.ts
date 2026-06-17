import { randomUUID } from "crypto";
import { execSync } from "child_process";
import type {
  ExecutorConfig,
  ExecutionResult,
  GitAccessProfile,
  GitSandboxAccess,
} from "../engine/profiles.js";
import { executeAgent } from "../engine/agent-executor.js";
import type { StateDb } from "../state/db.js";
import type { PhaseHistoryEntry } from "../state/db.js";
import type { ModelConfig, VariantConfig } from "../config.js";
import { resolveModel, resolveVariant } from "../config.js";
import { listRunningContainers } from "../admin/docker.js";
import type { AgentWorkflowDefinition, PhaseDefinition } from "./schema.js";
import { phaseSkillNames } from "./schema.js";
import { loadPromptTemplate, resolveSkillPaths } from "./loader.js";
import { renderTemplate, type TemplateContext } from "./templates.js";
import { evalUntilExpression } from "./loop-eval.js";
import { buildDag, getReadyNodes, getNodesToSkip, isComplete } from "./dag.js";
import type { ProgressReporter, StepStatus, ProgressStep } from "../notify/types.js";
import { recordError, recordExecutionMetrics, withSpan } from "../telemetry/index.js";
import { collapseDetail } from "../notify/render.js";

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
 * and `skill:`/`skills:` (skill references) phase definitions, including
 * phases that declare both.
 *
 * Skill content is not embedded in the prompt — instead, the named skills
 * are staged at `<workspace>/.agents/skills/<name>/` by the executor (see
 * `phaseConfigFor` → `ExecutorConfig.skillPaths` → agent-executor's
 * staging step), and pi-coding-agent's built-in auto-discovery surfaces
 * them in the system prompt as an XML catalogue. The agent reads the
 * full SKILL.md via its `read` tool on demand.
 *
 * Resolution order:
 *   1. `prompt:` set — render the template as the user prompt. If
 *      `skills:` is also set, the staged catalogue is available; the
 *      template can reference skills by name (the staging happens
 *      regardless of which branch this function takes).
 *   2. `skills:` only — emit a short auto-generated nudge that points
 *      the agent at the primary skill and lists the rest.
 *   3. Neither — throw.
 */
function buildPhasePrompt(
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
    // The staged skill is listed in pi-coding-agent's `<available_skills>`
    // system-prompt catalogue, and the agent loads SKILL.md on demand —
    // so we only name the primary skill and pass context. No need to
    // spell out the file path; that just burns a tool call telling the
    // agent to do what its progressive-disclosure loop already does.
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
 * Overlay per-phase executor config fields that live on the YAML phase
 * itself (not on the runner-level config or env): `unrestricted_egress`,
 * `web_search`, and the resolved skill directory paths derived from
 * `skill:`/`skills:`. The agent-executor then stages each skill at
 * `<workspace>/.agents/skills/<name>/` for pi-coding-agent's
 * auto-discovery to find.
 *
 * All callers route through here, so loop fix/re-review cycles inherit
 * the parent phase's skills automatically.
 */
function phaseConfigFor(config: ExecutorConfig, phase: PhaseDefinition): ExecutorConfig {
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
   * comment per phase — phase transitions become checklist step updates and the
   * `messages.on_*` strings become each step's one-line detail. When unset, the
   * runner falls back to `postComment` (legacy one-comment-per-phase). See
   * `src/notify/`.
   */
  reporter?: ProgressReporter;
  /**
   * Fires once the workflow_runs row is known — either freshly created or
   * reused from a running/paused trigger. Used by the Slack dispatch path
   * to post the "Starting <skill>" reply with a deep link to the run.
   * Fire-and-forget: the workflow does not await this, so failures only log.
   */
  onRunStart?: (runId: string) => Promise<void>;
}

export interface WorkflowResult {
  success: boolean;
  phases: PhaseResult[];
  prNumber?: number;
  paused?: boolean;
}

// ── Phase-level deduplication ────────────────────────────────────────────────

/**
 * Check if a sandbox container is actually running for a given taskId prefix.
 */
async function isContainerAlive(taskId: string): Promise<boolean> {
  try {
    const containers = await listRunningContainers();
    return containers.some((c) => c.taskId === taskId);
  } catch {
    return false;
  }
}

/**
 * Check if an error was caused by manual termination.
 */
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
): GitSandboxAccess {
  const profile = gitAccessProfileForWorkflow(workflowName);
  return {
    owner,
    repo,
    profile,
    // Never forward the App PEM into sandboxes. agentic-pi's github extension
    // prioritizes App auth whenever GITHUB_APP_* are all present and *skips
    // entirely* (status: pem-unreadable) when the PEM isn't readable in the
    // sandbox — which it never is (ALLOW_APP_PEM is not wired up, so the
    // sandbox-side PEM copy is never materialized). It does NOT fall back to
    // the minted GITHUB_TOKEN. The harness already mints a profile-scoped
    // token and forwards it as GITHUB_TOKEN, so the agent gets github tools in
    // static-token mode without the App private key ever entering the sandbox.
    allowMcpAppAuth: false,
    prePopulateBranch,
  };
}

/**
 * Run a single agent phase with DB-tracked deduplication.
 */
async function runPhase(
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
): Promise<
  | { result: ExecutionResult; executionId: string; skipped: false }
  | { result: ExecutionResult; skipped: false }
  | { skipped: true; reason: "running" | "done" }
> {
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
      const status = db.shouldRunPhase(dedupKey, triggerId, workflowRunId);

      if (status === "running") {
        const alive = await isContainerAlive(taskId);
        if (alive) {
          console.log(`[runner] Phase ${phaseName} is already running (container alive) — skipping`);
          span?.addEvent("lastlight.workflow.phase.skipped", { reason: "running" });
          return { skipped: true, reason: "running" };
        }
        console.log(`[runner] Phase ${phaseName} was running but container is dead — cleaning up`);
        db.markStaleAsFailed(dedupKey, triggerId, workflowRunId);
      } else if (status === "done") {
        console.log(`[runner] Phase ${phaseName} already completed successfully — skipping`);
        span?.addEvent("lastlight.workflow.phase.skipped", { reason: "done" });
        return { skipped: true, reason: "done" };
      }

      const executionId = randomUUID();
      db.recordStart({
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
          // Persist the session id as soon as it arrives so the dashboard can
          // show live agent logs for an in-flight phase, not just completed ones.
          onSessionId: (sessionId) => {
            try {
              db.recordSessionId(executionId, sessionId);
            } catch (err) {
              console.warn(`[runner] Failed to persist session id mid-run for ${phaseName}:`, err);
            }
          },
        });

        db.recordFinish(executionId, {
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

// ── Resume logic ─────────────────────────────────────────────────────────────

/**
 * Resolve a recorded phase name to its index in `definition.phases`.
 * Handles the generated iteration labels the runner writes for looping phases:
 *
 *   `${phase}_iter_${n}` — generic_loop iteration
 *   `${phase}_fix_${n}`  — reviewer-style loop fix cycle
 *   `${phase}_${n}`      — reviewer-style loop re-review cycle
 *
 * Returns -1 when the name doesn't match any phase (unknown/untracked labels
 * like `waiting_approval` or user set_phase values such as `complete`).
 */
export function phaseIndexInDefinition(
  definition: AgentWorkflowDefinition,
  name: string,
): number {
  const exact = definition.phases.findIndex((p) => p.name === name);
  if (exact >= 0) return exact;

  const tryStrip = (re: RegExp): number => {
    const m = name.match(re);
    if (!m) return -1;
    return definition.phases.findIndex((p) => p.name === m[1]);
  };

  const iterIdx = tryStrip(/^(.*)_iter_\d+$/);
  if (iterIdx >= 0) return iterIdx;
  const fixIdx = tryStrip(/^(.*)_fix_\d+$/);
  if (fixIdx >= 0) return fixIdx;
  const cycleIdx = tryStrip(/^(.*)_\d+$/);
  if (cycleIdx >= 0) return cycleIdx;

  return -1;
}

/**
 * Given the phase the runner last completed, return the name of the phase the
 * runner should run next. Returns `null` when there is no next phase (i.e. the
 * workflow is done).
 */
export function nextPhaseAfter(
  definition: AgentWorkflowDefinition,
  completedPhase: string,
): string | null {
  const idx = phaseIndexInDefinition(definition, completedPhase);
  if (idx < 0 || idx >= definition.phases.length - 1) return null;
  return definition.phases[idx + 1].name;
}

// ── Main workflow runner ─────────────────────────────────────────────────────

/** Returns true if any phase declares explicit dependencies — triggers DAG execution path. */
function hasDependencies(definition: AgentWorkflowDefinition): boolean {
  return definition.phases.some((p) => p.depends_on && p.depends_on.length > 0);
}

/**
 * Run an agent workflow defined by a YAML definition.
 * Interprets phases, approval gates, and loops generically — the runner has
 * no knowledge of specific phase names.
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
  const phaseOutputs: Record<string, unknown> = {};
  const { taskId } = ctx;
  // Slack-originated runs carry an explicit `slack:` trigger id — everything
  // else (GitHub webhook, CLI) uses the legacy owner/repo#N shape.
  const triggerId = (ctx.triggerIdOverride as string | undefined)
    || `${ctx.owner}/${ctx.repo}#${ctx.issueNumber}`;

  // Load scratch state from the workflow run so generic loops can resume
  // iteration at the right index and templates can read {{scratch.*}}.
  const scratch: Record<string, unknown> = ctx.scratch
    ? { ...(ctx.scratch as Record<string, unknown>) }
    : (db && workflowId ? { ...(db.getWorkflowRun(workflowId)?.scratch ?? {}) } : {});
  ctx.scratch = scratch;
  // `prePopulateBranch` is set upstream (in src/index.ts dispatch) for
  // workflows that operate on an existing branch (pr-review, pr-fix). The
  // executor uses it to clone that branch into the workspace before the
  // sandbox starts — agent enters a workspace already checked out.
  const prePopulateBranch = typeof ctx.prePopulateBranch === "string"
    ? ctx.prePopulateBranch
    : undefined;
  const githubAccess = gitSandboxAccessForWorkflow(definition.name, ctx.owner, ctx.repo, prePopulateBranch);
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

  /** Render a prompt template with current context. */
  const renderPrompt = (promptPath: string, extraCtx?: Partial<TemplateContext>): string => {
    const template = loadPromptTemplate(promptPath);
    return renderTemplate(template, { ...ctx, phaseOutputs, ...(extraCtx || {}) });
  };

  /**
   * Render a YAML message template and post it as a *standalone* message — a
   * new GitHub comment / Slack message. Used for genuine notes (approval
   * prompts, reply-gate questions, abort notices). When the in-place checklist
   * is active it routes through `reporter.note()` (a real ping); otherwise it
   * falls back to the legacy `postComment`.
   */
  const notifyMessage = async (
    template: string | undefined,
    extraCtx?: Partial<TemplateContext>,
  ): Promise<void> => {
    if (!template) return;
    const rendered = renderTemplate(template, { ...ctx, phaseOutputs, ...(extraCtx || {}) });
    if (!rendered.trim()) return;
    if (reporter) await reporter.note(rendered);
    else await notify(rendered);
  };

  /** Post a pre-rendered standalone message (already-built string, no template). */
  const postNote = async (text: string): Promise<void> => {
    if (!text.trim()) return;
    if (reporter) await reporter.note(text);
    else await notify(text);
  };

  /**
   * Transition a checklist step (and optionally render a YAML message as its
   * one-line detail). When no reporter is wired this falls back to posting the
   * full rendered message as a legacy comment, so opted-out workflows behave
   * exactly as before. `insert` adds a dynamic step (loop iterations); `note`
   * additionally posts the full message as a standalone ping (approval gates).
   */
  const reportStep = async (
    key: string,
    status: StepStatus,
    template?: string,
    extraCtx?: Partial<TemplateContext>,
    opts?: { label?: string; insertBefore?: string; insert?: boolean; alsoNote?: boolean },
  ): Promise<void> => {
    const rendered = template
      ? renderTemplate(template, { ...ctx, phaseOutputs, ...(extraCtx || {}) }).trim()
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
      db.updateWorkflowPhase(workflowId, phase, entry);
    }
  };

  /** Mark the workflow run as failed. */
  const failWorkflow = (errorMsg?: string) => {
    if (db && workflowId) {
      db.finishWorkflowRun(workflowId, "failed", errorMsg);
    }
  };

  // Determine resume point from the DB row's currentPhase. If the row doesn't
  // exist (no DB), default to running everything from the first phase.
  //
  // `currentPhase` is initialized to `phases[0].name` at row creation, so on a
  // fresh run it points at the first phase even though nothing has run yet.
  // We can only treat it as "last completed" once phase_history has at least
  // one entry (persistPhase only fires when a phase completes successfully).
  let resumeFromIdx = 0;
  if (db && workflowId) {
    const run = db.getWorkflowRun(workflowId);
    if (run?.currentPhase && run.phaseHistory && run.phaseHistory.length > 0) {
      const next = nextPhaseAfter(definition, run.currentPhase);
      if (next) {
        const idx = phaseIndexInDefinition(definition, next);
        if (idx >= 0) resumeFromIdx = idx;
      }
    }
  }

  const shouldRun = (phaseName: string): boolean => {
    const idx = phaseIndexInDefinition(definition, phaseName);
    // Unknown phases always run — they're not tracked in the definition order.
    if (idx === -1) return true;
    return idx >= resumeFromIdx;
  };

  /** Should an approval gate with this name actually pause the workflow? */
  const gateEnabled = (gateName: string | undefined): boolean =>
    !!gateName && approvalConfig?.[gateName] === true;

  // ── Execute phases ────────────────────────────────────────────────────────

  if (hasDependencies(definition)) {
    return runDagWorkflow(
      definition, ctx, config, db, workflowId,
      { phases, phaseOutputs, triggerId, notify, notifyMessage, reportStep, onStart, onEnd, modelFor, variantFor, renderPrompt, persistPhase, failWorkflow, gateEnabled, githubAccess },
    );
  }

  for (const phase of definition.phases) {
    // Honour a cancel that landed during the previous phase's execution.
    // The admin /cancel endpoint both flips status to 'cancelled' and
    // kills the in-flight sandbox container; this check keeps the runner
    // from picking up the next phase after the DB flag flips.
    if (db && workflowId) {
      const latest = db.getWorkflowRun(workflowId);
      if (latest?.status === "cancelled") {
        console.log(`[runner] ${definition.name} cancelled — stopping before phase ${phase.name}`);
        return { success: false, phases };
      }
    } else {
      // Shouldn't happen for real runs (simple.ts always passes both),
      // but if a caller wires the runner without db/workflowId the run
      // becomes uncancellable — log so the misconfiguration is obvious.
      console.warn(`[runner] cancel check skipped — no db/workflowId context`);
    }

    const { name: phaseName, type: phaseType = "agent" } = phase;
    // Linear workflows share one sandbox workspace across phases via `taskId`.
    // (DAG path uses phase-scoped taskIds to avoid concurrent write races.)

    // ── Context-only phase (no agent execution) ───────────────────────────
    if (phaseType === "context") {
      if (shouldRun(phaseName)) {
        await onStart(phaseName);
        phases.push({ phase: phaseName, success: true, output: "Context assembled" });
        // Persist a phase_history entry so the dashboard pipeline marks
        // context phases as 'done' instead of leaving them stuck on
        // 'pending' — they have no execution row to derive status from.
        persistPhase(phaseName, "Context assembled");
        await onEnd(phaseName, phases[phases.length - 1]);
      }
      continue;
    }

    // ── Agent phase ───────────────────────────────────────────────────────
    if (!phase.prompt && !phase.skill) {
      console.warn(`[runner] Phase "${phaseName}" has type=agent but neither prompt: nor skill: — skipping`);
      continue;
    }

    // Check if this is a looping phase (e.g. reviewer)
    if (phase.loop) {
      const loop = phase.loop;
      const MAX_CYCLES = loop.max_cycles;
      let approved = false;
      let fixCycles = 0;

      if (!shouldRun(phaseName)) {
        // The phase was already completed — mark as approved and continue to next phase
        approved = true;
        phases.push({ phase: phaseName, success: true, output: "Already completed" });
      }

      while (!approved && fixCycles <= MAX_CYCLES) {
        const reviewLabel = fixCycles === 0 ? phaseName : `${phaseName}_${fixCycles + 1}`;

        if (!shouldRun(phaseName) && fixCycles === 0) {
          approved = true;
          break;
        }

        await onStart(reviewLabel);
        // First cycle reuses the seeded review step; re-reviews insert a new
        // "<Reviewer> (cycle N)" row just above the terminal step.
        await reportStep(
          reviewLabel,
          "running",
          loop.messages?.on_cycle_start,
          { cycle: fixCycles + 1, maxCycles: MAX_CYCLES },
          fixCycles === 0
            ? undefined
            : { insert: true, label: `${phase.label ?? phaseName} (cycle ${fixCycles + 1})` },
        );

        // Choose prompt: first cycle uses phase.prompt or phase.skill (via
        // buildPhasePrompt), subsequent cycles always use the re_review_prompt
        // template path defined in loop.on_request_changes.
        const reviewPrompt =
          fixCycles === 0
            ? buildPhasePrompt(phase, { ...ctx, phaseOutputs }, { fixCycle: fixCycles })
            : renderPrompt(loop.on_request_changes.re_review_prompt, { fixCycle: fixCycles });

        // Resolve model + variant
        const reviewModelRaw = phase.model ? renderTemplate(phase.model, ctx) : undefined;
        const reviewModel = reviewModelRaw || modelFor(phaseName);
        const reviewVariantRaw = phase.variant ? renderTemplate(phase.variant, ctx) : undefined;
        const reviewVariant = reviewVariantRaw || variantFor(phaseName);

        const rr = await runPhase(
          definition.name,
          reviewLabel,
          taskId,
          triggerId,
          reviewPrompt,
          phaseConfigFor(config, phase),
          db,
          reviewModel,
          workflowId,
          githubAccess,
          reviewVariant,
        );

        if (rr.skipped) {
          if (rr.reason === "running") {
            await notifyMessage(phase.messages?.on_skipped_done);
            return { success: false, phases };
          }
          approved = true;
          phases.push({ phase: reviewLabel, success: true, output: "Already completed" });
          break;
        }

        phases.push({ phase: reviewLabel, ...pickResult(rr.result) });
        await onEnd(reviewLabel, phases[phases.length - 1]);

        // Parse verdict
        const reviewerOutput = (rr.result.output || "").trim();
        const verdictMarker = reviewerOutput.match(
          /^\s*VERDICT:\s*(APPROVED|REQUEST_CHANGES)\s*$/im,
        );
        let isApproved: boolean;
        if (verdictMarker) {
          isApproved = verdictMarker[1].toUpperCase() === "APPROVED";
        } else {
          const upper = reviewerOutput.toUpperCase();
          const hasRequestChanges = /\bREQUEST_CHANGES\b/.test(upper);
          isApproved = !hasRequestChanges && /^APPROVED\b/.test(upper);
          console.warn(
            `[runner] Reviewer output missing VERDICT: marker — using fallback detection (isApproved=${isApproved})`,
          );
        }

        if (isApproved) {
          approved = true;
          persistPhase(reviewLabel, "APPROVED");
          await reportStep(reviewLabel, "done", loop.messages?.on_approved, { cycle: fixCycles + 1 });
        } else if (fixCycles < MAX_CYCLES) {
          fixCycles++;
          persistPhase(reviewLabel, "REQUEST_CHANGES");

          // Approval gate before fix loop
          const gateKey = loop.approval_gate;
          if (gateEnabled(gateKey) && db && workflowId) {
            const approvalId = randomUUID();
            db.createApproval({
              id: approvalId,
              workflowRunId: workflowId,
              gate: gateKey!,
              summary: `Reviewer requested changes (cycle ${fixCycles}/${MAX_CYCLES}) on phase ${phaseName}.`,
              requestedBy: ctx.sender,
              createdAt: new Date().toISOString(),
            });
            db.updateWorkflowPhase(workflowId, "waiting_approval", {
              phase: "waiting_approval",
              timestamp: new Date().toISOString(),
              success: true,
              summary: `Waiting for approval: ${gateKey} (${approvalId})`,
            });
            db.pauseWorkflowRun(workflowId);
            // Mark the review row as awaiting and post a real ping — approval
            // is an actionable moment, so unlike normal phase transitions it
            // gets a standalone message rather than only an in-place edit.
            await reportStep(
              reviewLabel,
              "awaiting",
              loop.messages?.on_pause_for_approval,
              { cycle: fixCycles, maxCycles: MAX_CYCLES, gateKey },
              { alsoNote: true },
            );
            return { success: true, phases, paused: true };
          }

          await reportStep(reviewLabel, "done", loop.messages?.on_request_changes, {
            cycle: fixCycles,
            maxCycles: MAX_CYCLES,
          });

          // Run fix phase
          const fixLabel = `${phaseName}_fix_${fixCycles}`;
          await onStart(fixLabel);
          await reportStep(
            fixLabel,
            "running",
            loop.messages?.on_fix_start,
            { cycle: fixCycles, maxCycles: MAX_CYCLES },
            { insert: true, label: `Fix (cycle ${fixCycles})` },
          );

          const fixModelRaw = loop.on_request_changes.fix_model
            ? renderTemplate(loop.on_request_changes.fix_model, ctx)
            : undefined;
          const fixModel = fixModelRaw || modelFor(`${phaseName}_fix`) || modelFor(phaseName);
          const fixVariantRaw = loop.on_request_changes.fix_variant
            ? renderTemplate(loop.on_request_changes.fix_variant, ctx)
            : undefined;
          const fixVariant = fixVariantRaw || variantFor(`${phaseName}_fix`) || variantFor(phaseName);

          const fixPromptRendered = renderPrompt(loop.on_request_changes.fix_prompt, {
            fixCycle: fixCycles,
          });

          const fr = await runPhase(
            definition.name,
            fixLabel,
            taskId,
            triggerId,
            fixPromptRendered,
            phaseConfigFor(config, phase),
            db,
            fixModel,
            workflowId,
            githubAccess,
            fixVariant,
          );

          if (fr.skipped) {
            if (fr.reason === "running") {
              await notifyMessage(phase.messages?.on_skipped_done);
              return { success: false, phases };
            }
            phases.push({ phase: fixLabel, success: true, output: "Already completed" });
          } else {
            phases.push({ phase: fixLabel, ...pickResult(fr.result) });
            await onEnd(fixLabel, phases[phases.length - 1]);

            if (!fr.result.success) {
              if (!isTerminated(fr.result.error)) {
                await reportStep(fixLabel, "failed", loop.messages?.on_fix_failed, {
                  cycle: fixCycles,
                  maxCycles: MAX_CYCLES,
                });
              }
              break;
            }
            persistPhase(fixLabel);
            await reportStep(fixLabel, "done");
          }
        } else {
          persistPhase(reviewLabel, "REQUEST_CHANGES — max cycles reached");
          await reportStep(reviewLabel, "blocked", loop.messages?.on_max_cycles, {
            cycle: fixCycles,
            maxCycles: MAX_CYCLES,
          }, { alsoNote: true });
          break;
        }
      }

      // Expose loop outcome as a structured phase output so downstream phases
      // can read {{phaseName.approved}} / {{phaseName.cycles}} in their prompts.
      if (phase.output_var) {
        phaseOutputs[phase.output_var] = { approved, cycles: fixCycles };
      }
      continue;
    }

    // ── Generic loop phase ────────────────────────────────────────────────
    if (phase.generic_loop) {
      const loop = phase.generic_loop;
      const MAX_ITER = loop.max_iterations;
      const MAX_PREV_OUTPUT_BYTES = 10 * 1024; // cap accumulated output at 10KB

      if (!shouldRun(phaseName)) {
        phases.push({ phase: phaseName, success: true, output: "Already completed" });
        continue;
      }

      // Reply-gate loops resume mid-flight: read the saved iteration out
      // of scratch[scratch_key] so we pick up at N+1 instead of 1 and
      // don't re-run iterations whose dedup rows are already "done".
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
      // On resume, `lastOutputExecutionId` points at an `executions` row
      // whose `output_text` column holds the previous iteration's full
      // LLM output. The legacy inline `lastOutput` string is honored too
      // so runs paused on the old code path still resume cleanly.
      let previousOutput =
        (scratchSlot.lastOutputExecutionId && db
          ? db.getExecutionOutput(scratchSlot.lastOutputExecutionId as string) ?? ""
          : (scratchSlot.lastOutput as string | undefined) ?? "");

      await reportStep(phaseName, "running");

      while (!complete && iteration < MAX_ITER) {
        iteration++;
        const iterLabel = `${phaseName}_iter_${iteration}`;

        await onStart(iterLabel);

        // Build prompt with loop context vars
        const iterCtx: Partial<TemplateContext> = {
          iteration,
          maxIterations: MAX_ITER,
          previousOutput: loop.fresh_context ? "" : previousOutput,
          phaseOutputs,
          scratch,
        };
        const prompt = buildPhasePrompt(phase, ctx, iterCtx);

        const modelRaw = phase.model ? renderTemplate(phase.model, ctx) : undefined;
        const model = modelRaw || modelFor(phaseName);
        const variantRaw = phase.variant ? renderTemplate(phase.variant, ctx) : undefined;
        const variant = variantRaw || variantFor(phaseName);

        const ir = await runPhase(
          definition.name,
          iterLabel,
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

        if (ir.skipped) {
          if (ir.reason === "running") {
            await notifyMessage(phase.messages?.on_skipped_done, { iteration });
            return { success: false, phases };
          }
          // Already done — treat as complete
          phases.push({ phase: iterLabel, success: true, output: "Already completed" });
          complete = true;
          break;
        }

        phases.push({ phase: iterLabel, ...pickResult(ir.result) });
        await onEnd(iterLabel, phases[phases.length - 1]);

        if (!ir.result.success) {
          if (!isTerminated(ir.result.error)) {
            await reportStep(phaseName, "failed", phase.messages?.on_failure, { iteration });
          }
          failWorkflow(ir.result.error);
          return { success: false, phases };
        }

        const iterOutput = ir.result.output || "";

        // Accumulate previousOutput (cap at MAX_PREV_OUTPUT_BYTES)
        if (!loop.fresh_context) {
          const combined = previousOutput ? `${previousOutput}\n${iterOutput}` : iterOutput;
          previousOutput = combined.length > MAX_PREV_OUTPUT_BYTES
            ? combined.slice(-MAX_PREV_OUTPUT_BYTES)
            : combined;
        }

        // Evaluate until expression
        let conditionMet = false;
        if (loop.until) {
          conditionMet = evalUntilExpression(loop.until, {
            output: iterOutput,
            scratch,
            ...Object.fromEntries(
              Object.entries(ctx)
                .filter(([, v]) => typeof v === "string")
                .map(([k, v]) => [k, v as string]),
            ),
          });
        }

        // Evaluate until_bash
        if (!conditionMet && loop.until_bash) {
          try {
            validateShellCommand(loop.until_bash);
            execSync(loop.until_bash, { timeout: 30_000, stdio: "pipe", cwd: config.sandboxDir ?? config.cwd });
            conditionMet = true; // exit 0
          } catch {
            conditionMet = false; // non-zero exit
          }
        }

        // Persist this iteration's output text on its execution row so
        // the resume path can resolve `lastOutputExecutionId` through the
        // DB instead of inlining the full LLM string into scratch.
        const iterExecutionId = "executionId" in ir ? ir.executionId : undefined;
        if (iterExecutionId && db) {
          db.recordOutputText(iterExecutionId, iterOutput);
        }

        if (conditionMet) {
          complete = true;
          if (scratchKey && db && workflowId) {
            const slot: Record<string, unknown> = {
              ...scratchSlot,
              iteration,
              ready: true,
            };
            if (iterExecutionId) slot.lastOutputExecutionId = iterExecutionId;
            delete slot.lastOutput;
            db.updateWorkflowRunScratch(workflowId, { [scratchKey]: slot });
            scratch[scratchKey] = slot;
          }
          persistPhase(iterLabel, `iteration ${iteration} — condition met`);
          await reportStep(phaseName, "done");
          break;
        }

        // Interactive gate between iterations
        if (loop.interactive && !complete && db && workflowId) {
          const isReply = loop.gate_kind === "reply";
          const gateMsg = loop.gate_message
            ? renderTemplate(loop.gate_message, { ...ctx, phaseOutputs, iteration, maxIterations: MAX_ITER, scratch })
            : `Loop iteration ${iteration}/${MAX_ITER} complete.`;

          // Persist iteration + pointer to the last output's execution row
          // BEFORE pausing so the resume path can pick up at N+1 instead of
          // re-running from 1.
          if (scratchKey) {
            const slot: Record<string, unknown> = {
              ...(scratch[scratchKey] as Record<string, unknown> | undefined),
              iteration,
            };
            if (iterExecutionId) slot.lastOutputExecutionId = iterExecutionId;
            delete slot.lastOutput;
            scratch[scratchKey] = slot;
            db.updateWorkflowRunScratch(workflowId, { [scratchKey]: slot });
          }

          const approvalId = randomUUID();
          db.createApproval({
            id: approvalId,
            workflowRunId: workflowId,
            gate: `${phaseName}_iter_${iteration}`,
            summary: gateMsg,
            kind: isReply ? "reply" : "approve",
            requestedBy: ctx.sender,
            createdAt: new Date().toISOString(),
          });
          db.updateWorkflowPhase(workflowId, "waiting_approval", {
            phase: "waiting_approval",
            timestamp: new Date().toISOString(),
            success: true,
            summary: `Waiting for ${isReply ? "reply" : "approval"}: ${phaseName}_iter_${iteration} (${approvalId})`,
          });
          db.pauseWorkflowRun(workflowId);
          await reportStep(phaseName, "awaiting");

          if (isReply) {
            // Combine the agent's questions + gate hint into one message
            // so it reads as a single comment on GitHub / Slack.
            const parts = [iterOutput.trim(), gateMsg.trim()].filter(Boolean);
            if (parts.length > 0) await postNote(parts.join("\n\n---\n\n"));
          } else {
            await postNote(
              `**${phaseName} iteration ${iteration}/${MAX_ITER} complete** — approval required to continue.\n\n` +
                `${gateMsg}\n\n` +
                `**To continue:** comment \`@last-light approve\`\n` +
                `**To abort:** comment \`@last-light reject [reason]\``,
            );
          }
          return { success: true, phases, paused: true };
        }

        persistPhase(iterLabel);
      }

      if (!complete) {
        await reportStep(phaseName, "failed", phase.messages?.on_failure, {
          iteration,
          maxIterations: MAX_ITER,
        });
      }

      if (phase.output_var) {
        phaseOutputs[phase.output_var] = { completed: complete, iterations: iteration };
      }
      continue;
    }

    // ── Standard (non-looping) agent phase ───────────────────────────────
    if (!shouldRun(phaseName)) continue;

    await onStart(phaseName);
    await reportStep(phaseName, "running", phase.messages?.on_start);

    // Resolve model + variant
    const modelRaw = phase.model ? renderTemplate(phase.model, ctx) : undefined;
    const model = modelRaw || modelFor(phaseName);
    const variantRaw = phase.variant ? renderTemplate(phase.variant, ctx) : undefined;
    const variant = variantRaw || variantFor(phaseName);

    const prompt = buildPhasePrompt(phase, ctx, { phaseOutputs });

    const pr = await runPhase(
      definition.name,
      phaseName,
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

    if (pr.skipped) {
      if (pr.reason === "running") {
        await notifyMessage(phase.messages?.on_skipped_done);
        return { success: false, phases };
      }
      phases.push({ phase: phaseName, success: true, output: "Already completed" });
      // Persist a phase_history entry even when the phase was deduped, so
      // the dashboard's pipeline view shows the phase as 'done' instead of
      // stuck on 'active'/pending. Without this the run looks half-finished
      // even though it succeeded.
      persistPhase(phaseName, "Already completed (deduplicated)");
      await onEnd(phaseName, { phase: phaseName, success: true, output: "Already completed" });
      await reportStep(phaseName, "done", phase.messages?.on_skipped_done);
    } else {
      phases.push({ phase: phaseName, ...pickResult(pr.result) });
      await onEnd(phaseName, phases[phases.length - 1]);

      // Record phase output (raw string) for downstream ${phaseName.output}
      // substitution and, when phase.output_var is set, under the aliased key
      // so prompts can read {{aliased}} / ${aliased.output} / {{aliased.field}}.
      const rawOutput = pr.result.output ?? "";
      phaseOutputs[phaseName] = rawOutput;
      if (phase.output_var) {
        phaseOutputs[phase.output_var] = rawOutput;
      }

      if (!pr.result.success) {
        if (!isTerminated(pr.result.error)) {
          await reportStep(phaseName, "failed", phase.messages?.on_failure);
        }
        failWorkflow(pr.result.error);
        return { success: false, phases };
      }

      // Check on_output rules
      if (phase.on_output) {
        const outputUpper = (pr.result.output?.toUpperCase() || "");

        if (phase.on_output.contains_BLOCKED && outputUpper.includes("BLOCKED")) {
          const rule = phase.on_output.contains_BLOCKED;
          const hasUnlessLabel =
            rule.unless_label && ctx.issueLabels.includes(rule.unless_label);
          const titleMatches = (() => {
            if (!rule.unless_title_matches) return false;
            if (rule.unless_title_matches.length > 200) return false;
            // Reject patterns with nested quantifiers (catastrophic backtracking risk)
            if (/[+*]\{0,\}.*[+*]/.test(rule.unless_title_matches) || /(\([^)]*[+*][^)]*\))[+*?]/.test(rule.unless_title_matches)) return false;
            try {
              return new RegExp(rule.unless_title_matches, "i").test(ctx.issueTitle || "");
            } catch {
              return false;
            }
          })();

          if (hasUnlessLabel || titleMatches) {
            // Rule bypassed — fall through to phase success path.
            await notifyMessage(rule.bypass_message || phase.messages?.on_blocked_bypassed);
          } else if (rule.action === "fail") {
            db?.markLatestAsFailed(
              `${definition.name}:${phaseName}`,
              triggerId,
              rule.message || "BLOCKED",
              workflowId,
            );
            failWorkflow(rule.message || "BLOCKED");
            const blockedTemplate = rule.message || phase.messages?.on_blocked;
            if (blockedTemplate) {
              await reportStep(phaseName, "blocked", blockedTemplate);
            }
            return { success: false, phases };
          }
        }
      }

      // Approval gate
      if (phase.approval_gate && gateEnabled(phase.approval_gate) && db && workflowId) {
        const gateKey = phase.approval_gate;
        const approvalId = randomUUID();
        db.createApproval({
          id: approvalId,
          workflowRunId: workflowId,
          gate: gateKey,
          summary: `${phaseName} complete — awaiting ${gateKey} approval.`,
          requestedBy: ctx.sender,
          createdAt: new Date().toISOString(),
        });
        db.updateWorkflowPhase(workflowId, "waiting_approval", {
          phase: "waiting_approval",
          timestamp: new Date().toISOString(),
          success: true,
          summary: `Waiting for approval: ${gateKey} (${approvalId})`,
        });
        db.pauseWorkflowRun(workflowId);
        // Awaiting human approval — show it on the checklist and post a real
        // ping (an in-place edit alone wouldn't notify the approver).
        await reportStep(phaseName, "awaiting", phase.approval_gate_message, { gateKey }, { alsoNote: true });
        return { success: true, phases, paused: true };
      }

      persistPhase(phaseName);
      await reportStep(phaseName, "done", phase.messages?.on_success);
    }
  }

  // ── Workflow wrap-up ──────────────────────────────────────────────────────
  //
  // If the definition declares an `on_success.set_phase` terminal marker on any
  // phase, record it so the DB row shows the workflow as fully complete. We
  // also try to extract a PR number from the terminal phase's output so
  // callers can surface it — purely opportunistic, no hardcoded phase names.
  const anyFailed = phases.some((p) => !p.success);
  const success = !anyFailed;

  let prNumber: number | undefined;
  let prUrl: string | undefined;
  const terminalPhase = [...definition.phases].reverse().find((p) => p.on_success?.set_phase);
  if (terminalPhase) {
    const terminalResult = phases.find((p) => p.phase === terminalPhase.name);
    const prMatch = terminalResult?.output?.match(/#(\d+)/);
    if (prMatch) prNumber = parseInt(prMatch[1], 10);
    // The PR phase outputs the PR URL; pull it out so we can link it straight
    // from the checklist instead of a separate "PR opened" comment.
    const urlMatch = terminalResult?.output?.match(/https?:\/\/[^\s)]+\/pull\/\d+/);
    if (urlMatch) prUrl = urlMatch[0];
    if (success && terminalPhase.on_success?.set_phase) {
      persistPhase(
        terminalPhase.on_success.set_phase,
        prNumber ? `PR #${prNumber}` : undefined,
      );
    }
  }

  if (success) {
    if (db && workflowId) {
      db.finishWorkflowRun(workflowId, "succeeded");
    }
  } else {
    const firstFailure = phases.find((p) => !p.success);
    failWorkflow(firstFailure?.error || "workflow failed");
  }

  if (reporter) {
    // Put the PR link in the checklist itself (on the terminal step) so the
    // list is self-contained — no separate "PR opened" comment.
    if (success && prNumber && terminalPhase) {
      const link = prUrl ? `[PR #${prNumber}](${prUrl})` : `PR #${prNumber}`;
      await reporter.step(terminalPhase.name, "done", link);
    }
    // Completion ping — only to surfaces that want one (Slack). GitHub keeps
    // just the finished checklist; the PR-opened event already notifies there.
    const prSuffix = prNumber ? ` — PR #${prNumber}` : "";
    await reporter.noteTerminal(
      success
        ? `✅ **${definition.name} complete**${prSuffix}.`
        : `❌ **${definition.name} failed** — see the checklist above for the failing step.`,
    );
  }

  return { success, phases, prNumber };
}

/** Shared runner context threaded into DAG execution (avoids re-deriving these). */
interface DagRunnerCtx {
  phases: PhaseResult[];
  phaseOutputs: Record<string, unknown>;
  triggerId: string;
  githubAccess: GitSandboxAccess;
  notify: (msg: string) => Promise<void>;
  notifyMessage: (template: string | undefined, extraCtx?: Partial<TemplateContext>) => Promise<void>;
  reportStep: (
    key: string,
    status: StepStatus,
    template?: string,
    extraCtx?: Partial<TemplateContext>,
    opts?: { label?: string; insertBefore?: string; insert?: boolean; alsoNote?: boolean },
  ) => Promise<void>;
  onStart: (phase: string) => Promise<void>;
  onEnd: (phase: string, result: PhaseResult) => Promise<void>;
  modelFor: (taskType: string) => string | undefined;
  variantFor: (taskType: string) => string | undefined;
  renderPrompt: (promptPath: string, extraCtx?: Partial<TemplateContext>) => string;
  persistPhase: (phase: string, summary?: string) => void;
  failWorkflow: (errorMsg?: string) => void;
  gateEnabled: (gateName: string | undefined) => boolean;
}

/**
 * DAG-based workflow execution. Called when any phase declares `depends_on`.
 * Runs independent phases concurrently via Promise.allSettled.
 */
async function runDagWorkflow(
  definition: AgentWorkflowDefinition,
  ctx: TemplateContext,
  config: ExecutorConfig,
  db: StateDb | undefined,
  workflowId: string | undefined,
  runnerCtx: DagRunnerCtx,
): Promise<WorkflowResult> {
  const {
    phases,
    phaseOutputs: outputs,
    triggerId,
    githubAccess,
    notifyMessage,
    reportStep,
    onStart,
    onEnd,
    modelFor,
    variantFor,
    renderPrompt,
    persistPhase,
    failWorkflow,
    gateEnabled,
  } = runnerCtx;
  const { taskId } = ctx;

  const dag = buildDag(definition.phases);
  const phaseMap = new Map(definition.phases.map((p) => [p.name, p]));

  /**
   * Execute a single standard agent phase (no loop). Returns PhaseResult and
   * whether the workflow should pause (approval gate).
   */
  async function executeSinglePhase(
    phase: NonNullable<ReturnType<typeof phaseMap.get>>,
    phaseName: string,
  ): Promise<{ result: PhaseResult; paused?: boolean }> {
    await reportStep(phaseName, "running", phase.messages?.on_start);
    const phaseCtx: Partial<TemplateContext> = { phaseOutputs: { ...outputs } };
    const prompt = buildPhasePrompt(phase, ctx, phaseCtx);
    const modelRaw = phase.model ? renderTemplate(phase.model, ctx) : undefined;
    const model = modelRaw || modelFor(phaseName);
    const variantRaw = phase.variant ? renderTemplate(phase.variant, ctx) : undefined;
    const variant = variantRaw || variantFor(phaseName);

    const pr = await runPhase(
      definition.name,
      phaseName,
      `${taskId}-${phaseName}`,
      triggerId,
      prompt,
      phaseConfigFor(config, phase),
      db,
      model,
      workflowId,
      githubAccess,
      variant,
    );

    if (pr.skipped) {
      return { result: { phase: phaseName, success: true, output: "Already completed" } };
    }

    const result: PhaseResult = { phase: phaseName, ...pickResult(pr.result) };

    if (!pr.result.success) {
      await reportStep(phaseName, "failed", phase.messages?.on_failure);
      return { result };
    }

    // Check on_output rules
    if (phase.on_output?.contains_BLOCKED && (pr.result.output?.toUpperCase() || "").includes("BLOCKED")) {
      const rule = phase.on_output.contains_BLOCKED;
      const hasUnlessLabel = rule.unless_label && ctx.issueLabels.includes(rule.unless_label);
      const titleMatches = !!rule.unless_title_matches &&
        new RegExp(rule.unless_title_matches, "i").test(ctx.issueTitle || "");
      if (hasUnlessLabel || titleMatches) {
        await notifyMessage(rule.bypass_message || phase.messages?.on_blocked_bypassed);
      } else if (rule.action === "fail") {
        db?.markLatestAsFailed(`${definition.name}:${phaseName}`, triggerId, rule.message || "BLOCKED", workflowId);
        failWorkflow(rule.message || "BLOCKED");
        await reportStep(phaseName, "blocked", rule.message || phase.messages?.on_blocked);
        return { result: { phase: phaseName, success: false, output: pr.result.output ?? "", error: "BLOCKED" } };
      }
    }

    // Approval gate
    if (phase.approval_gate && gateEnabled(phase.approval_gate) && db && workflowId) {
      const gateKey = phase.approval_gate;
      const approvalId = randomUUID();
      db.createApproval({
        id: approvalId,
        workflowRunId: workflowId,
        gate: gateKey,
        summary: `${phaseName} complete — awaiting ${gateKey} approval.`,
        requestedBy: ctx.sender,
        createdAt: new Date().toISOString(),
      });
      db.updateWorkflowPhase(workflowId, "waiting_approval", {
        phase: "waiting_approval",
        timestamp: new Date().toISOString(),
        success: true,
        summary: `Waiting for approval: ${gateKey} (${approvalId})`,
      });
      db.pauseWorkflowRun(workflowId);
      await reportStep(phaseName, "awaiting", phase.approval_gate_message, { gateKey }, { alsoNote: true });
      return { result, paused: true };
    }

    persistPhase(phaseName);
    await reportStep(phaseName, "done", phase.messages?.on_success);
    return { result };
  }

  // ── Main DAG execution loop ────────────────────────────────────────────────

  while (!isComplete(dag)) {
    // Cancel check (DAG path) — mirror the linear runner's between-phase
    // guard so a /cancel dispatch halts the next scheduling round.
    if (db && workflowId) {
      const latest = db.getWorkflowRun(workflowId);
      if (latest?.status === "cancelled") {
        console.log(`[runner:dag] ${definition.name} cancelled — stopping DAG`);
        return { success: false, phases };
      }
    } else {
      console.warn(`[runner:dag] cancel check skipped — no db/workflowId context`);
    }

    // First, mark nodes that should be skipped (trigger rule fails but deps are terminal)
    const toSkip = getNodesToSkip(dag);
    for (const node of toSkip) {
      node.status = "skipped";
      phases.push({ phase: node.name, success: true, output: "Skipped (trigger rule not satisfied)" });
      if (db && workflowId) {
        db.updateNodeStatus(workflowId, node.name, "skipped");
      }
    }

    const ready = getReadyNodes(dag);

    if (ready.length === 0) {
      if (toSkip.length === 0) break; // stuck (shouldn't happen in a valid DAG)
      continue; // only had skips — loop to process downstream
    }

    // Mark all ready nodes as running before dispatching
    for (const node of ready) {
      node.status = "running";
      if (db && workflowId) {
        db.updateNodeStatus(workflowId, node.name, "running");
      }
    }

    // Dispatch all ready nodes concurrently
    const nodePromises = ready.map(async (node) => {
      try {
      const phase = phaseMap.get(node.name)!;
      await onStart(node.name);

      // Context phase — immediate
      if (phase.type === "context" || !phase.type) {
        const r: PhaseResult = { phase: node.name, success: true, output: "Context assembled" };
        // Same persist-history fix as the linear runner so the dashboard
        // marks context nodes done.
        persistPhase(node.name, "Context assembled");
        await onEnd(node.name, r);
        return { node, result: r, paused: false, alreadyPushed: false };
      }

      // Phase with neither prompt nor skill — skip
      if (!phase.prompt && !phase.skill) {
        console.warn(`[dag] Phase "${node.name}" has type=agent but neither prompt: nor skill: — skipping`);
        const r: PhaseResult = { phase: node.name, success: true, output: "Skipped (no prompt or skill)" };
        return { node, result: r, paused: false, alreadyPushed: false };
      }

      // Loop phase (reviewer-style) — run sequentially as a single DAG node
      if (phase.loop) {
        const loop = phase.loop;
        const MAX_CYCLES = loop.max_cycles;
        let approved = false;
        let fixCycles = 0;

        while (!approved && fixCycles <= MAX_CYCLES) {
          const reviewLabel = fixCycles === 0 ? node.name : `${node.name}_${fixCycles + 1}`;
          const reviewPrompt =
            fixCycles === 0
              ? buildPhasePrompt(phase, ctx, { phaseOutputs: { ...outputs }, fixCycle: fixCycles })
              : renderPrompt(loop.on_request_changes.re_review_prompt, { phaseOutputs: { ...outputs }, fixCycle: fixCycles });
          const reviewModelRaw = phase.model ? renderTemplate(phase.model, ctx) : undefined;
          const reviewModel = reviewModelRaw || modelFor(node.name);
          const reviewVariantRaw = phase.variant ? renderTemplate(phase.variant, ctx) : undefined;
          const reviewVariant = reviewVariantRaw || variantFor(node.name);

          const rr = await runPhase(
            definition.name,
            reviewLabel,
            `${taskId}-${reviewLabel}`,
            triggerId,
            reviewPrompt,
            phaseConfigFor(config, phase),
            db,
            reviewModel,
            workflowId,
            githubAccess,
            reviewVariant,
          );
          if (rr.skipped) {
            approved = true;
            phases.push({ phase: reviewLabel, success: true, output: "Already completed" });
            break;
          }

          phases.push({ phase: reviewLabel, ...pickResult(rr.result) });
          await onEnd(reviewLabel, phases[phases.length - 1]);

          const reviewerOutput = (rr.result.output || "").trim();
          const verdictMarker = reviewerOutput.match(/^\s*VERDICT:\s*(APPROVED|REQUEST_CHANGES)\s*$/im);
          const isApproved = verdictMarker
            ? verdictMarker[1].toUpperCase() === "APPROVED"
            : !(/\bREQUEST_CHANGES\b/.test(reviewerOutput.toUpperCase())) && /^APPROVED\b/.test(reviewerOutput.toUpperCase());

          if (isApproved) {
            approved = true;
          } else if (fixCycles < MAX_CYCLES) {
            fixCycles++;
            const fixLabel = `${node.name}_fix_${fixCycles}`;
            const fixPromptRendered = renderPrompt(loop.on_request_changes.fix_prompt, { phaseOutputs: { ...outputs }, fixCycle: fixCycles });
            const fixModelRaw = loop.on_request_changes.fix_model ? renderTemplate(loop.on_request_changes.fix_model, ctx) : undefined;
            const fixModel = fixModelRaw || modelFor(`${node.name}_fix`) || modelFor(node.name);
            const fixVariantRaw = loop.on_request_changes.fix_variant ? renderTemplate(loop.on_request_changes.fix_variant, ctx) : undefined;
            const fixVariant = fixVariantRaw || variantFor(`${node.name}_fix`) || variantFor(node.name);
            const fr = await runPhase(
              definition.name,
              fixLabel,
              `${taskId}-fix${fixCycles}`,
              triggerId,
              fixPromptRendered,
              phaseConfigFor(config, phase),
              db,
              fixModel,
              workflowId,
              githubAccess,
              fixVariant,
            );
            if (!fr.skipped) {
              phases.push({ phase: fixLabel, ...pickResult(fr.result) });
              await onEnd(fixLabel, phases[phases.length - 1]);
            }
          } else {
            break;
          }
        }

        const loopResult: PhaseResult = { phase: node.name, success: approved, output: approved ? "Approved" : "Request changes" };
        if (phase.output_var) {
          outputs[phase.output_var] = { approved, cycles: fixCycles };
        }
        return { node, result: loopResult, paused: false, alreadyPushed: true };
      }

      // Generic loop phase
      if (phase.generic_loop) {
        const loop = phase.generic_loop;
        const MAX_ITER = loop.max_iterations;
        const MAX_PREV_OUTPUT_BYTES = 10 * 1024;
        let iteration = 0;
        let complete = false;
        let previousOutput = "";

        while (!complete && iteration < MAX_ITER) {
          iteration++;
          const iterLabel = `${node.name}_iter_${iteration}`;
          const iterCtx: Partial<TemplateContext> = {
            iteration,
            maxIterations: MAX_ITER,
            previousOutput: loop.fresh_context ? "" : previousOutput,
            phaseOutputs: { ...outputs },
          };
          const iterPrompt = buildPhasePrompt(phase, ctx, iterCtx);
          const modelRaw = phase.model ? renderTemplate(phase.model, ctx) : undefined;
          const model = modelRaw || modelFor(node.name);
          const variantRaw = phase.variant ? renderTemplate(phase.variant, ctx) : undefined;
          const variant = variantRaw || variantFor(node.name);

          const ir = await runPhase(
            definition.name,
            iterLabel,
            `${taskId}-${iterLabel}`,
            triggerId,
            iterPrompt,
            phaseConfigFor(config, phase),
            db,
            model,
            workflowId,
            githubAccess,
            variant,
          );
          if (ir.skipped) { complete = true; break; }

          phases.push({ phase: iterLabel, ...pickResult(ir.result) });
          await onEnd(iterLabel, phases[phases.length - 1]);

          if (!ir.result.success) {
            failWorkflow(ir.result.error);
            return { node, result: { phase: node.name, success: false, output: "", error: ir.result.error }, paused: false, alreadyPushed: true };
          }

          const iterOutput = ir.result.output || "";
          if (!loop.fresh_context) {
            const combined = previousOutput ? `${previousOutput}\n${iterOutput}` : iterOutput;
            previousOutput = combined.length > MAX_PREV_OUTPUT_BYTES ? combined.slice(-MAX_PREV_OUTPUT_BYTES) : combined;
          }

          let conditionMet = false;
          if (loop.until) {
            conditionMet = evalUntilExpression(loop.until, { output: iterOutput, ...Object.fromEntries(Object.entries(ctx).filter(([, v]) => typeof v === "string").map(([k, v]) => [k, v as string])) });
          }
          if (!conditionMet && loop.until_bash) {
            try { validateShellCommand(loop.until_bash); execSync(loop.until_bash, { timeout: 30_000, stdio: "pipe", cwd: config.sandboxDir ?? config.cwd }); conditionMet = true; }
            catch { conditionMet = false; }
          }
          if (conditionMet) { complete = true; }
        }

        if (!complete) {
          await reportStep(node.name, "failed", phase.messages?.on_failure, { iteration, maxIterations: MAX_ITER });
        }
        if (phase.output_var) {
          outputs[phase.output_var] = { completed: complete, iterations: iteration };
        }
        return { node, result: { phase: node.name, success: true, output: previousOutput || "" }, paused: false, alreadyPushed: true };
      }

      // Standard agent phase
      const { result, paused } = await executeSinglePhase(phase, node.name);
      await onEnd(node.name, result);
      return { node, result, paused: paused ?? false, alreadyPushed: false };
      } catch (err) {
        console.error(`[dag] Phase "${node.name}" threw unexpectedly:`, err);
        const result: PhaseResult = { phase: node.name, success: false, error: String(err), output: "" };
        return { node, result, paused: false, alreadyPushed: false };
      }
    });

    const settled = await Promise.allSettled(nodePromises);

    let anyPaused = false;
    for (const settledItem of settled) {
      if (settledItem.status === "rejected") {
        console.error("[dag] Phase promise rejected:", settledItem.reason);
        continue;
      }

      const { node, result, paused, alreadyPushed } = settledItem.value;

      if (!alreadyPushed) {
        phases.push(result);
      }

      if (paused) {
        anyPaused = true;
        node.status = "succeeded"; // treat paused as succeeded so downstream trigger rules fire correctly — the workflow will resume from this node's successors after approval
        continue;
      }

      node.status = result.success ? "succeeded" : "failed";
      if (db && workflowId) {
        db.updateNodeStatus(workflowId, node.name, node.status);
      }

      // Always record the raw phase output (both by phase name and any
      // configured output_var alias) so downstream prompts can interpolate via
      // ${phaseName.output} or {{alias}}. Loop phases that emit structured
      // objects set their output_var themselves above — don't clobber those.
      const phaseDef = phaseMap.get(node.name)!;
      if (result.output != null) {
        if (outputs[node.name] === undefined || typeof outputs[node.name] === "string") {
          outputs[node.name] = result.output;
        }
        if (phaseDef.output_var && outputs[phaseDef.output_var] === undefined) {
          outputs[phaseDef.output_var] = result.output;
        }
      }
    }

    if (anyPaused) {
      return { success: true, phases, paused: true };
    }
  }

  // Determine overall success
  const anyFailed = phases.some((p) => !p.success);
  return { success: !anyFailed, phases };
}
