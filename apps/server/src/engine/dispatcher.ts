import { randomUUID } from "crypto";
import type { EventEnvelope } from "../connectors/types.js";
import type { SessionManager } from "../connectors/index.js";
import type { StateDb } from "../state/db.js";
import type { GitHubClient } from "./github/github.js";
import type { ChatResult } from "./chat/chat.js";
import { routeEvent, type Route, type RouterDeps } from "./router.js";
import { runDashboardUrl } from "../notify/model.js";
import { getRuntimeConfig } from "../config/config.js";
import { PR_FIX_SHAPED_WORKFLOWS, DEPENDENCY_WEBHOOK_WORKFLOWS } from "../workflows/target-policy.js";
import { REQUIRES_HUMAN_LABEL } from "../cron/dependabot-discovery.js";

/**
 * Hand a workflow to the runner. Matches `dispatchWorkflow` in index.ts — the
 * dispatcher names workflows and accumulates their outcome but owns none of the
 * sandbox/runner plumbing.
 */
export type DispatchWorkflowFn = (
  workflowName: string,
  context: Record<string, unknown>,
  onRunStart?: (runId: string) => Promise<void>,
) => Promise<{ success: boolean; error?: string; paused?: boolean; queued?: boolean }>;

/** Run one in-process chat turn. Injected so the chat branch is testable. */
export type RunChatFn = (
  message: string,
  messagingSessionId: string,
  sender: string,
  resumeAgentSessionId: string | undefined,
) => Promise<ChatResult>;

/**
 * Everything the dispatcher needs, bundled so `main()` constructs it once and
 * hands it over. `route` defaults to `routeEvent` but is injectable so a
 * branch test names the exact Route it wants without mocking the classifier.
 */
export interface DispatchDeps {
  db: StateDb;
  github: GitHubClient | null;
  dispatchWorkflow: DispatchWorkflowFn;
  sessionManager: SessionManager;
  runChat: RunChatFn;
  route?: (envelope: EventEnvelope, deps: RouterDeps) => Promise<Route>;
  reviewPostsCheck: boolean;
  publicUrl?: string;
}

/**
 * The typed result of dispatching one event. Handlers return an outcome rather
 * than only producing side effects, so each branch is assertable through the
 * single `dispatch` seam.
 */
export type DispatchOutcome =
  | { kind: "ignored"; reason: string }
  | { kind: "replied"; message: string }
  | { kind: "skipped"; reason: string }
  | { kind: "handled"; handler: string }
  | { kind: "dispatched"; workflow: string }
  /**
   * The workflow was accepted but queued (concurrency cap reached). The
   * persisted `queued` row is the reliable signal — this outcome is only
   * observable on paths that await the dispatch promise (e.g. handleBuild).
   * Fire-and-forget webhook paths return `dispatched` before the promise
   * resolves, so they never see this variant synchronously.
   */
  | { kind: "queued"; workflow: string };

/**
 * Turn an EventEnvelope into a workflow dispatch (or an in-process handler
 * run). Classifies via `route`, then acts on the decision. Extracted from the
 * former `registry.onEvent` closure so every event branch is testable.
 */
