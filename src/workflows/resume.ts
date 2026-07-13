import type { StateDb, WorkflowRun } from "../state/db.js";
import type { ExecutorConfig } from "../engine/github/profiles.js";
import type { GitHubClient } from "../engine/github/github.js";
import type { ModelConfig, VariantConfig } from "../config/config.js";
import { runWorkflow, type ApprovalGateConfig, type RunnerCallbacks } from "./runner.js";
import { getWorkflow } from "./loader.js";
import { workflowScopedTaskId } from "./simple.js";
import { slugify, type TemplateContext } from "./templates.js";
import {
  ProgressNotifier,
  GitHubTransport,
  buildProgressModel,
  runDashboardUrl,
  type NotifierState,
} from "../notify/index.js";

export interface ResumeOptions {
  db: StateDb;
  github: GitHubClient | null;
  config: ExecutorConfig;
  models?: ModelConfig;
  variants?: VariantConfig;
  approvalConfig?: ApprovalGateConfig;
  bootstrapLabel?: string;
  /** Post a message to a Slack channel/thread. Used to resume Slack-originated workflows. */
  slackPoster?: (channelId: string, threadId: string, msg: string) => Promise<void>;
  /** Public base URL of the admin dashboard — for the checklist's live-run link. */
  publicUrl?: string;
}

/**
 * Parse `cliftonc/drizby#18` (or `cliftonc/drizby::workflow-name`) into
 * its components. Returns null for Slack/chat-originated trigger ids —
 * those runs resume via the messaging connector, not GitHub refetch.
 */
export function parseTriggerId(triggerId: string): { owner: string; repo: string } | null {
  if (triggerId.startsWith("slack:")) return null;
  const slashIdx = triggerId.indexOf("/");
  if (slashIdx < 0) return null;
  const hashIdx = triggerId.indexOf("#");
  const colonIdx = triggerId.indexOf("::");
  const end = hashIdx >= 0 ? hashIdx : colonIdx >= 0 ? colonIdx : triggerId.length;
  const owner = triggerId.slice(0, slashIdx);
  const repo = triggerId.slice(slashIdx + 1, end);
  if (!owner || !repo) return null;
  return { owner, repo };
}

/**
 * Parse a Slack trigger id of the form `slack:{teamId}:{channel}:{thread}`.
 * Returns null for anything else. Used by the runner bridge to reconstruct
 * channel/thread coordinates when resuming a Slack-initiated explore run.
 */
export function parseSlackTriggerId(
  triggerId: string,
): { teamId: string; channelId: string; threadTs: string } | null {
  if (!triggerId.startsWith("slack:")) return null;
  const parts = triggerId.slice("slack:".length).split(":");
  if (parts.length !== 3) return null;
  const [teamId, channelId, threadTs] = parts;
  if (!teamId || !channelId || !threadTs) return null;
  return { teamId, channelId, threadTs };
}

/**
 * Refetch the issue title/body/labels from GitHub so the resumed workflow
 * has fresh context (the user may have edited the issue while the harness
 * was down). Falls back to placeholder values if the fetch fails or no
 * GitHub client is available.
 */
