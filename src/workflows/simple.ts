import { randomUUID } from "crypto";
import type { ExecutorConfig } from "../engine/profiles.js";
import type { StateDb, WorkflowRun } from "../state/db.js";
import type { ModelConfig, VariantConfig } from "../config.js";
import { getWorkflow } from "./loader.js";
import {
  runWorkflow,
  type ApprovalGateConfig,
  type RunnerCallbacks,
  type WorkflowResult,
} from "./runner.js";
import { nextPhaseAfter } from "./phase-ref.js";
import type { TemplateContext } from "./templates.js";
import { slugify } from "./templates.js";
import { wrapUntrusted } from "../engine/screen.js";
import { buildProgressModel } from "../notify/model.js";

/**
 * Lightweight invocation request for any agent workflow. The runner handles
 * all phase-level logic generically, so this single entry point covers
 * everything from single-phase triage skills to the full multi-phase build
 * cycle — including resume, approval gates, and the paused/approved/rejected
 * dance after a human responds to an approval.
 */
export interface SimpleWorkflowRequest {
  owner: string;
  repo: string;
  /** Optional — populated for issue-scoped workflows */
  issueNumber?: number;
  /** Optional — populated for PR-scoped workflows */
  prNumber?: number;
  /** Issue title (best-effort, may be empty for repo-scoped workflows) */
  issueTitle?: string;
  /** Issue body (best-effort) */
  issueBody?: string;
  /** Labels currently on the issue/PR */
  issueLabels?: string[];
  /** The triggering comment body, if applicable */
  commentBody?: string;
  /** Originating user (or "cli" / "cron" etc.) */
  sender: string;
  /**
   * Explicit trigger id override. Slack-initiated workflows pass a
   * `slack:{teamId}:{channel}:{threadTs}` string here so pause/resume uses
   * the Slack thread as the stable key. When unset, the trigger id is
   * derived from owner/repo/issueNumber as usual.
   */
  triggerId?: string;
  /**
   * Extra context to merge into the template context. Use this for
   * workflow-specific args like { mode: "scan" } from cron jobs, or the
   * pr-fix workflow's failedChecks/branch/prNumber payload.
   */
  extra?: Record<string, unknown>;
  /**
   * When set, the harness pre-clones the repo at this branch into the
   * sandbox workspace before the agent starts. Used by pr-review /
   * pr-fix so the agent enters a workspace already checked out at the
   * PR's head ref — saves a redundant `clone_repo` call inside the
   * session.
   */
  prePopulateBranch?: string;
}

function workflowScopedTaskId(
  repo: string,
  number: number | undefined,
  workflowName: string,
  workflowId: string,
): string {
  const suffix = workflowId.slice(0, 8);
  return number !== undefined
    ? `${repo}-${number}-${workflowName}-${suffix}`
    : `${repo}-${workflowName}-${suffix}`;
}

/**
 * Run a named agent workflow against a target.
 *
 * If a workflow_run row already exists for this trigger, we reuse it and let
 * the runner's definition-driven resume pick up after the last completed
 * phase — including the paused/approved/rejected paths. Otherwise we create a
 * fresh row so the dashboard sees it immediately.
 */