export async function dispatch(
  envelope: EventEnvelope,
  deps: DispatchDeps,
): Promise<DispatchOutcome> {
  const route = await (deps.route ?? routeEvent)(envelope, { db: deps.db, github: deps.github });

  if (route.action === "ignore") {
    return { kind: "ignored", reason: route.reason };
  }

  if (route.action === "reply") {
    await envelope.reply(route.message);
    return { kind: "replied", message: route.message };
  }

  // route.action === "handler"
  const { handler, context } = route;
  const routeKey = typeof context._routeKey === "string" ? context._routeKey : undefined;

  // Instant ack: the moment we've classified a GitHub event as something we'll
  // act on, react 👀 on the triggering comment/issue so the user sees feedback
  // before any (slower) workflow output lands. Covers every github-based path —
  // issue/PR comments, review comments, opened issues/PRs — and every explore
  // socratic reply (each arrives here as its own comment.created → explore-reply).
  // Fire-and-forget; the build path additionally reacts 🚀 when it starts.
  ackGithubEvent(envelope, deps.github);

  // Chat messages: handle in-process (no sandbox, low latency).
  if (handler === "chat") {
    return handleChat(envelope, context, deps);
  }

  // Chat reset: deactivate the session and confirm.
  if (handler === "chat-reset") {
    const sessionId = context.sessionId as string | undefined;
    if (sessionId) {
      deps.sessionManager.deactivateSession(sessionId);
    }
    await envelope.reply("Session reset. Starting fresh.");
    return { kind: "handled", handler };
  }

  // Status report: list running executions.
  if (handler === "status-report") {
    const running = deps.db.executions.runningExecutions();
    if (running.length === 0) {
      await envelope.reply("No tasks currently running.");
    } else {
      const lines = running.map((r) =>
        `• *${r.skill}*${r.repo ? ` on ${r.repo}` : ""}${r.issueNumber ? ` #${r.issueNumber}` : ""} (started ${r.startedAt})`,
      );
      await envelope.reply(`Running tasks:\n${lines.join("\n")}`);
    }
    return { kind: "handled", handler };
  }

  // Guard against double-dispatching the same work. Everything past this
  // point is a workflow dispatch (or a resume of one), so a run already in
  // flight for this trigger is a no-op.
  const triggerId = String(envelope.issueNumber || envelope.id);
  if (deps.db.executions.isRunning(handler, triggerId)) {
    console.log(`[event] Skipping: ${handler} already running for ${triggerId}`);
    if (envelope.type === "message") {
      await envelope.reply(`That task is already running. Use /status to check progress.`);
    }
    return { kind: "skipped", reason: `${handler} already running for ${triggerId}` };
  }

  // Dependency-PR idempotency: on the AUTOMATED check_suite webhook path, skip
  // (before any sandbox) a PR the bot has already handled — one carrying
  // `requires-human`, or one whose current head SHA we already assessed. A
  // multi-app repo re-fires a green/red suite and the daily cron overlaps, so
  // without this the same PR gets re-assessed repeatedly, burning tokens and
  // flooding the queue. A genuinely new push (new head SHA, no requires-human)
  // still runs once; a human `@bot` request (comment.created) is NOT gated.
  if (
    (envelope.type === "pr.checks_passed" || envelope.type === "pr.checks_failed") &&
    DEPENDENCY_WEBHOOK_WORKFLOWS.has(handler)
  ) {
    const skip = await dependencyDedupSkip(handler, context, deps);
    if (skip) {
      console.log(`[event] Skipping: ${skip.reason}`);
      return skip;
    }
  }

  // PR fix: lightweight fix-and-push driven by CI failures / a comment. Also
  // covers pr-fix-shaped workflows (e.g. dependabot-ci-fix) reached via the
  // classifier — they all need the PR head branch + failed-check summary that
  // handlePrFix resolves, and it dispatches the passed `handler` unchanged.
  if (
    (routeKey === "github.pr_fix" || PR_FIX_SHAPED_WORKFLOWS.has(handler)) &&
    context.prNumber &&
    context.repo
  ) {
    return handlePrFix(context, handler, deps);
  }

  if (handler === "explore-reply") {
    return handleExploreReply(envelope, context, deps);
  }

  if (handler === "approval-response") {
    return handleApprovalResponse(envelope, context, deps);
  }

  // Build requests → the programmatic orchestrator (the `build` workflow).
  if (
    (routeKey === "github.issue_build" || routeKey === "slack.build" || handler === "github-orchestrator") &&
    context.issueNumber &&
    context.repo
  ) {
    return handleBuild(envelope, context, handler, deps);
  }

  // The workflow context is the route context minus the internal _routeKey.
  const { _routeKey: _ignored, ...workflowContext } = context;

  // Messaging-triggered workflows: ack on start, report on completion.
  if (envelope.type === "message") {
    return handleMessageDispatch(envelope, handler, workflowContext, deps);
  }

  // Webhook-triggered workflows (the remaining default path).
  return handleWebhookDispatch(envelope, handler, routeKey, workflowContext, deps);
}

/**
 * Pre-sandbox idempotency check for a dependency-PR webhook. One cheap PR read
 * yields two skip signals:
 *   • the PR carries `requires-human` → a maintainer owns it; do nothing.
 *   • the PR's live head SHA equals the SHA of the last SUCCEEDED run of this
 *     workflow for the PR → there's nothing new to assess (a re-fired suite,
 *     cron/webhook overlap).
 * Returns a `skipped` outcome to short-circuit, or null to let the run proceed.
 * A read failure returns null (fail-open) — the workflow's own `ASSESSMENT_COMPLETE`
 * marker + the LLM "skip if already commented" instruction remain as backstops,
 * and we'd rather occasionally re-run than drop a genuine event.
 */