async function refetchIssue(
  github: GitHubClient | null,
  owner: string,
  repo: string,
  issueNumber: number,
): Promise<{ title: string; body: string; labels: string[] }> {
  const fallback = {
    title: `Issue #${issueNumber}`,
    body: "",
    labels: [] as string[],
  };
  if (!github) return fallback;
  try {
    const issue = await github.getIssue(owner, repo, issueNumber);
    return {
      title: issue.title || fallback.title,
      body: issue.body || "",
      labels: ((issue.labels || []) as Array<string | { name?: string }>).map((l) =>
        typeof l === "string" ? l : l.name ?? "",
      ).filter(Boolean),
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[resume] Could not refetch ${owner}/${repo}#${issueNumber}: ${msg}`);
    return fallback;
  }
}

/**
 * Build the standard postComment callback for a resumed workflow. Comments
 * land on the originating GitHub issue so the maintainer sees the resume
 * progress alongside the original run.
 */
function makeCallbacks(
  github: GitHubClient | null,
  owner: string,
  repo: string,
  issueNumber: number | undefined,
  workflowName: string,
): RunnerCallbacks {
  return {
    postComment: github && issueNumber
      ? async (msg: string) => {
          try {
            await github.postComment(owner, repo, issueNumber, msg);
          } catch (err: unknown) {
            const m = err instanceof Error ? err.message : String(err);
            console.warn(`[resume] Failed to post comment: ${m}`);
          }
        }
      : undefined,
    onPhaseStart: async (phase) => console.log(`[resume] ▶ ${workflowName}/${phase}`),
    onPhaseEnd: async (phase, result) =>
      console.log(`[resume] ◀ ${workflowName}/${phase}: ${result.success ? "OK" : "FAILED"}`),
  };
}

/**
 * Resume a workflow run by calling runWorkflow directly with the existing
 * workflowId. We bypass runSimpleWorkflow because that wrapper always creates a
 * fresh workflow_runs row — we want to keep the existing one and let the
 * runner's per-phase dedup (`shouldRunPhase`) handle "what's already done".
 *
 * Two callers, same machinery:
 *  - `resumeOrphanedWorkflows` — boot recovery of `running` runs after a crash.
 *  - the admin/CLI **retry** path (`config.retryWorkflow` in `src/index.ts`) —
 *    a user retrying a `failed` run. The failed phase's ledger row is
 *    `success=0`, so it re-runs while already-succeeded phases skip; context is
 *    reconstructed here from the stored `run.context` + `run.scratch`, which is
 *    why retry works for Slack-thread-scoped runs the lossy `resumeWorkflow`
 *    (owner/repo/issueNumber) path can't handle.
 *
 * The caller MUST have already flipped the row to `running` (`setRunning` /
 * `restartRun`) — this function does not change the pre-run status, only the
 * terminal `finishRun` at the end.
 */
export async function resumeSimpleRun(run: WorkflowRun, opts: ResumeOptions): Promise<void> {
  const stored = (run.context || {}) as Record<string, unknown>;

  // Derive owner/repo: GitHub trigger ids encode it as owner/repo#N;
  // Slack-originated runs store owner in context and repo on the row.
  const parsed = parseTriggerId(run.triggerId);
  const owner = parsed?.owner ?? (stored.owner as string | undefined) ?? "";
  const repo = parsed?.repo ?? run.repo ?? "";
  const issueNumber = run.issueNumber;
  const isSlack = run.triggerId.startsWith("slack:");

  if (!owner && !repo && !isSlack) {
    console.warn(`[resume] Skipping ${run.id}: cannot derive owner/repo from triggerId ${run.triggerId}`);
    return;
  }

  let definition;
  try {
    definition = getWorkflow(run.workflowName);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[resume] Skipping ${run.id}: workflow definition "${run.workflowName}" not found: ${msg}`);
    opts.db.runs.finishRun(run.id, "failed", { error: `harness restarted; workflow definition not found` });
    return;
  }

  const issue = issueNumber && owner && repo
    ? await refetchIssue(opts.github, owner, repo, issueNumber)
    : { title: "", body: "", labels: [] as string[] };

  // Reconstruct the template context using the bits we stored on creation +
  // refreshed issue data. taskId/branch/issueDir were saved on the original
  // row, fall back to deterministic defaults if the row is older.
  const taskId = (stored.taskId as string | undefined) ??
    workflowScopedTaskId(repo, issueNumber, run.workflowName, run.id);
  const branch = (stored.branch as string | undefined) ??
    (issueNumber
      ? `lastlight/${issueNumber}-${slugify(issue.title || `issue-${issueNumber}`)}`
      : `lastlight/${run.workflowName}`);
  const issueDir = (stored.issueDir as string | undefined)
    ?? (issueNumber ? `.lastlight/issue-${issueNumber}` : `.lastlight/${run.workflowName}`);

  const ctx: TemplateContext = {
    owner,
    repo,
    issueNumber: issueNumber ?? 0,
    issueTitle: issue.title,
    issueBody: issue.body,
    issueLabels: issue.labels,
    commentBody: "",
    sender: "system:resume",
    branch,
    taskId,
    issueDir,
    // Mirror the fresh-dispatch context so a resumed server-mode run keeps
    // externalizing (and linking docs to the dashboard) instead of silently
    // reverting to committing them on the branch.
    externalizeArtifacts: opts.config.buildAssets === "server",
    publicUrl: opts.publicUrl,
    bootstrapLabel: opts.bootstrapLabel || "lastlight:bootstrap",
    contextSnapshot: "",
    // Preserve the original prePopulateBranch so a resumed run still
    // gets its workspace pre-cloned (matters for pr-fix re-entry after
    // an approval gate, where the branch was resolved at first dispatch).
    prePopulateBranch: typeof stored.prePopulateBranch === "string"
      ? stored.prePopulateBranch
      : undefined,
    models: opts.models as unknown as Record<string, unknown>,
    triggerIdOverride: isSlack ? run.triggerId : undefined,
  };

  console.log(
    `[resume] Re-dispatching ${run.workflowName} for ${run.triggerId} (was on phase=${run.currentPhase})`,
  );

  // For Slack-originated runs, post progress to the Slack thread instead
  // of GitHub. The channelId/threadId were stored in context by the
  // original dispatch.
  let slackCallbacks: RunnerCallbacks | null = null;
  if (isSlack && opts.slackPoster) {
    const ch = stored.channelId as string | undefined;
    const th = stored.threadId as string | undefined;
    if (ch && th) {
      const poster = opts.slackPoster;
      slackCallbacks = {
        postComment: async (msg: string) => {
          try { await poster(ch, th, msg); }
          catch (err: unknown) {
            const m = err instanceof Error ? err.message : String(err);
            console.warn(`[resume] Failed to post to Slack thread: ${m}`);
          }
        },
        onPhaseStart: async (phase) => console.log(`[resume] ▶ ${run.workflowName}/${phase}`),
        onPhaseEnd: async (phase, result) =>
          console.log(`[resume] ◀ ${run.workflowName}/${phase}: ${result.success ? "OK" : "FAILED"}`),
      };
    }
  }

  let callbacks: RunnerCallbacks =
    slackCallbacks || makeCallbacks(opts.github, owner, repo, issueNumber, run.workflowName);

  // Re-attach the in-place checklist on GitHub boot-recovery so a run that was
  // mid-flight when the harness died keeps editing its original status comment
  // instead of posting a fresh one. The stored comment id lives in
  // scratch.notifier; completed phases are re-seeded from phase_history.
  // (The Slack boot-recovery path only has a post function here — no
  // chat.update — so it stays on legacy comments.)
  if (!slackCallbacks && definition.status_checklist && opts.github && issueNumber) {
    try {
      const saved = ((run.scratch?.notifier) ?? {}) as NotifierState;
      const github = opts.github;
      const persist = (patch: Partial<NotifierState>) => {
        const cur = ((opts.db.runs.getRun(run.id)?.scratch?.notifier) ?? {}) as NotifierState;
        opts.db.runs.mergeScratch(run.id, { notifier: { ...cur, ...patch } });
      };
      const transport = new GitHubTransport({
        github,
        owner,
        repo,
        issueNumber,
        commentId: saved.githubCommentId,
        save: (id) => persist({ githubCommentId: id }),
      });
      const notifier = new ProgressNotifier([transport]);
      const completed = new Set(run.phaseHistory.map((h) => h.phase));
      await notifier.start(
        buildProgressModel(definition, {
          workflowName: run.workflowName,
          number: issueNumber,
          issueTitle: issue.title,
          owner,
          repo,
          branch,
          completed,
          runUrl: runDashboardUrl(opts.publicUrl, run.id, run.workflowName),
        }),
      );
      callbacks = { ...callbacks, reporter: notifier };
    } catch (err: unknown) {
      const m = err instanceof Error ? err.message : String(err);
      console.warn(`[resume] notifier setup failed: ${m}`);
    }
  }

  // Server mode: tag the config with this run's artifact identity so the
  // executor's stage-in/harvest seam targets the same store path the original
  // dispatch used (issueKey = issueDir minus the `.lastlight/` prefix).
  const runConfig = opts.config.buildAssets === "server"
    ? { ...opts.config, buildAssetsKey: { owner, repo, issueKey: issueDir.replace(/^\.lastlight\//, "") } }
    : opts.config;

  try {
    const result = await runWorkflow(
      definition,
      ctx,
      runConfig,
      callbacks,
      opts.db,
      opts.models,
      opts.approvalConfig,
      run.id,           // <-- key bit: reuse the existing workflow run id
      opts.variants,
    );

    if (result.success) {
      opts.db.runs.finishRun(run.id, "succeeded");
    } else if (!result.paused) {
      opts.db.runs.finishRun(run.id, "failed", {
        error: result.phases.find((p) => !p.success)?.error || "workflow failed during resume",
      });
    }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[resume] ${run.workflowName} resume for ${run.id} threw: ${msg}`);
    opts.db.runs.finishRun(run.id, "failed", { error: `resume threw: ${msg}` });
  }
}