export async function runSimpleWorkflow(
  workflowName: string,
  request: SimpleWorkflowRequest,
  config: ExecutorConfig,
  callbacks: RunnerCallbacks,
  db: StateDb,
  models?: ModelConfig,
  approvalConfig?: ApprovalGateConfig,
  bootstrapLabel = "lastlight:bootstrap",
  variants?: VariantConfig,
): Promise<WorkflowResult> {
  // Kill switch — if an admin has disabled this workflow in the dashboard,
  // skip every trigger source (cron, webhooks, mentions, Slack) without
  // creating a workflow_runs row. Returning success=true keeps callers
  // (router, cron tick, etc.) from treating this as an error.
  if (!db.isWorkflowEnabled(workflowName)) {
    console.log(
      `[workflow] skipped "${workflowName}" — disabled in admin dashboard`,
    );
    return { success: true, phases: [] };
  }

  const definition = getWorkflow(workflowName);
  const { owner, repo, issueNumber, prNumber } = request;
  const notify = callbacks.postComment || (async () => {});

  // Identify the trigger uniquely. Issue/PR-scoped workflows include the
  // number; repo-scoped workflows (e.g. health) just identify by repo+name;
  // Slack-initiated runs pass an explicit `slack:*` id for thread scoping.
  const number = issueNumber ?? prNumber;
  const triggerId = request.triggerId
    ?? (number !== undefined
      ? `${owner}/${repo}#${number}`
      : `${owner}/${repo}::${workflowName}`);

  // When the dispatcher passes `prePopulateBranch` (set for pr-review /
  // pr-fix from the actual PR head ref), use that as the `branch` template
  // var too — the agent's workspace is going to be checked out at that
  // ref, so the prompt should reflect reality rather than a lastlight/N-slug
  // name that doesn't exist. Build-style workflows still get the synthesized
  // lastlight/N-slug branch they create themselves.
  const branch = request.prePopulateBranch
    ?? (number !== undefined
      ? `lastlight/${number}-${slugify(request.issueTitle || `issue-${number}`)}`
      : `lastlight/${workflowName}`);

  // Build-style workflows synthesize a new `lastlight/N-slug` branch that
  // doesn't exist on the remote at dispatch time, so the dispatcher leaves
  // `prePopulateBranch` unset. The harness can still pre-clone — the new
  // missing-branch fallback in `prePopulateWorkspace` clones the default
  // branch and creates the target branch locally. With that, every phase of
  // a build run enters a workspace already at `<repo>/` on the right branch,
  // and the per-phase prompts no longer need a `git clone … && cd <repo>`
  // preamble.
  const effectivePrePopulateBranch = request.prePopulateBranch
    ?? (workflowName === "build" ? branch : undefined);

  // ── Resume handling ────────────────────────────────────────────────────────
  //
  // If a workflow_run already exists for this trigger, reuse its id. The
  // runner's `nextPhaseAfter(definition, currentPhase)` derives the resume
  // point — no per-workflow branching needed.

  // Only reuse a workflow_run row when the existing run is still live
  // (running/paused). `getWorkflowRunByTrigger` already filters out
  // completed rows — a fresh re-trigger for a succeeded run falls through
  // to the `else` branch, creating a new workflow_run_id and a new set of
  // dedup-scoped executions.
  let workflowId: string;
  let taskId: string;
  let issueDir: string;
  const existingRun = db.getWorkflowRunByTrigger(triggerId);
  if (existingRun && existingRun.workflowName === workflowName) {
    workflowId = existingRun.id;
    const stored = (existingRun.context || {}) as Record<string, unknown>;
    taskId = (stored.taskId as string | undefined) ||
      workflowScopedTaskId(repo, number, workflowName, workflowId);
    // Recover issueDir from stored context so resumed runs use the same
    // workspace path as the original.
    issueDir = (stored.issueDir as string | undefined)
      || (number !== undefined
        ? `.lastlight/issue-${number}`
        : `.lastlight/${workflowName}-${workflowId.slice(0, 8)}`);
    const handled = await handleExistingRun(existingRun, definition, notify, db);
    if (handled) return handled;
  } else {
    workflowId = randomUUID();
    taskId = workflowScopedTaskId(repo, number, workflowName, workflowId);
    // Issue-scoped workflows share a dir by issue number; non-issue
    // workflows (explore, health, etc.) get a run-scoped dir so
    // concurrent sessions never overlap.
    issueDir = number !== undefined
      ? `.lastlight/issue-${number}`
      : `.lastlight/${workflowName}-${workflowId.slice(0, 8)}`;
    db.createWorkflowRun({
      id: workflowId,
      workflowName,
      triggerId,
      repo,
      issueNumber: issueNumber ?? prNumber,
      currentPhase: definition.phases[0]?.name || "phase_0",
      status: "running",
      context: {
        kind: definition.kind,
        owner,
        branch,
        taskId,
        issueDir,
        prePopulateBranch: effectivePrePopulateBranch,
        models: models as Record<string, unknown> | undefined,
        variants: variants as Record<string, unknown> | undefined,
        ...request.extra,
      },
      startedAt: new Date().toISOString(),
    });
    console.log(`[simple] Created workflow run ${workflowId} (${workflowName})`);
  }

  // Surface the run id to the dispatch layer as soon as it's known (either
  // fresh or reused). Fire-and-forget so a slow/broken downstream hook can't
  // stall the workflow.
  if (callbacks.onRunStart) {
    callbacks.onRunStart(workflowId).catch((err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[simple] onRunStart callback threw: ${msg}`);
    });
  }

  // ── Seed the in-place progress checklist ───────────────────────────────────
  //
  // For workflows that opt into `status_checklist`, build the task-list model
  // from the definition's phases and publish the initial surface (one GitHub
  // comment / one Slack message that subsequent phases edit in place). On a
  // resumed run we re-seed the SAME surface (the transport re-attaches to the
  // stored comment id / message ts) and mark already-completed phases done.
  if (callbacks.reporter && definition.status_checklist) {
    const completed = new Set(
      (existingRun?.phaseHistory ?? []).map((h) => h.phase),
    );
    const model = buildProgressModel(definition, {
      workflowName,
      number,
      issueTitle: request.issueTitle,
      owner,
      repo,
      branch,
      completed,
    });
    await callbacks.reporter.start(model).catch((err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[simple] reporter.start threw: ${msg}`);
    });
  }

  // ── Build template context ─────────────────────────────────────────────────
  //
  // The context snapshot is the agent's primary view of the task. All
  // user-provided text is wrapped in <<<USER_CONTENT_UNTRUSTED>>> markers so
  // the agent — anchored by agent-context/security.md — treats them as data
  // rather than instructions. The trigger metadata (sender, branch, issue
  // ref) sits outside the wrappers so identity is established out-of-band.
  //
  // For build/pr-fix/explore workflows the dispatch path (src/index.ts)
  // pre-fetches the real issue body + full comment thread and stitches them
  // into request.extra.combinedContext (one screening call). For everything
  // else we fall back to whatever the envelope carried.

  const combinedContext = (request.extra?.combinedContext as string | undefined) || "";
  const issueRef = `${owner}/${repo}${issueNumber ? `#${issueNumber}` : ""}`;
  const hasAnyUserContent = !!(combinedContext || request.issueBody || request.commentBody);

  const contextSnapshot = hasAnyUserContent
    ? [
        `Repo: ${issueRef}`,
        `Issue title: ${request.issueTitle || "(none)"}`,
        request.commentBody
          ? `Triggering comment:\n${wrapUntrusted(request.commentBody, { source: "github-comment", author: request.sender })}`
          : "",
        `Requested by: ${request.sender}`,
        `Branch: ${branch}`,
        combinedContext
          ? `Issue body and full thread:\n${wrapUntrusted(combinedContext, { source: "github-issue-thread" })}`
          : request.issueBody
          ? `Issue body:\n${wrapUntrusted(request.issueBody, { source: "github-issue-body" })}`
          : "",
      ]
        .filter(Boolean)
        .join("\n\n")
    : "";

  const ctx: TemplateContext = {
    owner,
    repo,
    issueNumber: issueNumber ?? 0,
    issueTitle: request.issueTitle || "",
    issueBody: request.issueBody || "",
    issueLabels: request.issueLabels || [],
    commentBody: request.commentBody || "",
    sender: request.sender,
    branch,
    taskId,
    issueDir,
    bootstrapLabel,
    contextSnapshot,
    // Forwarded to the executor (via gitSandboxAccessForWorkflow) so the
    // harness pre-clones this branch into the sandbox workspace before
    // the agent starts. Stored on the workflow_run row above; also lives
    // on ctx so the runner can read it without an extra DB lookup.
    prePopulateBranch: effectivePrePopulateBranch,
    models: models as unknown as Record<string, unknown>,
    // Reasoning-effort overrides per phase. Empty/undefined entries skip
    // the --variant flag (model uses its default effort).
    variants: variants as unknown as Record<string, unknown> | undefined,
    // Slack-initiated runs need the runner to pause/resume on the thread id,
    // not on owner/repo#N. Passing the override through here keeps the
    // runner's triggerId derivation in one place.
    triggerIdOverride: request.triggerId,
    // Extra workflow-specific args (e.g. mode: scan from cron, or the PR fix
    // payload). These become top-level ctx keys so prompt templates can read
    // them directly via {{failedChecks}} etc.
    ...(request.extra || {}),
  };

  try {
    const result = await runWorkflow(
      definition,
      ctx,
      config,
      callbacks,
      db,
      models,
      approvalConfig,
      workflowId,
      variants,
    );

    if (result.success && !result.paused) {
      db.finishWorkflowRun(workflowId, "succeeded");
    } else if (!result.success && !result.paused) {
      db.finishWorkflowRun(
        workflowId,
        "failed",
        result.phases.find((p) => !p.success)?.error || "workflow failed",
      );
    }

    return result;
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    db.finishWorkflowRun(workflowId, "failed", msg);
    throw err;
  }
}