async function dependencyDedupSkip(
  handler: string,
  context: Record<string, unknown>,
  deps: DispatchDeps,
): Promise<{ kind: "skipped"; reason: string } | null> {
  const github = deps.github;
  const repoStr = typeof context.repo === "string" ? context.repo : undefined;
  const prNumber = typeof context.prNumber === "number" ? context.prNumber : undefined;
  if (!github || !repoStr || !prNumber) return null;
  const [owner, name] = repoStr.split("/");
  if (!owner || !name) return null;

  let pr: Awaited<ReturnType<GitHubClient["getPullRequest"]>>;
  try {
    pr = await github.getPullRequest(owner, name, prNumber);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[dispatch] dependency dedup read failed for ${repoStr}#${prNumber}: ${msg}`);
    return null;
  }

  const labels = (pr.labels ?? [])
    .map((l) => (typeof l === "string" ? l : l?.name ?? ""))
    .filter(Boolean);
  if (labels.includes(REQUIRES_HUMAN_LABEL)) {
    return { kind: "skipped", reason: `${handler}: ${repoStr}#${prNumber} is ${REQUIRES_HUMAN_LABEL}` };
  }

  const headSha = pr.head?.sha;
  const triggerId = `${repoStr}#${prNumber}`;
  const lastRun = deps.db.runs.latestSucceededForTrigger(handler, triggerId);
  const lastSha = (lastRun?.context as Record<string, unknown> | undefined)?.headSha;
  if (headSha && typeof lastSha === "string" && headSha === lastSha) {
    return {
      kind: "skipped",
      reason: `${handler}: already assessed ${repoStr}#${prNumber} at ${headSha.slice(0, 7)}`,
    };
  }
  return null;
}

/**
 * React 👀 on the GitHub subject that triggered this event, as an immediate
 * "I've seen it and I'm acting on it" ack. Picks the right reactions endpoint
 * by event type: issue/PR comments and explore replies → the comment; PR review
 * comments → the review comment; freshly opened/reopened issues & PRs → the
 * issue/PR itself. Non-GitHub events (Slack) and events with no clear subject
 * (e.g. pr.synchronize) are skipped. Fire-and-forget — a failed reaction never
 * blocks dispatch.
 */
function ackGithubEvent(envelope: EventEnvelope, github: GitHubClient | null): void {
  if (!github || envelope.source !== "github" || !envelope.repo) return;
  const [owner, repo] = envelope.repo.split("/");
  if (!owner || !repo) return;
  const raw = envelope.raw as { comment?: { id?: number } } | undefined;
  const commentId = raw?.comment?.id;

  const fail = (err: unknown) => {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[event] Could not react 👀 to ${envelope.type}: ${msg}`);
  };

  switch (envelope.type) {
    case "comment.created":
      if (commentId) github.reactToComment(owner, repo, commentId, "eyes").catch(fail);
      break;
    case "pr_review_comment.created":
      if (commentId) github.reactToReviewComment(owner, repo, commentId, "eyes").catch(fail);
      break;
    case "issue.opened":
    case "issue.reopened":
    case "pr.opened":
    case "pr.reopened":
      if (envelope.issueNumber) github.reactToIssue(owner, repo, envelope.issueNumber, "eyes").catch(fail);
      break;
    default:
      // pr.synchronize, pr.merged, pr_review.submitted, etc. — no single
      // user-authored subject to ack, so stay quiet.
      break;
  }
}

/**
 * Messaging-triggered workflow dispatch. Posts a "Starting *<handler>*" ack
 * once the run row exists (with a dashboard deep link when `publicUrl` is set),
 * then reports completion / failure back to the thread. Paused runs stay quiet
 * — the workflow already posted gate instructions.
 */
async function handleMessageDispatch(
  envelope: EventEnvelope,
  handler: string,
  workflowContext: Record<string, unknown>,
  deps: DispatchDeps,
): Promise<DispatchOutcome> {
  const onRunStart = async (runId: string) => {
    // The run detail lives on the `runs` tab (WorkflowList reads ?run=…&phase=…);
    // `workflows` is the definition browser and ignores ?run=, so the deep link
    // must target `runs`. Shared by every messaging-dispatched workflow
    // (build / explore / triage / answer / …).
    const link = runDashboardUrl(deps.publicUrl, runId, handler);
    const body = link
      ? `Starting *${handler}*... I'll report back when it's done.\n<${link}|Live progress>`
      : `Starting *${handler}*... I'll report back when it's done.`;
    try {
      await envelope.reply(body);
    } catch (err: unknown) {
      const m = err instanceof Error ? err.message : String(err);
      console.warn(`[event] failed to post run-start ack: ${m}`);
    }
  };

  deps.dispatchWorkflow(handler, { ...workflowContext, _triggerType: "chat" }, onRunStart)
    .then(async (result) => {
      if (result.queued) {
        // Queued — the enqueue ack was already posted by runSimpleWorkflow.
      } else if (result.paused) {
        // Paused at a gate — the workflow already posted instructions.
      } else if (result.success) {
        await envelope.reply(`*${handler}* completed.`);
      } else {
        await envelope.reply(`*${handler}* failed${result.error ? `: ${result.error}` : ""}.`);
      }
    })
    .catch(async (err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[event] workflow ${handler} threw: ${msg}`);
      await envelope.reply(`*${handler}* failed: ${msg}`);
    });

  return { kind: "dispatched", workflow: handler };
}