/**
 * Boot-time sweep: find every workflow run that was 'running' when the
 * harness last shut down, mark its in-flight execution rows as stale (the
 * Docker containers were already killed by cleanupOrphanedSandboxes), then
 * re-dispatch each run so the runner can pick up where it left off.
 *
 * 'paused' runs are intentionally left alone — they're waiting for human
 * approval and the dashboard / GitHub comment flow will resume them.
 */
/**
 * Maximum number of times a single workflow run can be resumed after a
 * harness restart. Past this we mark the run failed and stop re-dispatching
 * it, on the theory that a run that crashes the host three times in a row
 * (agent OOM, infinite loop, etc.) needs a human, not another attempt.
 */
const MAX_RESTART_RESUMES = 3;

export async function resumeOrphanedWorkflows(opts: ResumeOptions): Promise<void> {
  const active = opts.db.runs.listActive();
  const orphans = active.filter((r) => r.status === "running");

  if (orphans.length === 0) {
    console.log("[resume] No orphaned workflow runs to recover");
    return;
  }

  console.log(`[resume] Found ${orphans.length} orphaned workflow run(s) — recovering`);

  for (const run of orphans) {
    // Clear any "still running" execution rows so dedup works on resume.
    const cleared = opts.db.executions.markAllStaleForTrigger(
      run.triggerId,
      "stale: harness restarted",
    );
    if (cleared > 0) {
      console.log(`[resume] Cleared ${cleared} stale execution(s) for ${run.triggerId}`);
    }

    // Circuit breaker: bump the per-run restart counter, and if we've now
    // resumed it more than MAX_RESTART_RESUMES times, mark it failed and
    // move on. This is what stops an OOM-on-restart loop from churning
    // forever.
    const attempts = opts.db.runs.incrementRestartCount(run.id);
    if (attempts > MAX_RESTART_RESUMES) {
      const msg = `harness restarted ${attempts - 1}x while this run was active — giving up after ${MAX_RESTART_RESUMES} resume attempts`;
      console.warn(`[resume] ${run.workflowName} run ${run.id}: ${msg}`);
      opts.db.runs.finishRun(run.id, "failed", { error: msg });
      continue;
    }

    // Dispatch in the background — we don't want one slow resume to block
    // the others (or the rest of the boot sequence).
    resumeSimpleRun(run, opts).catch((err) =>
      console.error(`[resume] ${run.workflowName} run ${run.id} crashed:`, err),
    );
  }
}
