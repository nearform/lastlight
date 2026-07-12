import { randomUUID } from "crypto";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type {
  ExecutorConfig,
  ExecutionResult,
  GitSandboxAccess,
} from "../engine/github/profiles.js";
import { executeAgent, executeCommand, type CommandSpec } from "../engine/agent-executor.js";
import { GitHubClient } from "../engine/github/github.js";
import {
  buildReview,
  buildBodyOnlyReview,
  parseDiff,
  type ReviewFindingsDoc,
} from "../engine/github/review-poster.js";
import type { StateDb } from "../state/db.js";
import type { AgentWorkflowDefinition, PhaseDefinition } from "./schema.js";
import { phaseSkillNames } from "./schema.js";
import { loadPromptTemplate, resolveSkillPaths } from "./loader.js";
import { getRuntimeConfig, getBotName } from "../config/config.js";
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
 * `web_search`, `sandbox_image`, resolved skill paths) onto the run-level
 * config.
 */
export function phaseConfigFor(config: ExecutorConfig, phase: PhaseDefinition): ExecutorConfig {
  const skills = phaseSkillNames(phase);
  const skillPaths = skills.length ? resolveSkillPaths(skills) : undefined;

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
  db: StateDb | undefined,
  run: (onSessionId: (sessionId: string) => void) => Promise<ExecutionResult>,
): Promise<RunPhaseResult> {
  const { dedupKey, phaseName, taskId, triggerId, repo, workflowRunId } = meta;
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
        recordExecutionMetrics("phase", { ...attrs, success: result.success, stop_reason: result.stopReason, durationMs: result.durationMs, costUsd: result.costUsd, inputTokens: result.inputTokens, outputTokens: result.outputTokens });
        return { result, executionId, skipped: false };
      } catch (err) {
        recordError("phase", err, attrs);
        throw err;
      }
    }

    const result = await run(() => {});
    recordExecutionMetrics("phase", { ...attrs, success: result.success, stop_reason: result.stopReason, durationMs: result.durationMs, costUsd: result.costUsd, inputTokens: result.inputTokens, outputTokens: result.outputTokens });
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
  const baseConfig = modelOverride ? { ...config, model: modelOverride } : config;
  const phaseConfigBase = variantOverride ? { ...baseConfig, variant: variantOverride } : baseConfig;
  const phaseConfig: ExecutorConfig = {
    ...phaseConfigBase,
    telemetry: { workflowName, phaseName, triggerId, workflowRunId },
  };
  return runPhaseLedger(attrs, { dedupKey, phaseName, taskId, triggerId, repo: githubAccess?.repo, workflowRunId }, db, (onSessionId) =>
    executeAgent(prompt, phaseConfig, { taskId, githubAccess, onSessionId }),
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
  db?: StateDb,
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
  return runPhaseLedger(attrs, { dedupKey, phaseName, taskId, triggerId, repo: githubAccess?.repo, workflowRunId }, db, (onSessionId) =>
    executeCommand(spec, phaseConfig, { taskId, githubAccess, onSessionId, timeoutSeconds, sandboxEnv }),
  );
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
    if (phaseType === "post-review") return this.runPostReview(phase);
    if (phaseType === "bash" || phaseType === "script") return this.runCommandBody(phase, outputs);

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

  /**
   * First-class, in-process PR-review submission (`type: post-review`). The
   * reviewer agent writes only *content* to `.lastlight/pr-review/findings.json`
   * (`{ skip?, summary, event, findings[] }`); THIS action supplies every fact
   * the harness already knows — the PR number (from the run context), the base
   * ref, the head SHA and the diff (from the pre-cloned checkout) — anchors each
   * finding to a changed line, and posts one formal review via `GitHubClient`.
   *
   * This replaces the ~150-line in-sandbox `type: script` blob that depended on
   * the AI hand-copying `pr_number`/`base_ref`/`head_sha` into the JSON and
   * silently `exit 0`'d on any mismatch (the "ran but posted nothing" bug).
   * Here a genuine failure — missing findings after a real review, or a GitHub
   * error that survives the body-only retry — FAILS the phase visibly; only a
   * legitimate `skip` succeeds without posting. Idempotent on resume: it no-ops
   * when a bot review already exists on the current head SHA.
   */
  private async runPostReview(phase: PhaseDefinition): Promise<PhaseOutcome> {
    const phaseName = phase.name;
    await this.reporter.onStart(phaseName);
    await this.reporter.step(phaseName, "running", phase.messages?.on_start);

    const succeed = async (summary: string): Promise<PhaseOutcome> => {
      const result: PhaseResult = { phase: phaseName, success: true, output: summary };
      this.reporter.persistPhase(phaseName, summary);
      await this.reporter.onEnd(phaseName, result);
      await this.reporter.step(phaseName, "done", phase.messages?.on_success);
      return { results: [result], status: "succeeded" };
    };
    const fail = async (error: string): Promise<PhaseOutcome> => {
      const result: PhaseResult = { phase: phaseName, success: false, output: "", error };
      await this.reporter.onEnd(phaseName, result);
      await this.reporter.step(phaseName, "failed", phase.messages?.on_failure);
      // Record a failed phase_history entry so the dashboard pipeline renders
      // this node red — the action has no `executions` row (it runs in-process),
      // and `persistPhase` only writes success entries, so without this a failed
      // post-review would show as "pending" despite the run being marked failed.
      if (this.run.db && this.run.workflowId) {
        this.run.db.runs.appendPhase(this.run.workflowId, phaseName, {
          phase: phaseName,
          timestamp: new Date().toISOString(),
          success: false,
          summary: error,
        });
      }
      this.reporter.failWorkflow(error);
      console.error(`[post-review] ${error}`);
      return { results: [result], status: "failed" };
    };

    const ctx = this.run.ctx;
    const owner = String(ctx.owner);
    const repo = String(ctx.repo);
    const prNumber =
      (typeof ctx.prNumber === "number" ? ctx.prNumber : undefined) ??
      (typeof ctx.issueNumber === "number" && ctx.issueNumber > 0 ? ctx.issueNumber : undefined);
    if (!prNumber) return fail("post-review: no PR number in run context; cannot post review");

    // Read the agent's findings from the host checkout. The review phase writes
    // it at `.lastlight/pr-review/findings.json` relative to the repo cwd; the
    // workspace persists on the host between phases (see sandbox/index.ts).
    const hostRepoDir = this.resolveHostRepoDir(repo);
    const findingsPath = join(hostRepoDir, ".lastlight", "pr-review", "findings.json");
    let doc: ReviewFindingsDoc;
    try {
      doc = JSON.parse(readFileSync(findingsPath, "utf8")) as ReviewFindingsDoc;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // A missing/unreadable file after a completed review means the review
      // phase didn't honour its contract — surface it, don't post silently.
      return fail(`post-review: could not read findings (${findingsPath}): ${msg}`);
    }

    if (doc.skip) {
      return succeed(`skipped: ${doc.summary || "agent skipped review"}`);
    }

    const github = this.buildReviewClient();

    // Head SHA + base ref come from the checkout / run context, never the agent.
    const baseRef = typeof ctx.baseBranch === "string" && ctx.baseBranch ? ctx.baseBranch : undefined;
    const headSha = this.gitHeadSha(hostRepoDir);

    // Idempotency: skip if a bot review already exists on this head SHA (guards
    // resume / re-entry from double-posting).
    if (headSha) {
      try {
        const existing = await github.getLatestBotReview(owner, repo, prNumber, headSha, getRuntimeConfig()?.botLogin);
        if (existing) return succeed(`already reviewed head ${headSha.slice(0, 7)} (${existing.state})`);
      } catch {
        /* best-effort — fall through and attempt the post */
      }
    }

    // Commentable line set from the local checkout diff. Failure → null → all
    // findings demoted to the body (the review still posts).
    const commentable = baseRef ? this.gitCommentableDiff(hostRepoDir, baseRef) : null;
    const review = buildReview(doc, commentable);

    try {
      await github.createPullRequestReview(owner, repo, prNumber, {
        body: review.body,
        event: review.event,
        comments: review.comments,
        commitId: headSha,
      });
      return succeed(
        `posted review: ${review.inlineCount} inline, ${review.demotedCount} in body, event=${review.event}`,
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[post-review] inline review POST failed: ${msg}; retrying body-only`);
      // Off-diff anchors (e.g. a stale diff) 422 — retry with everything in the
      // body so the review still lands.
      const bodyOnly = buildBodyOnlyReview(doc);
      try {
        await github.createPullRequestReview(owner, repo, prNumber, {
          body: bodyOnly.body,
          event: bodyOnly.event,
          commitId: headSha,
        });
        return succeed(`posted review (body-only fallback): ${bodyOnly.demotedCount} findings, event=${bodyOnly.event}`);
      } catch (err2) {
        const msg2 = err2 instanceof Error ? err2.message : String(err2);
        return fail(`post-review: GitHub rejected the review (inline: ${msg}; body-only: ${msg2})`);
      }
    }
  }

  /** Host path of the run's repo checkout — mirrors sandbox/index.ts layout. */
  private resolveHostRepoDir(repo: string): string {
    const config = this.run.config;
    const sandboxBase = resolve(config.sandboxDir || join(config.stateDir || "data", "sandboxes"));
    const workDir = join(sandboxBase, this.run.taskId);
    // pr-review pre-clones into a `<repo>/` subdir (a sibling of the workspace
    // root's AGENTS.md / skill bundle). Fall back to the workspace root if the
    // repo subdir has no findings (defensive — should not happen for pr-review).
    const repoDir = join(workDir, repo);
    if (existsSync(join(repoDir, ".lastlight", "pr-review"))) return repoDir;
    if (existsSync(join(workDir, ".lastlight", "pr-review"))) return workDir;
    return repoDir;
  }

  /** Build the GitHub client for the post: token+baseUrl in evals, App auth in prod. */
  private buildReviewClient(): GitHubClient {
    const baseUrl = this.run.config.githubApiBaseUrl;
    if (baseUrl) {
      // Eval / test path: the mock ignores auth; any bearer token works.
      const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN || "eval-fake-token";
      return GitHubClient.withToken(token, baseUrl);
    }
    return new GitHubClient({
      appId: process.env.GITHUB_APP_ID || "",
      privateKeyPath: process.env.GITHUB_APP_PRIVATE_KEY_PATH || "",
      installationId: process.env.GITHUB_APP_INSTALLATION_ID || "",
    });
  }

  private gitHeadSha(repoDir: string): string | undefined {
    try {
      return execFileSync("git", ["-C", repoDir, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
    } catch {
      return undefined;
    }
  }

  /** Compute the base…head diff locally and parse it into a commentable set. */
  private gitCommentableDiff(repoDir: string, baseRef: string): Map<string, Set<string>> | null {
    const diff = () =>
      execFileSync("git", ["-C", repoDir, "diff", `origin/${baseRef}...HEAD`], {
        encoding: "utf8",
        maxBuffer: 64 * 1024 * 1024,
      });
    try {
      try {
        execFileSync("git", ["-C", repoDir, "fetch", "origin", baseRef, "--depth", "50"], { stdio: "ignore" });
      } catch {
        /* offline / already present — fall through to diff */
      }
      try {
        return parseDiff(diff());
      } catch (err) {
        // The `--depth 50` fetch above shallow-clones the base branch. When a PR
        // forked far behind the branch's current tip (a long-lived / stale PR),
        // the merge-base sits beyond that shallow boundary and the three-dot
        // diff dies with "no merge base" — which would demote EVERY finding to
        // the body. Deepen the base history and retry once so the review still
        // anchors inline. Only on this rare failure path do we pay the full
        // fetch. (`--unshallow` no-ops-then-throws on an already-complete repo,
        // hence best-effort.)
        const msg = err instanceof Error ? err.message : String(err);
        if (!/no merge base|shallow/i.test(msg)) throw err;
        try {
          execFileSync("git", ["-C", repoDir, "fetch", "origin", baseRef, "--unshallow"], { stdio: "ignore" });
        } catch {
          /* already complete / offline — retry the diff regardless */
        }
        return parseDiff(diff());
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[post-review] git diff failed (${msg}); demoting all findings to the body`);
      return null;
    }
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

    if (phase.approval_gate && this.resolver.gateEnabled(phase.approval_gate) && this.run.db && this.run.workflowId) {
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
    const { definition, config, db, workflowId, githubAccess, taskId, triggerId } = this.run;
    return runCommandPhase(
      definition.name,
      label,
      taskId,
      triggerId,
      spec,
      phaseConfigFor(config, phase),
      db,
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
      const res = await executeCommand(
        { kind: "bash", command },
        { ...phaseConfigFor(config, phase), telemetry: { workflowName: definition.name, phaseName: `${phase.name}_until`, triggerId, workflowRunId: workflowId } },
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
    artifact?: string,
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
    // the focused approval view via `{{approvalUrl}}`.
    await this.reporter.step(stepKey, "awaiting", message, { ...extraCtx, approvalId }, { alsoNote: true });
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
              `**To continue:** comment \`@${getBotName()} approve\`\n` +
              `**To abort:** comment \`@${getBotName()} reject [reason]\``,
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