/**
 * Webhook-triggered workflow dispatch. When `reviewPostsCheck` is on and this
 * is a PR-attention event routed to pr-review, posts an in-progress
 * `last-light/review` Check Run on the PR head SHA so branch protection can
 * gate the merge, then completes it from the workflow's terminal result.
 */
async function handleWebhookDispatch(
  envelope: EventEnvelope,
  handler: string,
  routeKey: string | undefined,
  workflowContext: Record<string, unknown>,
  deps: DispatchDeps,
): Promise<DispatchOutcome> {
  const { github } = deps;
  const isPrReviewEvent =
    envelope.type === "pr.opened" ||
    envelope.type === "pr.synchronize" ||
    envelope.type === "pr.reopened";
  const wantReviewCheck =
    deps.reviewPostsCheck &&
    isPrReviewEvent &&
    (routeKey === "github.pr_opened" ||
      routeKey === "github.pr_synchronize" ||
      routeKey === "github.pr_reopened" ||
      handler === "pr-review") &&
    !!github &&
    !!envelope.repo &&
    typeof envelope.prNumber === "number";

  let prCheckRunId: number | undefined;
  let prOwner = "";
  let prRepoName = "";
  let prNumberForCheck = 0;
  if (wantReviewCheck && github) {
    [prOwner, prRepoName] = envelope.repo!.split("/");
    prNumberForCheck = envelope.prNumber as number;
    try {
      const prHeadSha = await github.getPullRequestHeadSha(prOwner, prRepoName, prNumberForCheck);
      prCheckRunId = await github.createCheckRun(prOwner, prRepoName, prHeadSha, "last-light/review", {
        output: {
          title: "Review in progress",
          summary:
            "Last Light is reviewing this PR. The conclusion will land here when the review completes.",
        },
      });
      console.log(
        `[check] Posted in-progress check ${prCheckRunId} for ${prOwner}/${prRepoName}#${prNumberForCheck} on ${prHeadSha.slice(0, 7)}`,
      );
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[check] failed to create in-progress check: ${msg}`);
    }
  }

  // As soon as the run row exists, point the in-progress check at its dashboard
  // deep link so a reviewer can click the check's "Details" straight through to
  // the live run. Best-effort + only when the check and a public URL both exist.
  const onRunStart = async (runId: string) => {
    if (prCheckRunId === undefined || !github) return;
    const detailsUrl = runDashboardUrl(deps.publicUrl, runId, handler);
    if (!detailsUrl) return;
    try {
      await github.updateCheckRun(prOwner, prRepoName, prCheckRunId, { detailsUrl });
      console.log(`[check] linked check ${prCheckRunId} → ${detailsUrl}`);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[check] failed to set details_url on check ${prCheckRunId}: ${msg}`);
    }
  };
  const workflowPromise = deps.dispatchWorkflow(
    handler,
    { ...workflowContext, _triggerType: "webhook" },
    onRunStart,
  );

  if (prCheckRunId !== undefined && github) {
    const checkId = prCheckRunId;
    const owner = prOwner;
    const repo = prRepoName;
    const prNumber = prNumberForCheck;
    workflowPromise
      .then(async (result) => {
        // Queued: the run hasn't started yet — leave the in-progress check as-is
        // rather than completing it with a misleading conclusion. The admission
        // path's resume will run the full workflow and the terminal review
        // comment will eventually update the PR. (Documented limitation: the
        // check stays in-progress until admission fires.)
        if (result.queued) return;
        try {
          // Re-fetch head SHA in case the PR was rebased mid-review.
          const headSha = await github.getPullRequestHeadSha(owner, repo, prNumber);
          const review = await github.getLatestBotReview(owner, repo, prNumber, headSha, getRuntimeConfig()?.botLogin);
          const conclusion: "success" | "failure" | "neutral" = !result.success
            ? "neutral"
            : review?.state === "APPROVED"
            ? "success"
            : review?.state === "CHANGES_REQUESTED"
            ? "failure"
            : "neutral";
          await github.updateCheckRun(owner, repo, checkId, {
            status: "completed",
            conclusion,
            output: {
              title: `Review ${conclusion === "success" ? "approved" : conclusion === "failure" ? "requested changes" : "completed"}`,
              summary: review?.body?.slice(0, 65000) || "Review complete.",
            },
          });
          console.log(`[check] Completed check ${checkId} → ${conclusion}`);
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          console.warn(`[check] failed to complete check ${checkId}: ${msg}`);
        }
      })
      .catch(async (err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err);
        try {
          await github.updateCheckRun(owner, repo, checkId, {
            status: "completed",
            conclusion: "neutral",
            output: { title: "Review errored", summary: `Workflow threw: ${msg.slice(0, 1000)}` },
          });
        } catch {
          /* ignore — best effort */
        }
      });
  }

  workflowPromise.catch((err: unknown) => {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[event] Unhandled error in workflow ${handler}: ${msg}`);
  });

  return { kind: "dispatched", workflow: handler };
}

/**
 * Kick off the full build cycle for an issue. Fills in missing issue details
 * from the API, records a `build-cycle` execution row, acks the requester
 * (Slack reply or a 🚀 reaction on the trigger comment), then dispatches the
 * `build` workflow asynchronously.
 */
async function handleBuild(
  envelope: EventEnvelope,
  context: Record<string, unknown>,
  handler: string,
  deps: DispatchDeps,
): Promise<DispatchOutcome> {
  const repoStr = context.repo as string;
  const [owner, repo] = repoStr.includes("/") ? repoStr.split("/") : ["", repoStr];
  const issueNumber = context.issueNumber as number;

  if (!owner || !repo) {
    console.error(`[event] Invalid repo format: ${repoStr}`);
    return { kind: "ignored", reason: `invalid repo format: ${repoStr}` };
  }

  // Fetch full issue details if we don't have them.
  let issueTitle = (context.title as string) || "";
  let issueBody = (context.body as string) || "";
  let issueLabels: string[] = (context.labels as string[]) || [];
  if (deps.github && (!issueTitle || !issueBody || issueLabels.length === 0)) {
    try {
      const issue = await deps.github.getIssue(owner, repo, issueNumber);
      issueTitle = issueTitle || issue.title;
      issueBody = issueBody || issue.body || "";
      if (issueLabels.length === 0) {
        issueLabels = (issue.labels || [])
          .map((l: any) => (typeof l === "string" ? l : l.name))
          .filter(Boolean);
      }
    } catch (err: any) {
      console.warn(`[event] Could not fetch issue: ${err.message}`);
    }
  }

  const executionId = randomUUID();
  deps.db.executions.recordStart({
    id: executionId,
    triggerType: envelope.type === "message" ? "chat" : "webhook",
    triggerId: String(issueNumber),
    skill: "build-cycle",
    repo: repoStr,
    issueNumber,
    startedAt: new Date().toISOString(),
    // Actor logging (issue #205): who fired this build.
    triggeredBy: (context.sender as string) || undefined,
    triggerActorType: envelope.type === "message" ? "slack" : "github",
  });

  if (envelope.type === "message") {
    await envelope.reply(`Starting build cycle for ${repoStr}#${issueNumber}...`);
  } else if (deps.github) {
    // GitHub-triggered builds: react with 🚀 on the triggering comment so the
    // user sees an instant ack. Non-fatal if it fails.
    const commentId = (envelope.raw as { comment?: { id?: number } } | undefined)?.comment?.id;
    if (commentId) {
      deps.github.reactToComment(owner, repo, commentId, "rocket").catch((err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(`[event] Could not react to trigger comment: ${msg}`);
      });
    }
  }

  const buildWorkflow = handler === "github-orchestrator" ? "build" : handler;
  deps.dispatchWorkflow(buildWorkflow, {
    repo: repoStr,
    issueNumber,
    title: issueTitle || `Issue #${issueNumber}`,
    body: issueBody,
    labels: issueLabels,
    commentBody: context.commentBody as string,
    sender: (context.sender as string) || "unknown",
    _triggerType: envelope.type === "message" ? "chat" : "webhook",
  }).then((result) => {
    deps.db.executions.recordFinish(executionId, {
      success: result.success,
      error: result.success ? undefined : "Build cycle failed",
      durationMs: 0,
    });
    if (!result.queued && envelope.type === "message") {
      envelope.reply(result.success ? `Build cycle complete.` : `Build cycle failed.`);
    }
  }).catch((err) => {
    console.error(`[event] Build cycle failed:`, err);
    deps.db.executions.recordFinish(executionId, { success: false, error: err.message, durationMs: 0 });
  });

  return { kind: "dispatched", workflow: buildWorkflow };
}