/**
 * Short-circuit for a workflow run that already has state. Returns a
 * WorkflowResult to return directly (already complete / rejected / still
 * paused), or `null` to continue into `runWorkflow` for normal resume.
 */
async function handleExistingRun(
  run: WorkflowRun,
  definition: ReturnType<typeof getWorkflow>,
  notify: (msg: string) => Promise<void>,
  db: StateDb,
): Promise<WorkflowResult | null> {
  // Workflow already completed (currentPhase points past the last real phase
  // — e.g. a set_phase terminal marker like "complete"). Don't re-run.
  // "waiting_approval" is a synthetic phase set when the runner pauses at a
  // gate — it's NOT a terminal marker, so exclude it from this check.
  if (
    run.currentPhase &&
    run.currentPhase !== "waiting_approval" &&
    nextPhaseAfter(definition, run.currentPhase) === null
  ) {
    const exactIdx = definition.phases.findIndex((p) => p.name === run.currentPhase);
    if (exactIdx === -1) {
      await notify(`Workflow \`${run.workflowName}\` is already complete for this trigger.`);
      return {
        success: true,
        phases: [{ phase: "resume", success: true, output: "Already complete" }],
      };
    }
  }

  // Paused awaiting approval — see if a human has responded.
  if (run.status === "paused" && run.currentPhase === "waiting_approval") {
    const pendingApproval = db.getPendingApprovalForWorkflow(run.id);
    if (pendingApproval?.status === "approved") {
      // Reply gates are a different shape than approve gates: the runner
      // needs to RE-ENTER the same phase (to run the next loop iteration)
      // rather than skip past it. Find the phase that owns the gate, and
      // set currentPhase to the phase BEFORE it so nextPhaseAfter lands
      // on the owning phase on resume.
      const owningPhase = findPhaseOwningLoopGate(definition, pendingApproval.gate)
        ?? findPhaseOwningGate(definition, pendingApproval.gate);
      if (owningPhase && pendingApproval.kind === "reply") {
        const ownIdx = definition.phases.findIndex((p) => p.name === owningPhase);
        const priorPhase = ownIdx > 0 ? definition.phases[ownIdx - 1].name : "";
        db.updateWorkflowPhase(run.id, priorPhase || owningPhase, {
          phase: priorPhase || owningPhase,
          timestamp: new Date().toISOString(),
          success: true,
          summary: `Resumed after reply on gate: ${pendingApproval.gate}`,
        });
      } else if (owningPhase) {
        db.updateWorkflowPhase(run.id, owningPhase, {
          phase: owningPhase,
          timestamp: new Date().toISOString(),
          success: true,
          summary: `Resumed after gate approval: ${pendingApproval.gate}`,
        });
      }
      console.log(
        `[simple] ${pendingApproval.kind === "reply" ? "Reply" : "Approval"} received for gate ${pendingApproval.gate} — resuming ${run.workflowName}`,
      );
      db.resumeWorkflowRun(run.id);
      if (pendingApproval.kind !== "reply") {
        await notify(`**Approval received** — resuming \`${run.workflowName}\`.`);
      }
      return null; // fall through to runWorkflow
    } else if (pendingApproval?.status === "rejected") {
      const reason = pendingApproval.response || "no reason given";
      db.finishWorkflowRun(run.id, "failed", `Rejected: ${reason}`);
      await notify(`Workflow \`${run.workflowName}\` was rejected. Reason: ${reason}`);
      return {
        success: false,
        phases: [{ phase: "rejected", success: false, output: `Rejected: ${reason}` }],
      };
    } else {
      await notify(`Workflow \`${run.workflowName}\` is paused, awaiting approval.`);
      return { success: true, phases: [], paused: true };
    }
  }

  // Normal resume — the runner's definition-driven resume takes over.
  console.log(
    `[simple] Resuming ${run.workflowName} for ${run.triggerId} (last phase: ${run.currentPhase})`,
  );
  return null;
}

/** Walk definition.phases and return the phase that declares this gate. */
function findPhaseOwningGate(
  definition: ReturnType<typeof getWorkflow>,
  gateName: string,
): string | null {
  for (const p of definition.phases) {
    if (p.approval_gate === gateName) return p.name;
    if (p.loop?.approval_gate === gateName) return p.name;
  }
  return null;
}

/**
 * Generic-loop gates are named `${phaseName}_iter_${N}`, so walk the phases
 * with `generic_loop` set and match by prefix. Used for reply-gate resume
 * where the gate name isn't declared up front.
 */
function findPhaseOwningLoopGate(
  definition: ReturnType<typeof getWorkflow>,
  gateName: string,
): string | null {
  for (const p of definition.phases) {
    if (!p.generic_loop) continue;
    if (gateName.startsWith(`${p.name}_iter_`)) return p.name;
  }
  return null;
}
