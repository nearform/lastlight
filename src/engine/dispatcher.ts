import { randomUUID } from "crypto";
import type { EventEnvelope } from "../connectors/types.js";
import type { SessionManager } from "../connectors/index.js";
import type { StateDb } from "../state/db.js";
import type { GitHubClient } from "./github.js";
import type { ChatResult } from "./chat.js";
import { routeEvent, type Route, type RouterDeps } from "./router.js";

/**
 * Hand a workflow to the runner. Matches `dispatchWorkflow` in index.ts — the
 * dispatcher names workflows and accumulates their outcome but owns none of the
 * sandbox/runner plumbing.
 */
export type DispatchWorkflowFn = (
  workflowName: string,
  context: Record<string, unknown>,
  onRunStart?: (runId: string) => Promise<void>,
) => Promise<{ success: boolean; error?: string; paused?: boolean }>;

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
  | { kind: "dispatched"; workflow: string };

/**
 * Turn an EventEnvelope into a workflow dispatch (or an in-process handler
 * run). Classifies via `route`, then acts on the decision. Extracted from the
 * former `registry.onEvent` closure so every event branch is testable.
 */
export async function dispatch(
  envelope: EventEnvelope,
  deps: DispatchDeps,
): Promise<DispatchOutcome> {
  const route = await (deps.route ?? routeEvent)(envelope, { db: deps.db });

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
    const running = deps.db.runningExecutions();
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
  if (deps.db.isRunning(handler, triggerId)) {
    console.log(`[event] Skipping: ${handler} already running for ${triggerId}`);
    if (envelope.type === "message") {
      await envelope.reply(`That task is already running. Use /status to check progress.`);
    }
    return { kind: "skipped", reason: `${handler} already running for ${triggerId}` };
  }

  // PR fix: lightweight fix-and-push driven by CI failures / a comment.
  if ((routeKey === "github.pr_fix" || handler === "pr-fix") && context.prNumber && context.repo) {
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
    const link = deps.publicUrl
      ? `${deps.publicUrl}/admin/?run=${encodeURIComponent(runId)}&tab=workflows`
      : undefined;
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
      if (result.paused) {
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

  const workflowPromise = deps.dispatchWorkflow(handler, { ...workflowContext, _triggerType: "webhook" });

  if (prCheckRunId !== undefined && github) {
    const checkId = prCheckRunId;
    const owner = prOwner;
    const repo = prRepoName;
    const prNumber = prNumberForCheck;
    workflowPromise
      .then(async (result) => {
        try {
          // Re-fetch head SHA in case the PR was rebased mid-review.
          const headSha = await github.getPullRequestHeadSha(owner, repo, prNumber);
          const review = await github.getLatestBotReview(owner, repo, prNumber, headSha);
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
  deps.db.recordStart({
    id: executionId,
    triggerType: envelope.type === "message" ? "chat" : "webhook",
    triggerId: String(issueNumber),
    skill: "build-cycle",
    repo: repoStr,
    issueNumber,
    startedAt: new Date().toISOString(),
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
    deps.db.recordFinish(executionId, {
      success: result.success,
      error: result.success ? undefined : "Build cycle failed",
      durationMs: 0,
    });
    if (envelope.type === "message") {
      envelope.reply(result.success ? `Build cycle complete.` : `Build cycle failed.`);
    }
  }).catch((err) => {
    console.error(`[event] Build cycle failed:`, err);
    deps.db.recordFinish(executionId, { success: false, error: err.message, durationMs: 0 });
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
  if (deps.github) {
    try {
      const pr = await deps.github.getPullRequest(owner, repo, prNumber);
      prTitle = prTitle || pr.title;
      prBody = prBody || pr.body || "";
      branch = pr.head.ref;
      failedChecks = await deps.github.getFailedChecks(owner, repo, pr.head.sha);
    } catch (err: any) {
      console.warn(`[event] Could not fetch PR: ${err.message}`);
    }
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

  const run = deps.db.getWorkflowRun(workflowRunId);
  if (!run) {
    console.warn(`[event] explore-reply: run ${workflowRunId} not found`);
    return handled;
  }
  const pending = deps.db.getPendingApprovalForWorkflow(workflowRunId);
  if (!pending || pending.kind !== "reply") {
    console.warn(`[event] explore-reply: no pending reply gate on ${workflowRunId}`);
    return handled;
  }
  deps.db.resolveReplyGate(pending.id, replyText, sender);

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
      ? deps.db.getExecutionOutput(prevSocratic.lastOutputExecutionId as string) ?? ""
      : (prevSocratic.lastOutput as string | undefined) ?? "");
  qaList.push({
    question: lastQuestion,
    answer: replyText,
    sender,
    at: new Date().toISOString(),
  });
  deps.db.updateWorkflowRunScratch(workflowRunId, {
    socratic: { ...prevSocratic, qa: qaList },
  });

  // Resume is ledger-driven: the runner re-runs from the top, completed
  // phases skip via shouldRunPhase, and the generic-loop node picks up from
  // `scratch.iteration` (persisted when it paused).
  deps.db.resumeWorkflowRun(workflowRunId);

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
    ? deps.db.getPendingApprovalForWorkflow(context.workflowRunId as string)
    : triggerId
    ? deps.db.getPendingApprovalByTrigger(triggerId)
    : null;

  if (!approval) {
    await envelope.reply("No pending approval found.");
    return handled;
  }

  deps.db.respondToApproval(approval.id, decision, sender, reason);

  if (decision === "approved") {
    // Re-trigger the workflow — resume logic picks up from DB state.
    const workflowRun = deps.db.getWorkflowRun(approval.workflowRunId);
    if (workflowRun && !deps.github) {
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
        deps.db.resumeWorkflowRun(workflowRun.id);
        deps.dispatchWorkflow(workflowRun.workflowName, {
          repo: `${owner}/${repo}`,
          issueNumber,
          title: `Issue #${issueNumber}`,
          body: "",
          sender,
          _triggerType: "approval",
        }).catch((err) => console.error(`[approval] Resume failed:`, err));
      }
    }
  } else {
    const workflowRun = deps.db.getWorkflowRun(approval.workflowRunId);
    if (workflowRun) {
      deps.db.finishWorkflowRun(
        approval.workflowRunId,
        "failed",
        `Rejected by ${sender}: ${reason || "no reason given"}`,
      );
    }
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
 */
async function handleChat(
  envelope: EventEnvelope,
  context: Record<string, unknown>,
  deps: DispatchDeps,
): Promise<DispatchOutcome> {
  const messagingSessionId = context.sessionId as string;
  const message = context.message as string;
  const sender = context.sender as string;

  // First message has no agent session → fresh; later messages resume.
  const resumeAgentSessionId = deps.sessionManager.getSession(messagingSessionId)?.agentSessionId ?? undefined;

  // triggerId is the messaging-session id, so a whole Slack thread groups
  // together with `GROUP BY trigger_id`.
  const executionId = randomUUID();
  deps.db.recordStart({
    id: executionId,
    triggerType: "chat",
    triggerId: messagingSessionId,
    skill: "chat",
    startedAt: new Date().toISOString(),
  });

  try {
    const result = await deps.runChat(message, messagingSessionId, sender, resumeAgentSessionId);

    if (result.agentSessionId && result.agentSessionId !== resumeAgentSessionId) {
      deps.sessionManager.setAgentSessionId(messagingSessionId, result.agentSessionId);
    }

    deps.db.recordFinish(executionId, {
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

    await envelope.reply(result.text);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[dispatch] Chat error:`, msg);
    deps.db.recordFinish(executionId, { success: false, error: msg, durationMs: 0 });
    await envelope.reply("Sorry, I encountered an error. Please try again.");
  }

  return { kind: "handled", handler: "chat" };
}