/**
 * Lightweight PR fix — fix-and-push, no full build cycle. Resolves the PR's
 * head branch and CI failures (needed by the architect/executor), then
 * dispatches the `pr-fix` workflow. Bails if the branch can't be determined.
 */
async function handlePrFix(
  context: Record<string, unknown>,
  handler: string,
  deps: DispatchDeps,
): Promise<DispatchOutcome> {
  const repoStr = context.repo as string;
  const [owner, repo] = repoStr.includes("/") ? repoStr.split("/") : ["", repoStr];
  const prNumber = context.prNumber as number;

  if (!owner || !repo) {
    console.error(`[event] Invalid repo format: ${repoStr}`);
    return { kind: "ignored", reason: `invalid repo format: ${repoStr}` };
  }

  let prTitle = (context.title as string) || "";
  let prBody = (context.body as string) || "";
  let branch = "";
  let failedChecks = "";
  let isForkPr = false;
  let headRepoFullName: string | null = null;
  if (deps.github) {
    try {
      const pr = await deps.github.getPullRequest(owner, repo, prNumber);
      prTitle = prTitle || pr.title;
      prBody = prBody || pr.body || "";
      branch = pr.head.ref;
      // Cross-repo (fork) PR detection. A fork PR's head branch lives on
      // another repo we have no write access to, and its head ref isn't on
      // this repo's origin — so there's nothing for pr-fix to clone or push
      // to. Bail here, before any sandbox is provisioned. `head.repo` is null
      // when the source fork was deleted; treat that as a fork too (the branch
      // is gone either way).
      headRepoFullName = pr.head.repo?.full_name ?? null;
      const baseRepoFullName = pr.base.repo?.full_name ?? `${owner}/${repo}`;
      isForkPr = headRepoFullName === null || headRepoFullName !== baseRepoFullName;
      failedChecks = await deps.github.getFailedChecks(owner, repo, pr.head.sha);
    } catch (err: any) {
      console.warn(`[event] Could not fetch PR: ${err.message}`);
    }
  }

  if (isForkPr) {
    console.log(
      `[event] pr-fix skipped: PR #${prNumber} is a fork PR ` +
      `(head ${headRepoFullName ?? "deleted fork"} ≠ base ${owner}/${repo})`,
    );
    if (deps.github) {
      const source = headRepoFullName ? `from \`${headRepoFullName}\`` : "from a now-deleted fork";
      await deps.github
        .postComment(
          owner,
          repo,
          prNumber,
          `I can't apply fixes to this PR — it comes ${source}, and I have no write access to the ` +
          `source branch (nor is its head ref on \`${owner}/${repo}\`). Re-create the change on a ` +
          `branch in \`${owner}/${repo}\` and I'll fix it there.`,
        )
        .catch((e: unknown) =>
          console.warn(`[event] fork-PR notice comment failed: ${e instanceof Error ? e.message : String(e)}`),
        );
    }
    return { kind: "ignored", reason: `pr-fix not supported for fork PR #${prNumber}` };
  }

  if (!branch) {
    console.error(`[event] Could not determine branch for PR #${prNumber}`);
    return { kind: "ignored", reason: `could not determine branch for PR #${prNumber}` };
  }

  console.log(`[event] PR fix for ${repoStr}#${prNumber} on branch ${branch}`);
  const ciSection = failedChecks && !failedChecks.includes("No failed checks")
    ? `CI FAILURES (from GitHub Actions — fix these first):\n${failedChecks}`
    : "";

  deps.dispatchWorkflow(handler, {
    repo: repoStr,
    prNumber,
    title: prTitle,
    body: prBody,
    commentBody: (context.commentBody as string) || "",
    sender: (context.sender as string) || "unknown",
    branch,
    failedChecks,
    ciSection,
    _triggerType: "webhook",
  }).catch((err) => {
    console.error(`[event] PR fix failed:`, err);
  });

  return { kind: "dispatched", workflow: handler };
}

