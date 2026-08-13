import type { StateDb, WorkflowRun } from "../state/db.js";
import type { ExecutorConfig } from "../engine/github/profiles.js";
import type { GitHubClient } from "../engine/github/github.js";
import type { ModelConfig, VariantConfig } from "../config/config.js";
import { runWorkflow, type ApprovalGateConfig, type RunnerCallbacks } from "./runner.js";
import { getWorkflow } from "./loader.js";
import {
  restoreRepoRunConfig,
  workflowScopedTaskId,
  type RepoConfigRunRecord,
  type RunRepoConfig,
} from "./simple.js";
import { slugify, type TemplateContext } from "./templates.js";
import { harvestFixMarkers } from "../engine/fix-harvest.js";
import {
  ProgressNotifier,
  GitHubTransport,
  buildProgressModel,
  runDashboardUrl,
  type NotifierState,
} from "../notify/index.js";
import { logger } from "../logging/logger.js";
import { logPhaseEnd } from "../logging/phase-log.js";

const log = logger("resume");

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
    log.warn("Could not refetch issue", { repo: `${owner}/${repo}`, issueNumber, err });
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
  db: StateDb,
  runId: string,
): RunnerCallbacks {
  return {
    postComment: github && issueNumber
      ? async (msg: string) => {
          try {
            await github.postComment(owner, repo, issueNumber, msg);
          } catch (err: unknown) {
            log.warn("Failed to post comment", { err });
          }
        }
      : undefined,
    onPhaseStart: async (phase) => log.info("Phase start", { workflowName, phase }),
    onPhaseEnd: async (phase, result) => {
      logPhaseEnd(log, workflowName, phase, result);
      // The marker harvest has to be wired on the RESUME paths too, not only on
      // the fresh dispatch in `index.ts`. A fix run that paused for an approval
      // gate or was picked back up after a harness restart completes its
      // `diagnose`/`fix` phases HERE — harvesting only in `index.ts` would lose
      // every marker on exactly the runs whose attempt counter matters most.
      harvestFixMarkers(db, runId, workflowName, phase, result.output);
    },
  };
}

/** A JSON-decoded `Record<string, string>` off a run row, or undefined. */
function storedStringMap(value: unknown): Record<string, string> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const out: Record<string, string> = {};
  for (const [key, v] of Object.entries(value)) if (typeof v === "string") out[key] = v;
  return Object.keys(out).length > 0 ? out : undefined;
}

/** The persisted repo-config record, if the row has a well-formed one. */
function storedRepoConfigRecord(stored: Record<string, unknown>): RepoConfigRunRecord | undefined {
  const record = stored.repoConfig as RepoConfigRunRecord | undefined;
  if (!record || typeof record !== "object") return undefined;
  if (typeof record.repo !== "string" || typeof record.treeSha !== "string") return undefined;
  return { ...record, assets: record.assets ?? [], warnings: record.warnings ?? [] };
}

/** The effective config a resumed run continues under. */
interface ResumedRunConfig {
  models?: ModelConfig;
  variants?: VariantConfig;
  approval?: ApprovalGateConfig;
  repoConfig?: RunRepoConfig;
}

/**
 * The effective (base ⊕ repo) config for a run being CONTINUED (issue #180).
 *
 * A resume is not a new dispatch: `resumeSimpleRun` re-enters a run that has
 * already executed phases, and those phases used the models, variants, gates and
 * assets resolved at its FIRST dispatch. So we reuse what that dispatch
 * persisted — `context.models` / `context.variants` (already the effective maps)
 * and `context.repoConfig` (the repo layer, pinned by tree sha) — instead of
 * re-resolving from the repo's default branch. Re-resolving would let an edit
 * made while the run was paused, queued or dead retarget it mid-flight, so half
 * a build ran on one model and half on another; it would also mean a network
 * round-trip on every boot-recovery sweep.
 *
 * The one thing that genuinely can't be pinned is the unpacked ASSET root (a
 * cache path — see `restoreRepoRunConfig`): when the tree the run used is gone,
 * the layer degrades to the operator's assets with a warning recorded on the
 * run, never a crash and never a silent swap to whatever the repo says today.
 *
 * Falls back to the operator's boot maps for rows written before any of this was
 * persisted, which is byte-identical to the pre-issue-#180 resume path.
 */
