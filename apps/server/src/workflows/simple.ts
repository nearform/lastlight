import { randomUUID } from "crypto";
import type { ExecutorConfig } from "../engine/github/profiles.js";
import type { StateDb, WorkflowRun, TriggerActorType } from "../state/db.js";
import { getBotName, type ModelConfig, type VariantConfig } from "../config/config.js";
import { getWorkflow } from "./loader.js";
import {
  runWorkflow,
  type ApprovalGateConfig,
  type RunnerCallbacks,
  type WorkflowResult,
} from "./runner.js";
import { PhaseRef } from "./phase-ref.js";
import type { TemplateContext } from "./templates.js";
import { slugify } from "./templates.js";
import { wrapUntrusted } from "../engine/screen/screen.js";
import { buildProgressModel, runDashboardUrl } from "../notify/model.js";
import { buildAssetIssueKey } from "../state/build-assets.js";
import {
  PER_TARGET_REUSE_WORKFLOWS,
  PER_TARGET_RECREATE_WORKFLOWS,
  PREPOPULATE_SYNTH_WORKFLOWS,
  PR_HEADREF_PREPOPULATE_WORKFLOWS,
  PR_FIX_SHAPED_WORKFLOWS,
} from "./target-policy.js";

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
   * Actor logging (issue #205): who triggered this run and how, persisted on
   * the `workflow_runs` row for the dashboard's "Triggered by". Defaults to
   * `sender` / undefined when the dispatch layer doesn't supply them.
   */
  triggeredBy?: string;
  triggerActorType?: TriggerActorType;
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

// Per-target workspace provisioning policy lives in `./target-policy.js` (a
// leaf module the runner can share without an import cycle). Imported at the
// top for local use; re-exported here for existing callers (e.g. src/index.ts
// imports PR_HEADREF_PREPOPULATE_WORKFLOWS).
export {
  PER_TARGET_REUSE_WORKFLOWS,
  PER_TARGET_RECREATE_WORKFLOWS,
  PREPOPULATE_SYNTH_WORKFLOWS,
  PR_HEADREF_PREPOPULATE_WORKFLOWS,
  PR_FIX_SHAPED_WORKFLOWS,
};

export function workflowScopedTaskId(
  repo: string,
  number: number | undefined,
  workflowName: string,
  workflowId: string,
): string {
  // Reusable / recreatable per-target workspaces are keyed by (repo, issue)
  // only — no run suffix — so a re-run lands on the same dir (reused for
  // pr-review/pr-fix, recreated-from-base for build; see the two sets above).
  if (
    number !== undefined &&
    (PER_TARGET_REUSE_WORKFLOWS.has(workflowName) ||
      PER_TARGET_RECREATE_WORKFLOWS.has(workflowName))
  ) {
    return `${repo}-${number}-${workflowName}`;
  }
  const suffix = workflowId.slice(0, 8);
  return number !== undefined
    ? `${repo}-${number}-${workflowName}-${suffix}`
    : `${repo}-${workflowName}-${suffix}`;
}

/**
 * Resolve the `{{branch}}` template var (and the matching sandbox
 * `prePopulateBranch`) for a dispatch.
 *
 * The branch a build-style run creates and pushes is `lastlight/N-<title-slug>`,
 * derived from the issue title at **first** dispatch. Every later re-entry of the
 * same run — an approval-gate resume, a retry — comes through `runSimpleWorkflow`
 * again, but the resume event carries an **empty** issue title, so a naive
 * recompute collapses to the `lastlight/N-issue-N` fallback. That drifted name
 * is harmless for phases that `git push origin HEAD` (the persisted workspace is
 * still on the real branch) but fatal for the PR phase, whose prompt feeds
 * `{{branch}}` straight into `github_create_pull_request`'s `head` — GitHub 422s
 * because the fallback ref was never pushed.
 *
 * So when reusing an existing run we pin to the branch stored on the run row at
 * creation, mirroring `resume.ts`'s `stored.branch ?? …` precedence. `stored`
 * is `undefined` for a fresh run (no row yet).
 */
export function resolveRunBranch(args: {
  stored?: Record<string, unknown>;
  requestPrePopulateBranch?: string;
  issueNumber?: number;
  issueTitle?: string;
  workflowName: string;
}): { branch: string; prePopulateBranch: string | undefined } {
  const { stored, requestPrePopulateBranch, issueNumber, issueTitle, workflowName } = args;

  const storedBranch = typeof stored?.branch === "string" && stored.branch ? stored.branch : undefined;
  const storedPrePopulate =
    typeof stored?.prePopulateBranch === "string" && stored.prePopulateBranch
      ? stored.prePopulateBranch
      : undefined;

  const branch = storedBranch
    ?? requestPrePopulateBranch
    ?? (issueNumber !== undefined
      ? `lastlight/${issueNumber}-${slugify(issueTitle || `issue-${issueNumber}`)}`
      : `lastlight/${workflowName}`);

  // Pre-populate (clone into the sandbox, cwd = repo root) for the workflows in
  // PREPOPULATE_SYNTH_WORKFLOWS even though they synthesize a not-yet-pushed
  // branch — see that const's doc comment for why (the verify/qa-test harvest
  // fix in particular).
  const prePopulateBranch = storedPrePopulate
    ?? requestPrePopulateBranch
    ?? (PREPOPULATE_SYNTH_WORKFLOWS.has(workflowName) ? branch : undefined);

  return { branch, prePopulateBranch };
}

/**
 * The agent-facing path for a run's build-handoff docs (`{{issueDir}}`).
 *
 * Server mode on a **pre-cloned** workflow (cwd = the checkout) whose backend
 * mounts the whole workspace (docker/none/smol) relocates the docs to the
 * workspace ROOT — a sibling of the repo — reached via `../`, so the executor's
 * `git add -A` can never sweep them into the feature commit. gondolin mounts
 * only cwd, so a workspace-root sibling would be invisible/unharvestable in the
 * guest; it keeps the in-repo path and leans on the prompt-level commit gate.
 * Repo mode always keeps the in-repo path (the docs are meant to be committed).
 *
 * The orchestrator's `hostRepoDirFor` must stage/harvest in the same place; it
 * keys off `config.buildAssetsRelocated`, which simple.ts derives from the
 * `../` prefix this function produces — so the two can't disagree.
 */
export function artifactIssueDir(
  config: Pick<ExecutorConfig, "buildAssets" | "sandbox">,
  issueKey: string,
  preCloned: boolean,
): string {
  const relocate =
    config.buildAssets === "server" &&
    (config.sandbox ?? "gondolin") !== "gondolin" &&
    preCloned;
  return relocate ? `../.lastlight/${issueKey}` : `.lastlight/${issueKey}`;
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
  concurrency?: { maxWorkflows: number; maxQueueWaitMs: number },
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
  // `let`, not `const`: when we reuse an existing run below the resolution is
  // redone with the run's stored context so the branch can't drift off the
  // already-pushed name on resume — see `resolveRunBranch`.
  let { branch, prePopulateBranch: effectivePrePopulateBranch } = resolveRunBranch({
    requestPrePopulateBranch: request.prePopulateBranch,
    issueNumber: number,
    issueTitle: request.issueTitle,
    workflowName,
  });

  // ── Resume handling ────────────────────────────────────────────────────────
  //
  // If a workflow_run already exists for this trigger, reuse its id. The
  // runner re-runs from the top and the executions ledger (`shouldRunPhase`)
  // skips already-completed phases — no per-workflow branching needed.

  // Only reuse a workflow_run row when the existing run is still live
  // (running/paused). `getWorkflowRunByTrigger` already filters out
  // completed rows — a fresh re-trigger for a succeeded run falls through
  // to the `else` branch, creating a new workflow_run_id and a new set of
  // dedup-scoped executions.
  let workflowId: string;
  let taskId: string;
  let issueDir: string;
  const existingRun = db.runs.getByTrigger(triggerId);
  if (existingRun && existingRun.workflowName === workflowName) {
    workflowId = existingRun.id;
    const stored = (existingRun.context || {}) as Record<string, unknown>;
    taskId = (stored.taskId as string | undefined) ||
      workflowScopedTaskId(repo, number, workflowName, workflowId);
    // Recover issueDir from stored context so resumed runs use the same
    // workspace path as the original.
    issueDir = (stored.issueDir as string | undefined)
      || `.lastlight/${buildAssetIssueKey(workflowName, number, workflowId)}`;
    // Re-resolve the branch with the run's stored context. A resume event (e.g.
    // an approval response) carries an empty issue title, so the fresh
    // computation above drifts to the `lastlight/N-issue-N` fallback — but the
    // executor already pushed under the original title-slug name. Pinning to the
    // stored branch keeps every re-entered phase's `{{branch}}` correct, most
    // critically the PR phase's `head:` ref (otherwise GitHub 422s on create).
    ({ branch, prePopulateBranch: effectivePrePopulateBranch } = resolveRunBranch({
      stored,
      requestPrePopulateBranch: request.prePopulateBranch,
      issueNumber: number,
      issueTitle: request.issueTitle,
      workflowName,
    }));
    const handled = await handleExistingRun(existingRun, definition, notify, db);
    if (handled) return handled;
  } else {
    workflowId = randomUUID();
    taskId = workflowScopedTaskId(repo, number, workflowName, workflowId);
    // Issue-scoped workflows share a dir by issue number; non-issue
    // workflows (explore, health, etc.) get a run-scoped dir so
    // concurrent sessions never overlap.
    //
    // Server mode + pre-cloned + a whole-workspace backend relocates the docs
    // to the workspace root (reached via `../`) so `git add -A` can't sweep
    // them in; see artifactIssueDir.
    issueDir = artifactIssueDir(
      config,
      buildAssetIssueKey(workflowName, number, workflowId),
      !!effectivePrePopulateBranch,
    );
    const overCap = concurrency !== undefined && db.runs.countRunning() >= concurrency.maxWorkflows;
    const runStatus: "running" | "queued" = overCap ? "queued" : "running";
    db.runs.createRun({
      id: workflowId,
      workflowName,
      triggerId,
      owner,
      repo,
      issueNumber: issueNumber ?? prNumber,
      currentPhase: definition.phases[0]?.name || "phase_0",
      status: runStatus,
      // Actor logging (issue #205): the ORIGINAL trigger. Falls back to
      // `sender` so pre-actor callers still attribute to the acting handle.
      triggeredBy: request.triggeredBy ?? request.sender,
      triggerActorType: request.triggerActorType,
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
    console.log(`[simple] Created workflow run ${workflowId} (${workflowName}) status=${runStatus}`);
    if (overCap) {
      await notify(
        `\`${workflowName}\` is queued — the concurrency limit` +
        ` (${concurrency!.maxWorkflows}) is reached.` +
        ` It'll start automatically when a slot frees.`,
      );
      return { success: true, queued: true, phases: [] };
    }
  }

  // The server-store key for this run's artifacts (owner/repo/issueKey). Kept
  // separate from issueDir because issueDir is an agent-facing *path* that may
  // now carry a `../` prefix (relocated runs) — deriving the key by stripping
  // `.lastlight/` off issueDir would then break. `buildAssetsRelocated` reads
  // the decision back off the resolved issueDir so reused/resumed rows stay
  // consistent with however the original dispatch formed it.
  const issueKey = buildAssetIssueKey(workflowName, number, workflowId);
  const buildAssetsRelocated = issueDir.startsWith("../");

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
      runUrl: runDashboardUrl(callbacks.publicUrl, workflowId, workflowName),
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
    // A PR is its own GitHub number, so for PR-scoped workflows (pr-review /
    // pr-fix, triggered by a `pr.*` webhook that carries only `prNumber`)
    // fall back to it — otherwise `issueNumber` is 0 and the `post-review`
    // action can't find the PR to post against. Mirrors the DB run row and
    // taskId, both of which already key off `issueNumber ?? prNumber`.
    issueNumber: issueNumber ?? prNumber ?? 0,
    // Surface the PR number explicitly too; `post-review` prefers it over
    // `issueNumber`, and PR-scoped prompts can reference `{{prNumber}}`.
    prNumber,
    issueTitle: request.issueTitle || "",
    issueBody: request.issueBody || "",
    issueLabels: request.issueLabels || [],
    commentBody: request.commentBody || "",
    sender: request.sender,
    // The bot's `@mention` handle (e.g. `@last-light`), for approval-gate and
    // command help strings in workflow YAML — `{{botMention}} approve`.
    botMention: `@${getBotName()}`,
    branch,
    taskId,
    issueDir,
    // True only in server mode — prompts gate their `git add .lastlight/ &&
    // commit` behind `{{#if !externalizeArtifacts}}` so the handoff docs are
    // never committed into the target repo (they're harvested to the server
    // store instead). Absent/false ⇒ repo behaviour (commit the docs).
    externalizeArtifacts: config.buildAssets === "server",
    // Dashboard base URL for the {{artifactUrl}} helper (server-mode doc links).
    publicUrl: callbacks.publicUrl,
    // Public, unauthenticated, image-only base URL for inline screenshot embeds
    // in the browser-QA comment (so GitHub's image proxy can fetch them without
    // a login). The agent appends `/<name>.png` per screenshot it saves. Empty
    // when no PUBLIC_URL is configured — the prompt then falls back to
    // filename-only references via `{{#if !artifactBaseUrl}}`. issueKey is
    // issueDir minus the `.lastlight/` prefix.
    artifactBaseUrl: callbacks.publicUrl
      ? `${String(callbacks.publicUrl).replace(/\/+$/, "")}/admin/api/public/artifacts/${owner}/${repo}/${issueKey}`
      : "",
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

  // In server mode, tag the run's config with its artifact identity so the
  // executor's stage-in/harvest seam can locate this run's docs in the store
  // at `<buildAssetsDir>/<owner>/<repo>/<issueKey>/`, plus whether the docs
  // live at the workspace root (relocated) so `hostRepoDirFor` stages/harvests
  // there instead of inside the repo checkout.
  const runConfig: ExecutorConfig =
    config.buildAssets === "server"
      ? {
          ...config,
          buildAssetsKey: { owner, repo, issueKey },
          buildAssetsRelocated,
        }
      : config;

  try {
    const result = await runWorkflow(
      definition,
      ctx,
      runConfig,
      callbacks,
      db,
      models,
      approvalConfig,
      workflowId,
      variants,
    );

    if (result.success && !result.paused) {
      db.runs.finishRun(workflowId, "succeeded");
    } else if (!result.success && !result.paused) {
      db.runs.finishRun(workflowId, "failed", {
        error: result.phases.find((p) => !p.success)?.error || "workflow failed",
      });
    }

    return result;
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    db.runs.finishRun(workflowId, "failed", { error: msg });
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
  // Dedup: a duplicate trigger on an already-queued run must be a no-op.
  // Do NOT fall through to runWorkflow — that would execute it outside the cap.
  if (run.status === "queued") {
    console.log(
      `[simple] Duplicate trigger for queued run ${run.id} (${run.workflowName}) — returning queued dedup`,
    );
    return { success: true, queued: true, phases: [] };
  }

  // Workflow already completed: currentPhase is a terminal set_phase marker
  // (e.g. "complete") — i.e. not a declared phase, not a generated loop label
  // (`*_fix_N` / `*_recheck_N` / `*_iter_N`), and not the synthetic
  // "waiting_approval" pause marker. Don't re-run.
  if (
    run.currentPhase &&
    run.currentPhase !== "waiting_approval" &&
    !definition.phases.some((p) => p.name === run.currentPhase) &&
    PhaseRef.parse(run.currentPhase).kind === "phase"
  ) {
    await notify(`Workflow \`${run.workflowName}\` is already complete for this trigger.`);
    return {
      success: true,
      phases: [{ phase: "resume", success: true, output: "Already complete" }],
    };
  }

  // Paused awaiting approval — see if a human has responded.
  if (run.status === "paused" && run.currentPhase === "waiting_approval") {
    const pendingApproval = db.approvals.getPendingForWorkflow(run.id);
    if (pendingApproval?.status === "approved") {
      // Resume is ledger-driven: the runner re-runs from the top and every
      // completed phase skips via `shouldRunPhase` (the executions ledger).
      // No currentPhase manipulation is needed — for an approve gate the
      // gated phase is already `done` so the runner proceeds past it; for a
      // reply gate the loop node resumes from `scratch.iteration`.
      console.log(
        `[simple] ${pendingApproval.kind === "reply" ? "Reply" : "Approval"} received for gate ${pendingApproval.gate} — resuming ${run.workflowName}`,
      );
      db.runs.setRunning(run.id);
      if (pendingApproval.kind !== "reply") {
        await notify(`**Approval received** — resuming \`${run.workflowName}\`.`);
      }
      return null; // fall through to runWorkflow
    } else if (pendingApproval?.status === "rejected") {
      const reason = pendingApproval.response || "no reason given";
      db.runs.finishRun(run.id, "failed", { error: `Rejected: ${reason}` });
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