/**
 * Free-form user reply on a paused socratic explore run. Resolve the reply
 * gate with the message body, merge the Q&A into `scratch.socratic.qa` so the
 * next iteration sees the answer, and re-dispatch the explore workflow to
 * continue the loop.
 */
async function handleExploreReply(
  envelope: EventEnvelope,
  context: Record<string, unknown>,
  deps: DispatchDeps,
): Promise<DispatchOutcome> {
  const handled: DispatchOutcome = { kind: "handled", handler: "explore-reply" };
  const workflowRunId = context.workflowRunId as string;
  const replyText = (context.reply as string) || "";
  const sender = (context.sender as string) || "unknown";

  const run = deps.db.runs.getRun(workflowRunId);
  if (!run) {
    console.warn(`[event] explore-reply: run ${workflowRunId} not found`);
    return handled;
  }
  const pending = deps.db.approvals.getPendingForWorkflow(workflowRunId);
  if (!pending || pending.kind !== "reply") {
    console.warn(`[event] explore-reply: no pending reply gate on ${workflowRunId}`);
    return handled;
  }
  // Append the QA entry to scratch.socratic.qa. The runner reads this via
  // {{scratch.socratic.qa}} on the next iteration. The bot's last question
  // lives on the execution row that produced it — resolve
  // `lastOutputExecutionId` through the DB; legacy rows that inline
  // `lastOutput` work too.
  const prevScratch = (run.scratch || {}) as Record<string, unknown>;
  const prevSocratic = (prevScratch.socratic || {}) as Record<string, unknown>;
  const qaList = Array.isArray(prevSocratic.qa) ? [...(prevSocratic.qa as unknown[])] : [];
  const lastQuestion =
    (prevSocratic.lastOutputExecutionId
      ? deps.db.executions.getExecutionOutput(prevSocratic.lastOutputExecutionId as string) ?? ""
      : (prevSocratic.lastOutput as string | undefined) ?? "");
  qaList.push({
    question: lastQuestion,
    answer: replyText,
    sender,
    at: new Date().toISOString(),
  });
  // One transaction: resolve the reply gate (recording the reply text), merge
  // the QA into scratch, and flip the run back to running. Resume is then
  // ledger-driven: the runner re-runs from the top, completed phases skip via
  // shouldRunPhase, and the generic-loop node picks up from `scratch.iteration`
  // (persisted when it paused). The atomic op's double-reply guard throws on a
  // racing second reply — bail without a duplicate dispatch.
  try {
    deps.db.runs.resolveReplyGateAndResume(workflowRunId, pending.id, replyText, sender, {
      socratic: { ...prevSocratic, qa: qaList },
    });
  } catch (err) {
    console.warn(
      `[event] explore-reply: reply gate ${pending.id} already resolved — skipping duplicate resume:`,
      err,
    );
    return handled;
  }

  // Re-dispatch. Use channelId/threadId from the current event context (the
  // router captured them from the reply envelope), not stored workflow
  // context — they were never persisted there.
  const isSlack = run.triggerId.startsWith("slack:");
  const replyChannelId = context.channelId as string | undefined;
  const replyThreadId = context.threadId as string | undefined;
  // Reconstruct owner/repo from the stored workflow context.
  const storedCtx = (run.context || {}) as Record<string, unknown>;
  const storedOwner = storedCtx.owner as string | undefined;
  const resumeRepo = storedOwner && run.repo ? `${storedOwner}/${run.repo}` : run.repo || undefined;
  console.log(`[event] explore-reply: resuming ${workflowRunId} after reply from ${sender}`);
  deps.dispatchWorkflow("explore", {
    repo: resumeRepo || (isSlack ? undefined : run.triggerId.split("#")[0]),
    issueNumber: run.issueNumber,
    sender,
    _triggerType: envelope.type === "message" ? "chat" : "webhook",
    triggerId: isSlack ? run.triggerId : undefined,
    channelId: replyChannelId,
    threadId: replyThreadId,
  }).catch((err) => console.error(`[event] explore-reply resume failed:`, err));
  return handled;
}