async function resumedRunConfig(run: WorkflowRun, opts: ResumeOptions): Promise<ResumedRunConfig> {
  const stored = (run.context || {}) as Record<string, unknown>;
  const models = (storedStringMap(stored.models) as ModelConfig | undefined) ?? opts.models;
  const variants = (storedStringMap(stored.variants) as VariantConfig | undefined) ?? opts.variants;
  const base: ResumedRunConfig = { models, variants, approval: opts.approvalConfig };

  const record = storedRepoConfigRecord(stored);
  if (!record) return base;

  try {
    const { repoConfig, warning } = await restoreRepoRunConfig(record, {
      models,
      variants,
      approval: opts.approvalConfig,
    });
    if (warning) {
      // Recorded on the run so "why did this resumed run ignore the repo's
      // prompt?" is answerable from the row alone. `mergeScratch` replaces the
      // whole `repoConfig` node, but the two writers can't collide: this one
      // only fires when the asset layer was DROPPED, and the runner's
      // `assetWarnings` only when it was applied.
      try {
        opts.db.runs.mergeScratch(run.id, { repoConfig: { restoreWarnings: [warning] } });
      } catch (err: unknown) {
        log.warn("Could not record the repo-config restore warning", { runId: run.id, err });
      }
    }
    return {
      models: repoConfig.models,
      variants: repoConfig.variants,
      approval: repoConfig.approval,
      repoConfig,
    };
  } catch (err: unknown) {
    // The repo-config failure rule: warn, drop the layer, run anyway.
    log.warn("Could not restore the repo config", { repo: record.repo, runId: run.id, err });
    return base;
  }
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
  // Slack-originated runs fall back to the row's own (owner, BARE repo) pair,
  // then to context.owner for a row whose owner column was never captured.
  // Both halves are bare here — `repo` feeds Octokit AND `workflowScopedTaskId`
  // below, which builds a filesystem path out of it.
  const parsed = parseTriggerId(run.triggerId);
  const owner = parsed?.owner ?? run.owner ?? (stored.owner as string | undefined) ?? "";
  const repo = parsed?.repo ?? run.repo ?? "";
  const issueNumber = run.issueNumber;
  const isSlack = run.triggerId.startsWith("slack:");

  if (!owner && !repo && !isSlack) {
    log.warn("Skipping — cannot derive owner/repo from triggerId", { runId: run.id, triggerId: run.triggerId });
    return;
  }

  let definition;
  try {
    definition = getWorkflow(run.workflowName);
  } catch (err) {
    log.warn("Skipping — workflow definition not found", { runId: run.id, workflowName: run.workflowName, err });
    opts.db.runs.finishRun(run.id, "failed", { error: `harness restarted; workflow definition not found` });
    return;
  }

  const issue = issueNumber && owner && repo
    ? await refetchIssue(opts.github, owner, repo, issueNumber)
    : { title: "", body: "", labels: [] as string[] };

  // What this run has been executing under all along — its own effective models,
  // variants, gates and repo asset layer, not whatever the operator/repo config
  // says right now. See `resumedRunConfig`.
  const effective = await resumedRunConfig(run, opts);

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
    // EFFECTIVE maps — the repo layer this run started under is already folded
    // in, so `{{models.<phase>}}` renders exactly what the first dispatch did.
    models: effective.models as unknown as Record<string, unknown>,
    triggerIdOverride: isSlack ? run.triggerId : undefined,
  };

  log.info("Re-dispatching", {
    workflowName: run.workflowName,
    triggerId: run.triggerId,
    currentPhase: run.currentPhase,
  });

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
            log.warn("Failed to post to Slack thread", { err });
          }
        },
        onPhaseStart: async (phase) => log.info("Phase start", { workflowName: run.workflowName, phase }),
        onPhaseEnd: async (phase, result) => {
          logPhaseEnd(log, run.workflowName, phase, result);
          harvestFixMarkers(opts.db, run.id, run.workflowName, phase, result.output);
        },
      };
    }
  }

  let callbacks: RunnerCallbacks =
    slackCallbacks ||
    makeCallbacks(opts.github, owner, repo, issueNumber, run.workflowName, opts.db, run.id);

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
      log.warn("Notifier setup failed", { err });
    }
  }

  // Server mode: tag the config with this run's artifact identity so the
  // executor's stage-in/harvest seam targets the same store path the original
  // dispatch used. issueKey strips the artifact prefix off the stored issueDir
  // — which may be relocated (`../.lastlight/<key>`, docs at the workspace
  // root) or in-repo (`.lastlight/<key>`); `buildAssetsRelocated` reads that
  // decision back so the resumed run stages/harvests in the same place.
  const runConfig = opts.config.buildAssets === "server"
    ? {
        ...opts.config,
        buildAssetsKey: { owner, repo, issueKey: issueDir.replace(/^(\.\.\/)?\.lastlight\//, "") },
        buildAssetsRelocated: issueDir.startsWith("../"),
      }
    : opts.config;

  try {
    const result = await runWorkflow(
      definition,
      ctx,
      runConfig,
      callbacks,
      opts.db,
      effective.models,
      effective.approval,
      run.id,           // <-- key bit: reuse the existing workflow run id
      effective.variants,
      // 10th arg: the repo layer, restored from the run row rather than
      // re-resolved, so a resumed run keeps the prompts/skills/agent-context
      // (and the models above) it started with.
      effective.repoConfig,
    );

    if (result.success) {
      opts.db.runs.finishRun(run.id, "succeeded");
    } else if (result.backpressure) {
      // Same backpressure requeue as the fresh-dispatch path: a promoted run
      // that re-hits the quota goes back to `queued` for the next admission tick.
      opts.db.runs.requeueRunning(run.id);
      log.info("Requeued — cluster at capacity", { workflowName: run.workflowName, runId: run.id });
    } else if (!result.paused) {
      opts.db.runs.finishRun(run.id, "failed", {
        error: result.phases.find((p) => !p.success)?.error || "workflow failed during resume",
      });
    }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error("Resume threw", { workflowName: run.workflowName, runId: run.id, err });
    opts.db.runs.finishRun(run.id, "failed", { error: `resume threw: ${msg}` });
  }
}

/**
 * Boot-time sweep: find every workflow run that was 'running' when the
 * harness last shut down, mark its in-flight execution rows as stale (the
 * Docker containers were already killed by cleanupOrphanedSandboxes), then
 * re-dispatch each run so the runner can pick up where it left off.
 *
 * 'queued' runs are re-stamped with a fresh enqueue clock (not dispatched) so
 * the AdmissionController promotes them as slots free, instead of the TTL sweep
 * instantly reaping their stale `started_at` to a non-retryable 'cancelled'.
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

  // Queued orphans: a run that was still `queued` (waiting on the concurrency
  // cap) when the harness died carries a stale `started_at`, so the admission
  // TTL sweep would immediately expire it to the non-retryable `cancelled`
  // state on the next tick. Re-stamp its enqueue clock so the AdmissionController
  // admits it normally as slots free — the work survives a server death instead
  // of being silently dropped. No dispatch here; admission owns promotion.
  const queued = active.filter((r) => r.status === "queued");
  if (queued.length > 0) {
    let requeued = 0;
    for (const run of queued) {
      requeued += opts.db.runs.requeue(run.id);
    }
    log.info("Refreshed queue clock for queued orphan(s) — admission will promote them", { requeued });
  }

  const orphans = active.filter((r) => r.status === "running");

  if (orphans.length === 0) {
    log.info("No orphaned running workflow runs to recover");
    return;
  }

  log.info("Found orphaned running workflow run(s) — recovering", { count: orphans.length });

  for (const run of orphans) {
    // Clear any "still running" execution rows so dedup works on resume.
    const cleared = opts.db.executions.markAllStaleForTrigger(
      run.triggerId,
      "stale: harness restarted",
    );
    if (cleared > 0) {
      log.info("Cleared stale execution(s)", { triggerId: run.triggerId, cleared });
    }

    // Circuit breaker: bump the per-run restart counter, and if we've now
    // resumed it more than MAX_RESTART_RESUMES times, mark it failed and
    // move on. This is what stops an OOM-on-restart loop from churning
    // forever.
    const attempts = opts.db.runs.incrementRestartCount(run.id);
    if (attempts > MAX_RESTART_RESUMES) {
      const msg = `harness restarted ${attempts - 1}x while this run was active — giving up after ${MAX_RESTART_RESUMES} resume attempts`;
      log.warn(msg, { workflowName: run.workflowName, runId: run.id });
      opts.db.runs.finishRun(run.id, "failed", { error: msg });
      continue;
    }

    // Dispatch in the background — we don't want one slow resume to block
    // the others (or the rest of the boot sequence).
    resumeSimpleRun(run, opts).catch((err) =>
      log.error("Crashed during resume", { workflowName: run.workflowName, runId: run.id, err }),
    );
  }
}