/**
 * Resolve a pending approval gate. On approval, resume the paused workflow run
 * (re-dispatching from the last completed phase via the ledger); on rejection,
 * mark the run failed. Replies on every path so the requester gets feedback.
 */
async function handleApprovalResponse(
  envelope: EventEnvelope,
  context: Record<string, unknown>,
  deps: DispatchDeps,
): Promise<DispatchOutcome> {
  const handled: DispatchOutcome = { kind: "handled", handler: "approval-response" };
  const decision = context.decision as "approved" | "rejected";
  const sender = (context.sender as string) || "unknown";
  const reason = context.reason as string | undefined;
  const triggerId = context.repo && context.issueNumber
    ? `${context.repo}#${context.issueNumber}`
    : undefined;

  const approval = context.workflowRunId
    ? deps.db.approvals.getPendingForWorkflow(context.workflowRunId as string)
    : triggerId
    ? deps.db.approvals.getPendingByTrigger(triggerId)
    : null;

  if (!approval) {
    await envelope.reply("No pending approval found.");
    return handled;
  }

  if (decision === "approved") {
    // Re-trigger the workflow — resume logic picks up from DB state.
    const workflowRun = deps.db.runs.getRun(approval.workflowRunId);
    if (workflowRun && !deps.github) {
      // Record the approval, but we can't resume without the GitHub App.
      deps.db.approvals.respond(approval.id, "approved", sender, reason);
      await envelope.reply(
        "Approval recorded, but cannot resume: GitHub App is not configured. Configure GITHUB_APP_ID and related env vars to enable build resumption.",
      );
      return handled;
    }
    if (workflowRun && deps.github) {
      await envelope.reply(`Approved by ${sender}. Resuming \`${workflowRun.workflowName}\`...`);
      const [owner, repo] = workflowRun.triggerId.includes("/")
        ? workflowRun.triggerId.replace(/#\d+$/, "").split("/")
        : ["", ""];
      const issueNumber = workflowRun.issueNumber;
      if (owner && repo && issueNumber) {
        // One transaction: respond 'approved' + flip the run to running. The
        // long-running re-dispatch happens after the commit.
        deps.db.runs.resolveGateAndResume(approval.id, sender);
        deps.dispatchWorkflow(workflowRun.workflowName, {
          repo: `${owner}/${repo}`,
          issueNumber,
          title: `Issue #${issueNumber}`,
          body: "",
          sender,
          _triggerType: "approval",
        }).catch((err) => console.error(`[approval] Resume failed:`, err));
      } else {
        // Can't reconstruct the dispatch target — record without resuming.
        deps.db.approvals.respond(approval.id, "approved", sender, reason);
      }
    } else {
      // No workflow run for this approval — just record the response.
      deps.db.approvals.respond(approval.id, "approved", sender, reason);
    }
  } else {
    // One transaction: respond 'rejected' + fail the run (a no-op if the run
    // is already gone).
    deps.db.runs.resolveGateAndFail(approval.id, sender, reason);
    await envelope.reply(
      `Rejected by ${sender}. Build cycle aborted.${reason ? ` Reason: ${reason}` : ""}`,
    );
  }

  return handled;
}

/**
 * Conversational chat turn. Records an `executions` row so chat usage shows up
 * in dashboard stats, runs the in-process turn, persists the minted agent
 * session id for resume on the next turn, and replies. Failures still record a
 * finish row and apologize rather than going silent.
 *
 * Per-session batching of bursty messaging input happens *before* this point,
 * in the MessageBatcher at the connector→dispatch boundary (see
 * `src/engine/message-batcher.ts`) — so by the time a turn reaches here it is
 * already one combined, send-ordered message. This handler just runs it.
 */
async function handleChat(
  envelope: EventEnvelope,
  context: Record<string, unknown>,
  deps: DispatchDeps,
): Promise<DispatchOutcome> {
  const messagingSessionId = context.sessionId as string;
  const message = context.message as string;
  const sender = context.sender as string;

  // Re-assert the thinking indicator for this turn (a batched burst can drain
  // as several turns; the per-arrival indicator is cleared by the first reply).
  envelope.typing?.().catch(() => {});

  await runChatTurn(deps, { sessionId: messagingSessionId, message, sender, reply: envelope.reply });
  return { kind: "handled", handler: "chat" };
}

/**
 * Run one chat turn end-to-end: record the execution, run the model, persist a
 * freshly-minted agent session id for resume, and post the reply (apologizing
 * on failure). Shared by the inline `handleChat` path and the ChatCoordinator,
 * so batched turns get identical execution/telemetry recording. `message` may
 * be a single message or a newline-combined batch.
 */
export async function runChatTurn(
  deps: DispatchDeps,
  args: { sessionId: string; message: string; sender: string; reply: (msg: string) => Promise<void> },
): Promise<void> {
  const { sessionId, message, sender, reply } = args;

  // First message has no agent session → fresh; later messages resume.
  const resumeAgentSessionId = deps.sessionManager.getSession(sessionId)?.agentSessionId ?? undefined;

  // triggerId is the messaging-session id, so a whole Slack thread groups
  // together with `GROUP BY trigger_id`.
  const executionId = randomUUID();
  deps.db.executions.recordStart({
    id: executionId,
    triggerType: "chat",
    triggerId: sessionId,
    skill: "chat",
    startedAt: new Date().toISOString(),
    // Actor logging (issue #205): the chat sender (a Slack login/handle,
    // resolved to a GitHub login when the user matched a `users` row).
    triggeredBy: sender,
    triggerActorType: "slack",
  });

  try {
    const result = await deps.runChat(message, sessionId, sender, resumeAgentSessionId);

    if (result.agentSessionId && result.agentSessionId !== resumeAgentSessionId) {
      deps.sessionManager.setAgentSessionId(sessionId, result.agentSessionId);
    }

    deps.db.executions.recordFinish(executionId, {
      success: result.success,
      error: result.error,
      turns: result.turns,
      durationMs: result.durationMs,
      // dashboardSessionId so error rows still link to a (stub) jsonl envelope.
      sessionId: result.dashboardSessionId ?? result.agentSessionId,
      costUsd: result.costUsd,
      inputTokens: result.inputTokens,
      cacheCreationInputTokens: result.cacheCreationInputTokens,
      cacheReadInputTokens: result.cacheReadInputTokens,
      outputTokens: result.outputTokens,
      apiDurationMs: result.apiDurationMs,
      stopReason: result.stopReason,
    });

    await reply(result.text);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[dispatch] Chat error:`, msg);
    deps.db.executions.recordFinish(executionId, { success: false, error: msg, durationMs: 0 });
    await reply("Sorry, I encountered an error. Please try again.");
  }
}
