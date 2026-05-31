import { existsSync, mkdirSync, readFileSync } from "fs";
import { resolve } from "path";
import { randomUUID } from "crypto";
import { loadConfig, resolveModel, resolveVariant } from "./config.js";
import { ConnectorRegistry, GitHubWebhookConnector, SlackConnector, SessionManager, MessageDeliveryService } from "./connectors/index.js";
import { routeEvent } from "./engine/router.js";
import { CHAT_SYSTEM_SUFFIX, handleChatMessage, loadAgentContext } from "./engine/chat.js";
import { configureWorkflowAssets, validateAssets } from "./workflows/loader.js";
import { ChatRunner } from "./engine/chat-runner.js";
import { buildReadSkillTool, loadChatSkillCatalogue } from "./engine/chat-skills.js";
import { configureGitAuth } from "./engine/git-auth.js";
import { StateDb } from "./state/db.js";
import { CronScheduler } from "./cron/scheduler.js";
import { getJobs } from "./cron/jobs.js";
import { dispatchCronWorkflow } from "./cron/fanout.js";
import { mountAdmin } from "./admin/index.js";
import { cleanupOrphanedSandboxes } from "./sandbox/index.js";
import { writeEgressFirewallConfigs } from "./sandbox/egress-firewall-config.js";
import { authMiddleware } from "./admin/auth.js";
import { GitHubClient } from "./engine/github.js";
import { screenForInjection, flagPrefix } from "./engine/screen.js";
import { runSimpleWorkflow, type SimpleWorkflowRequest } from "./workflows/simple.js";
import type { RunnerCallbacks } from "./workflows/runner.js";
import { resumeOrphanedWorkflows } from "./workflows/resume.js";
import type { EventEnvelope } from "./connectors/types.js";
export { printHello } from "./utils/hello.js";

/**
 * Pre-flight validation — checks that config is sane before starting any
 * services. Exits with code 78 (EX_CONFIG) on configuration errors so
 * Docker's restart policy doesn't loop forever on a misconfigured container.
 */
function validateConfig(config: ReturnType<typeof loadConfig>): void {
  const fatal = (msg: string) => {
    console.error(`\n[startup] FATAL: ${msg}`);
    console.error("[startup] Fix your .env and restart.\n");
    process.exit(78); // EX_CONFIG — sysexits.h convention
  };

  if (config.githubApp) {
    const { appId, privateKeyPath, installationId } = config.githubApp;
    if (!appId || !installationId) {
      fatal("GITHUB_APP_ID and GITHUB_APP_INSTALLATION_ID are required when the GitHub App is configured.");
    }
    if (!existsSync(resolve(privateKeyPath))) {
      fatal(`GITHUB_APP_PRIVATE_KEY_PATH points to "${privateKeyPath}" which does not exist.`);
    }
    try {
      const content = readFileSync(resolve(privateKeyPath), "utf8");
      if (!content.startsWith("-----BEGIN")) {
        fatal(`GITHUB_APP_PRIVATE_KEY_PATH ("${privateKeyPath}") does not look like a PEM file.`);
      }
    } catch (err: any) {
      fatal(`Cannot read GITHUB_APP_PRIVATE_KEY_PATH ("${privateKeyPath}"): ${err.message}`);
    }
  }

  if (!config.webhookSecret && config.githubApp) {
    console.warn("[startup] WEBHOOK_SECRET is not set — webhook signature verification is disabled.");
  }
}

async function main() {
  console.log("Last Light v2.0 — Agent SDK Harness");
  console.log("====================================");

  // Load and validate config + overlay assets before starting anything. These
  // throw on a broken/empty overlay, a cron targeting a missing workflow, or a
  // phase whose prompt/skill can't resolve — all unfixable by a restart, so we
  // exit 78 (EX_CONFIG) to stop Docker's restart policy from looping.
  let config: ReturnType<typeof loadConfig>;
  try {
    config = loadConfig();
    configureWorkflowAssets({
      builtInRoot: config.builtInRoot,
      overlayRoot: config.overlayDir,
      disabled: config.disabled,
    });
    validateAssets(config.routes);
  } catch (err: unknown) {
    console.error(`\n[startup] FATAL: ${(err as Error).message}`);
    console.error("[startup] Fix your config/overlay and restart.\n");
    process.exit(78); // EX_CONFIG — sysexits.h convention
  }
  validateConfig(config);

  console.log(`[config] Port: ${config.port}, Model: ${config.model}`);
  const modelOverrides = Object.entries(config.models).filter(([k]) => k !== "default");
  if (modelOverrides.length > 0) {
    console.log(`[config] Model overrides: ${modelOverrides.map(([k, v]) => `${k}=${v}`).join(", ")}`);
  }

  // Clean up any sandbox containers left over from a previous run
  cleanupOrphanedSandboxes();

  // Ensure state directory structure exists (mountable as Docker volume)
  for (const sub of ["sessions", "logs", "sandboxes"]) {
    mkdirSync(resolve(config.stateDir, sub), { recursive: true });
  }
  console.log(`[state] State dir: ${config.stateDir}`);
  console.log(`[state] Sessions dir: ${config.sessionsDir}`);
  console.log(`[config] Sandbox backend: ${config.sandbox}`);

  // Regenerate egress firewall configs (nginx ssl_preread + coredns) from
  // the allowlist source of truth. Only meaningful for the docker backend;
  // cheap enough to do unconditionally so a backend switch doesn't leave
  // stale configs on disk.
  const proxyDir = writeEgressFirewallConfigs(config.stateDir);
  console.log(`[state] Egress firewall configs: ${proxyDir}`);

  // Initialize state database first — ChatRunner needs SessionManager
  // (DB-backed) at construction time.
  const db = new StateDb(config.dbPath);
  console.log(`[state] Database: ${config.dbPath}`);

  // Session manager for messaging connectors (shared across Slack, Discord, etc.)
  const sessionManager = new SessionManager(db.database);

  // In-process chat runner backs the messaging chat skill. One pi-ai
  // conversation per Slack/Discord thread; locked down to read-only
  // GitHub tools plus a `read_skill` tool that exposes the curated
  // chat skill catalogue. Skills are listed in the system prompt via
  // an XML <available_skills> block; the agent pulls full SKILL.md on
  // demand — same progressive-disclosure model the sandbox phases use.
  const chatSkills = loadChatSkillCatalogue();
  const readSkill = buildReadSkillTool(chatSkills.skills);
  const chatRunner = new ChatRunner(
    {
      model: resolveModel(config.models, "chat"),
      thinking: resolveVariant(config.variants, "chat"),
      systemPrompt: loadAgentContext() + CHAT_SYSTEM_SUFFIX + chatSkills.catalogueXml,
      github: config.githubApp,
      extraTools: chatSkills.skills.length > 0
        ? { tools: [readSkill.tool], execute: readSkill.execute }
        : undefined,
    },
    sessionManager,
  );
  if (chatSkills.skills.length > 0) {
    console.log(
      `[chat] Loaded ${chatSkills.skills.length} skill(s): ${chatSkills.skills.map((s) => s.name).join(", ")}`,
    );
  } else {
    console.warn("[chat] No skills loaded — frontmatter missing or no matching SKILL.md found");
  }

  // Configure git with GitHub App credentials — agents can git clone/push natively.
  // Non-fatal: the token is refreshed before each agent execution anyway, so a
  // transient failure here (DNS, rate limit) doesn't block startup.
  if (config.githubApp) {
    try {
      await configureGitAuth({
        appId: config.githubApp.appId,
        privateKeyPath: config.githubApp.privateKeyPath,
        installationId: config.githubApp.installationId,
      });
    } catch (err: any) {
      console.warn(`[git-auth] Initial token mint failed (will retry per-execution): ${err.message}`);
    }
  }

  // GitHub API client for harness-level operations (posting comments, fetching issues)
  const github = config.githubApp ? new GitHubClient(config.githubApp) : null;

  /**
   * Dispatch a workflow by name. Used by webhook events, cron jobs, and the
   * /api/run endpoint. Every dispatch creates a workflow_run row visible in
   * the dashboard, regardless of whether it's a single-phase workflow (like
   * issue-triage) or a multi-phase one.
   *
   * The router still uses skill names for backwards compat — for the four
   * agent skills they're 1:1 with workflow names.
   */
  const dispatchWorkflow = async (
    workflowName: string,
    context: Record<string, unknown>,
    onRunStart?: (runId: string) => Promise<void>,
  ): Promise<{ success: boolean; error?: string; paused?: boolean }> => {
    // Slack-initiated workflows (explore, /explore) carry a
    // `slack:{team}:{channel}:{thread}` triggerId and don't require a
    // managed `repo` — their postComment goes back to the Slack thread.
    const slackTriggerId = typeof context.triggerId === "string" && context.triggerId.startsWith("slack:")
      ? (context.triggerId as string)
      : undefined;

    const repoStr = context.repo as string | undefined;
    if (!repoStr && !slackTriggerId) {
      const msg = `dispatchWorkflow(${workflowName}): missing 'repo' in context`;
      console.error(`[dispatch] ${msg}`);
      return { success: false, error: msg };
    }
    const [owner, repo] = repoStr && repoStr.includes("/")
      ? repoStr.split("/")
      : repoStr
      ? ["", repoStr]
      : ["", ""];
    if (repoStr && (!owner || !repo)) {
      const msg = `dispatchWorkflow(${workflowName}): invalid repo format '${repoStr}'`;
      console.error(`[dispatch] ${msg}`);
      return { success: false, error: msg };
    }

    // Pluck the standard fields, leave the rest in `extra` for the workflow
    // template to consume.
    const {
      _triggerType,
      repo: _r,
      issueNumber,
      prNumber,
      title,
      body,
      labels,
      sender,
      commentBody,
      triggerId: _triggerId,
      channelId,
      threadId,
      prePopulateBranch: ctxPrePopulateBranch,
      branch: ctxBranch,
      ...rest
    } = context;

    // Preserve channelId/threadId in extra so they're stored on the
    // workflow run context — needed by boot-time resume to rebuild the
    // Slack postComment callback after a harness restart.
    const extra: Record<string, unknown> = { ...(rest as Record<string, unknown>) };
    if (typeof channelId === "string") extra.channelId = channelId;
    if (typeof threadId === "string") extra.threadId = threadId;

    // For PR-scoped read workflows, resolve the PR head ref and ask the
    // sandbox to pre-clone the repo at that branch. The agent then enters
    // a workspace that's already a checkout of the PR's actual code —
    // saves a redundant clone_repo MCP call inside the session.
    //
    // pr-fix already plumbs `branch` through context (line ~709 below)
    // because the architect/executor need the branch name to push to;
    // we honor that here as the pre-populate branch too.
    let prePopulateBranch: string | undefined =
      typeof ctxPrePopulateBranch === "string" ? ctxPrePopulateBranch : undefined;
    if (!prePopulateBranch && typeof ctxBranch === "string" && ctxBranch && workflowName === "pr-fix") {
      prePopulateBranch = ctxBranch;
    }
    if (
      !prePopulateBranch &&
      workflowName === "pr-review" &&
      typeof prNumber === "number" &&
      github &&
      owner &&
      repo
    ) {
      try {
        const pr = await github.getPullRequest(owner, repo, prNumber);
        prePopulateBranch = pr.head.ref;
        console.log(
          `[dispatch] pr-review: pre-populating workspace at ${owner}/${repo}@${prePopulateBranch}`,
        );
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(
          `[dispatch] pr-review: could not resolve PR head ref (${msg}); ` +
          `agent will need to clone via MCP`,
        );
      }
    }

    const request: SimpleWorkflowRequest = {
      owner,
      repo,
      issueNumber: typeof issueNumber === "number" ? issueNumber : undefined,
      prNumber: typeof prNumber === "number" ? prNumber : undefined,
      issueTitle: typeof title === "string" ? title : "",
      issueBody: typeof body === "string" ? body : "",
      issueLabels: Array.isArray(labels) ? (labels as string[]) : undefined,
      commentBody: typeof commentBody === "string" ? commentBody : undefined,
      sender: typeof sender === "string" ? sender : "unknown",
      triggerId: slackTriggerId,
      extra,
      prePopulateBranch,
    };

    // For workflows where the architect/agent needs to see the full issue
    // history (e.g. a build greenlit by "@last-light lets build this!" needs
    // the spec the explore phase wrote in earlier comments), fetch the real
    // issue body and the comment thread, combine them into a single context
    // blob, and screen the combined text in ONE SDK call.
    //
    // Why single-shot: screening per-comment fans out N concurrent SDK calls,
    // and on a busy issue (16+ comments) that exhausts memory and trips the
    // EventEmitter listener cap. The combined-context approach keeps screen
    // cost at exactly one haiku call regardless of thread length.
    //
    // For comment-triggered builds the envelope's `body` field is the
    // triggering comment, not the issue body — we explicitly fetch the
    // real issue body here so the architect sees both the spec (issue body
    // + thread) and the trigger (commentBody) cleanly separated.
    const ENRICH_WORKFLOWS = new Set(["build", "pr-fix", "explore"]);
    if (
      github &&
      ENRICH_WORKFLOWS.has(workflowName) &&
      request.issueNumber &&
      owner && repo
    ) {
      try {
        const [trueIssueBody, comments] = await Promise.all([
          github.getIssueBody(owner, repo, request.issueNumber),
          github.listIssueComments(owner, repo, request.issueNumber),
        ]);

        const formattedComments = comments
          .filter((c) => c.body.trim())
          .map((c) => `--- @${c.user} (${c.createdAt}) ---\n${c.body}`)
          .join("\n\n");

        const combinedContext = [
          trueIssueBody ? `# Issue body\n\n${trueIssueBody}` : "",
          formattedComments ? `# Issue thread (oldest → newest)\n\n${formattedComments}` : "",
        ]
          .filter(Boolean)
          .join("\n\n");

        if (combinedContext) {
          // Single screening call over the entire combined context.
          const screen = await screenForInjection(combinedContext);
          const annotated = screen.flagged
            ? `${flagPrefix(screen.reason)}${combinedContext}`
            : combinedContext;
          (request.extra ||= {}).combinedContext = annotated;
          // Clear individual issueBody so simple.ts uses combinedContext
          // exclusively (avoids double-rendering the body).
          request.issueBody = "";
          if (screen.flagged) {
            console.warn(
              `[dispatch] Screener flagged combined issue context for ${owner}/${repo}#${request.issueNumber}: ${screen.reason || "no reason"}`,
            );
          }
        }
      } catch (err: unknown) {
        const m = err instanceof Error ? err.message : String(err);
        console.warn(`[dispatch] Failed to fetch/screen issue context: ${m}`);
        // Non-fatal — workflow proceeds with whatever context the envelope had.
      }
    }

    const slackPost = slackTriggerId && slackConnector && typeof channelId === "string" && typeof threadId === "string"
      ? async (msg: string) => {
          try {
            await slackConnector!.sendMessage(channelId, threadId, msg);
          } catch (err: unknown) {
            const m = err instanceof Error ? err.message : String(err);
            console.warn(`[dispatch] Failed to post to Slack thread: ${m}`);
          }
        }
      : undefined;

    const callbacks: RunnerCallbacks = {
      postComment: slackPost
        ?? (github && issueNumber
          ? async (msg) => {
              try {
                await github.postComment(owner, repo, issueNumber as number, msg);
              } catch (err: unknown) {
                const m = err instanceof Error ? err.message : String(err);
                console.warn(`[dispatch] Failed to post comment: ${m}`);
              }
            }
          : undefined),
      onPhaseStart: async (phase) => {
        console.log(`[dispatch] ▶ ${workflowName}/${phase}`);
        // Refresh the Slack thinking indicator so long-running phases
        // don't leave the thread looking dead. threadId doubles as both
        // the message anchor and the thread root for DM threads.
        if (slackPost && slackConnector && typeof channelId === "string" && typeof threadId === "string") {
          slackConnector.showTyping(channelId as string, threadId as string, threadId as string).catch(() => {});
        }
      },
      onPhaseEnd: async (phase, result) =>
        console.log(`[dispatch] ◀ ${workflowName}/${phase}: ${result.success ? "OK" : "FAILED"}`),
      onRunStart,
    };

    try {
      const result = await runSimpleWorkflow(
        workflowName,
        request,
        {
          model: config.model,
          maxTurns: config.maxTurns,
          stateDir: config.stateDir,
          sandboxDir: config.sandboxDir,
          sessionsDir: config.sessionsDir,
          sandbox: config.sandbox,
        },
        callbacks,
        db,
        config.models,
        config.approval,
        config.bootstrapLabel,
        config.variants,
      );
      const summary = result.phases.map((p) => `${p.phase}=${p.success ? "ok" : "fail"}`).join(", ");
      if (result.paused) {
        console.log(`[dispatch] ${workflowName} paused (${summary})`);
      } else if (result.success) {
        console.log(`[dispatch] ${workflowName} completed (${summary})`);
      } else {
        console.warn(`[dispatch] ${workflowName} failed (${summary})`);
      }
      return { success: result.success, paused: result.paused };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[dispatch] ${workflowName} threw: ${msg}`);
      return { success: false, error: msg };
    }
  };

  // Set up connector registry
  const registry = new ConnectorRegistry();

  // Message delivery service for cron output
  const delivery = new MessageDeliveryService();

  // GitHub webhook connector (optional — requires both webhook secret and GitHub App)
  let githubConnector: GitHubWebhookConnector | null = null;
  if (config.webhookSecret && config.githubApp) {
    githubConnector = new GitHubWebhookConnector({
      port: config.port,
      webhookSecret: config.webhookSecret,
      botLogin: config.botLogin,
    });
    registry.register(githubConnector);
  }

  // Slack connector (optional — only if SLACK_BOT_TOKEN is set)
  let slackConnector: SlackConnector | null = null;
  if (config.slack) {
    slackConnector = new SlackConnector(
      {
        botToken: config.slack.botToken,
        appToken: config.slack.appToken,
        allowedUsers: config.slack.allowedUsers,
        deliveryChannel: config.slack.deliveryChannel,
        botIdentifier: "", // Will be resolved from Slack API on connect
      },
      sessionManager
    );
    registry.register(slackConnector);

    // Register Slack as a delivery target for cron reports
    if (config.slack.deliveryChannel) {
      delivery.register("slack", (msg) => slackConnector!.sendToDeliveryChannel(msg));
    }
  }

  // Construct the cron scheduler before mounting admin so the dashboard can
  // list/toggle/edit registered cron jobs. Jobs are registered further down
  // (after we know whether webhooks are enabled). The runner closes over
  // `dispatchWorkflow`, which is defined earlier in this file.
  const cron = new CronScheduler(db, async (workflowName, context) => {
    const { dispatched, failures } = await dispatchCronWorkflow(
      workflowName,
      context,
      dispatchWorkflow,
    );
    if (failures > 0) {
      console.warn(
        `[cron] ${workflowName}: ${failures}/${dispatched} dispatches failed`,
      );
    }
  });

  // Mount admin dashboard (needs an HTTP server — use GitHub connector or create standalone)
  if (githubConnector) {
    mountAdmin(githubConnector.honoApp, db, {
      cronScheduler: cron,
      stateDir: config.stateDir,
      sessionsDir: config.sessionsDir,
      adminPassword: process.env.ADMIN_PASSWORD ?? "",
      adminSecret: process.env.ADMIN_SECRET ?? "lastlight-dev-secret",
      publicConfig: config.publicConfig,
      slackOAuthClientId: process.env.SLACK_OAUTH_CLIENT_ID,
      slackOAuthClientSecret: process.env.SLACK_OAUTH_CLIENT_SECRET,
      slackOAuthRedirectUri: process.env.SLACK_OAUTH_REDIRECT_URI,
      slackAllowedWorkspace: process.env.SLACK_ALLOWED_WORKSPACE,
      githubOAuthClientId: process.env.GITHUB_OAUTH_CLIENT_ID,
      githubOAuthClientSecret: process.env.GITHUB_OAUTH_CLIENT_SECRET,
      githubOAuthRedirectUri: process.env.GITHUB_OAUTH_REDIRECT_URI,
      githubAllowedOrg: process.env.GITHUB_ALLOWED_ORG,
      resumeWorkflow: async (workflowRun, sender) => {
        if (!github) {
          console.warn(`[admin] Cannot resume workflow ${workflowRun.id}: GitHub App not configured`);
          return;
        }
        const [owner, repo] = workflowRun.triggerId.includes("/")
          ? workflowRun.triggerId.replace(/#\d+$/, "").split("/")
          : ["", ""];
        const issueNumber = workflowRun.issueNumber;
        if (!owner || !repo || !issueNumber) {
          console.warn(`[admin] Cannot resume workflow ${workflowRun.id}: missing owner/repo/issueNumber`);
          return;
        }
        db.resumeWorkflowRun(workflowRun.id);
        console.log(`[admin] Resuming ${workflowRun.workflowName} for ${owner}/${repo}#${issueNumber} after dashboard approval by ${sender}`);
        dispatchWorkflow(workflowRun.workflowName, {
          repo: `${owner}/${repo}`,
          issueNumber,
          title: `Issue #${issueNumber}`,
          body: "",
          sender,
          _triggerType: "admin",
        }).catch((err) => console.error(`[admin] Resume failed:`, err));
      },
    });
    console.log(`[admin] Dashboard mounted at /admin`);
  }

  // API endpoints (require HTTP server from GitHub connector)
  if (!githubConnector) {
    console.log(`[api] No HTTP server — API endpoints disabled (Slack Socket Mode only)`);
  }

  // Protect API endpoints with auth when ADMIN_PASSWORD is set
  const adminPassword = process.env.ADMIN_PASSWORD ?? "";
  const adminSecret = process.env.ADMIN_SECRET ?? "lastlight-dev-secret";
  if (githubConnector && adminPassword) {
    githubConnector.honoApp.use("/api/*", authMiddleware(adminPassword, adminSecret));
    console.log(`[api] API endpoints protected with auth`);
  }

  // API endpoint for CLI triggers
  githubConnector?.honoApp.post("/api/run", async (c) => {
    const body = await c.req.json();
    // Accept either `skill` (legacy) or `workflow` (preferred). They map 1:1
    // for the four agent skills (issue-triage, pr-review, repo-health,
    // issue-comment) which are now backed by single-phase YAML workflows.
    const workflowName = (body.workflow ?? body.skill) as string | undefined;
    const context = (body.context ?? {}) as Record<string, unknown>;

    if (!workflowName) {
      return c.json({ error: "Missing 'workflow' (or 'skill') field" }, 400);
    }

    console.log(`[api] CLI triggered: workflow=${workflowName}`);

    // Run asynchronously — return immediately with a stable id the caller
    // can correlate with workflow_runs in the dashboard.
    const executionId = randomUUID();
    dispatchWorkflow(workflowName, { ...context, _triggerType: "api" }).catch((err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[api] workflow ${workflowName} failed: ${msg}`);
    });

    return c.json({ accepted: true, executionId, workflow: workflowName }, 202);
  });

  // API endpoint for build cycle triggers (issue URL)
  githubConnector?.honoApp.post("/api/build", async (c) => {
    const body = await c.req.json();
    const { owner, repo, issueNumber, issueTitle, issueBody, issueLabels, sender } = body;

    if (!owner || !repo || !issueNumber) {
      return c.json({ error: "Missing owner, repo, or issueNumber" }, 400);
    }

    console.log(`[api] CLI build triggered: ${owner}/${repo}#${issueNumber}`);

    // If labels weren't supplied, fetch them so the orchestrator can detect
    // bootstrap tasks (lastlight:bootstrap label) and skip the BLOCKED gate.
    let resolvedLabels: string[] | undefined = issueLabels;
    if (!resolvedLabels && github) {
      try {
        const issue = await github.getIssue(owner, repo, issueNumber);
        resolvedLabels = (issue.labels || []).map((l: any) =>
          typeof l === "string" ? l : l.name,
        ).filter(Boolean);
      } catch { /* non-fatal */ }
    }

    // Run build cycle asynchronously via the generic dispatcher
    dispatchWorkflow("build", {
      repo: `${owner}/${repo}`,
      issueNumber,
      title: issueTitle || `Issue #${issueNumber}`,
      body: issueBody || "",
      labels: resolvedLabels,
      sender: sender || "cli",
      _triggerType: "api",
    }).catch((err) => {
      console.error(`[api] Build failed:`, err);
    });

    return c.json({ accepted: true, owner, repo, issueNumber }, 202);
  });

  // Handle events from any connector
  registry.onEvent(async (envelope: EventEnvelope) => {
    console.log(`[event] ${envelope.source}:${envelope.type} from ${envelope.sender}${envelope.repo ? ` on ${envelope.repo}` : ""}`);

    const route = await routeEvent(envelope, { db });

    if (route.action === "ignore") {
      console.log(`[event] Ignored: ${route.reason}`);
      return;
    }

    if (route.action === "reply") {
      await envelope.reply(route.message);
      return;
    }

    const { skill, context } = route;
    const routeKey = typeof context._routeKey === "string" ? context._routeKey : undefined;
    const workflowContext = () => {
      const { _routeKey: _ignored, ...rest } = context;
      return rest;
    };

    // Chat messages: handle directly (no sandbox, low latency)
    if (skill === "chat") {
      const messagingSessionId = context.sessionId as string;
      const message = context.message as string;
      const sender = context.sender as string;

      // Look up the existing Agent SDK session id for this Slack thread.
      // First message has none → fresh session; subsequent messages resume.
      const messagingSession = sessionManager.getSession(messagingSessionId);
      const resumeAgentSessionId = messagingSession?.agentSessionId ?? undefined;

      // Record an executions row so chat usage shows up in dashboard stats
      // alongside sandbox runs. triggerId is the messaging-session id, so a
      // whole Slack thread groups together with `GROUP BY trigger_id`.
      const executionId = randomUUID();
      db.recordStart({
        id: executionId,
        triggerType: "chat",
        triggerId: messagingSessionId,
        skill: "chat",
        startedAt: new Date().toISOString(),
      });

      try {
        const result = await handleChatMessage(
          message,
          messagingSessionId,
          sender,
          sessionManager,
          {
            chatRunner,
            sessionsHomeDir: config.sessionsDir,
          },
          {
            model: resolveModel(config.models, "chat"),
            maxTurns: 10,
          },
        );

        // Persist the agentSessionId — first turn mints, later turns reuse.
        if (result.agentSessionId && result.agentSessionId !== resumeAgentSessionId) {
          sessionManager.setAgentSessionId(messagingSessionId, result.agentSessionId);
        }

        db.recordFinish(executionId, {
          success: result.success,
          error: result.error,
          turns: result.turns,
          durationMs: result.durationMs,
          // Use dashboardSessionId so error rows still link to a (stub)
          // jsonl envelope. Falls back to agentSessionId for success
          // rows where the two are equal anyway.
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
        console.error(`[event] Chat error:`, msg);
        db.recordFinish(executionId, {
          success: false,
          error: msg,
          durationMs: 0,
        });
        await envelope.reply("Sorry, I encountered an error. Please try again.");
      }
      return;
    }

    // Chat reset: deactivate the session and confirm
    if (skill === "chat-reset") {
      const sessionId = context.sessionId as string;
      if (sessionId) {
        sessionManager.deactivateSession(sessionId);
      }
      await envelope.reply("Session reset. Starting fresh.");
      return;
    }

    // Status report: return running executions
    if (skill === "status-report") {
      const running = db.runningExecutions();
      if (running.length === 0) {
        await envelope.reply("No tasks currently running.");
      } else {
        const lines = running.map((r) =>
          `• *${r.skill}*${r.repo ? ` on ${r.repo}` : ""}${r.issueNumber ? ` #${r.issueNumber}` : ""} (started ${r.startedAt})`
        );
        await envelope.reply(`Running tasks:\n${lines.join("\n")}`);
      }
      return;
    }

    // Check if already running for this trigger
    const triggerId = String(envelope.issueNumber || envelope.id);
    if (db.isRunning(skill, triggerId)) {
      console.log(`[event] Skipping: ${skill} already running for ${triggerId}`);
      // Notify messaging users that the task is already in progress
      if (envelope.type === "message") {
        await envelope.reply(`That task is already running. Use /status to check progress.`);
      }
      return;
    }

    // PR fix: lightweight fix-and-push, no full build cycle
    if ((routeKey === "github.pr_fix" || skill === "pr-fix") && context.prNumber && context.repo) {
      const repoStr = context.repo as string;
      const [owner, repo] = repoStr.includes("/") ? repoStr.split("/") : ["", repoStr];
      const prNumber = context.prNumber as number;

      if (!owner || !repo) {
        console.error(`[event] Invalid repo format: ${repoStr}`);
        return;
      }

      // Fetch PR details and CI failures
      let prTitle = (context.title as string) || "";
      let prBody = (context.body as string) || "";
      let branch = "";
      let failedChecks = "";
      if (github) {
        try {
          const pr = await github.getPullRequest(owner, repo, prNumber);
          prTitle = prTitle || pr.title;
          prBody = prBody || pr.body || "";
          branch = pr.head.ref;
          // Fetch CI failures for the PR's head commit
          failedChecks = await github.getFailedChecks(owner, repo, pr.head.sha);
        } catch (err: any) {
          console.warn(`[event] Could not fetch PR: ${err.message}`);
        }
      }

      if (!branch) {
        console.error(`[event] Could not determine branch for PR #${prNumber}`);
        return;
      }

      console.log(`[event] PR fix for ${repoStr}#${prNumber} on branch ${branch}`);

      const ciSection = failedChecks && !failedChecks.includes("No failed checks")
        ? `CI FAILURES (from GitHub Actions — fix these first):\n${failedChecks}`
        : "";

      dispatchWorkflow(skill, {
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

      return;
    }

    // Explore reply: free-form user reply on a paused socratic explore
    // run. Resolve the reply gate with the message body, merge it into
    // scratch.socratic.qa so the next iteration sees the answer, and
    // re-dispatch the workflow to continue the loop.
    if (skill === "explore-reply") {
      const workflowRunId = context.workflowRunId as string;
      const replyText = (context.reply as string) || "";
      const sender = (context.sender as string) || "unknown";

      const run = db.getWorkflowRun(workflowRunId);
      if (!run) {
        console.warn(`[event] explore-reply: run ${workflowRunId} not found`);
        return;
      }
      const pending = db.getPendingApprovalForWorkflow(workflowRunId);
      if (!pending || pending.kind !== "reply") {
        console.warn(`[event] explore-reply: no pending reply gate on ${workflowRunId}`);
        return;
      }
      db.resolveReplyGate(pending.id, replyText, sender);

      // Append the QA entry to scratch.socratic.qa. The runner reads this
      // via {{scratch.socratic.qa}} on the next iteration. The bot's last
      // question lives on the execution row that produced it — resolve
      // `lastOutputExecutionId` through the DB; legacy rows that still
      // inline `lastOutput` work too.
      const prevScratch = (run.scratch || {}) as Record<string, unknown>;
      const prevSocratic = (prevScratch.socratic || {}) as Record<string, unknown>;
      const qaList = Array.isArray(prevSocratic.qa) ? [...(prevSocratic.qa as unknown[])] : [];
      const lastQuestion =
        (prevSocratic.lastOutputExecutionId
          ? db.getExecutionOutput(prevSocratic.lastOutputExecutionId as string) ?? ""
          : (prevSocratic.lastOutput as string | undefined) ?? "");
      qaList.push({
        question: lastQuestion,
        answer: replyText,
        sender,
        at: new Date().toISOString(),
      });
      db.updateWorkflowRunScratch(workflowRunId, {
        socratic: { ...prevSocratic, qa: qaList },
      });

      // Set currentPhase to the phase BEFORE the loop owner so the
      // runner's nextPhaseAfter lands back on the loop phase for the
      // next iteration. Walk the workflow definition to find it.
      try {
        const { getWorkflow } = await import("./workflows/loader.js");
        const def = getWorkflow(run.workflowName);
        // Find the phase that owns this gate (pattern: socratic_iter_N)
        const gateParts = pending.gate.match(/^(.+)_iter_\d+$/);
        const owningPhaseName = gateParts ? gateParts[1] : null;
        if (owningPhaseName) {
          const ownIdx = def.phases.findIndex((p) => p.name === owningPhaseName);
          const priorPhase = ownIdx > 0 ? def.phases[ownIdx - 1].name : owningPhaseName;
          db.updateWorkflowPhase(workflowRunId, priorPhase, {
            phase: priorPhase,
            timestamp: new Date().toISOString(),
            success: true,
            summary: `Resumed after reply on gate: ${pending.gate}`,
          });
        }
      } catch (err) {
        console.warn(`[event] explore-reply: could not resolve owning phase:`, err);
      }
      db.resumeWorkflowRun(workflowRunId);

      // Re-dispatch. Use channelId/threadId from the current event context
      // (the router captured them from the reply envelope), not from stored
      // workflow context — they were never persisted there.
      const isSlack = run.triggerId.startsWith("slack:");
      const replyChannelId = context.channelId as string | undefined;
      const replyThreadId = context.threadId as string | undefined;
      // Reconstruct owner/repo from the stored workflow context.
      const storedCtx = (run.context || {}) as Record<string, unknown>;
      const storedOwner = storedCtx.owner as string | undefined;
      const resumeRepo = storedOwner && run.repo
        ? `${storedOwner}/${run.repo}`
        : run.repo || undefined;
      console.log(`[event] explore-reply: resuming ${workflowRunId} after reply from ${sender}`);
      dispatchWorkflow("explore", {
        repo: resumeRepo || (isSlack ? undefined : run.triggerId.split("#")[0]),
        issueNumber: run.issueNumber,
        sender,
        _triggerType: envelope.type === "message" ? "chat" : "webhook",
        triggerId: isSlack ? run.triggerId : undefined,
        channelId: replyChannelId,
        threadId: replyThreadId,
      }).catch((err) => console.error(`[event] explore-reply resume failed:`, err));
      return;
    }

    // Approval responses
    if (skill === "approval-response") {
      const decision = context.decision as "approved" | "rejected";
      const sender = (context.sender as string) || "unknown";
      const reason = context.reason as string | undefined;
      const triggerId = context.repo && context.issueNumber
        ? `${context.repo}#${context.issueNumber}`
        : undefined;

      const approval = context.workflowRunId
        ? db.getPendingApprovalForWorkflow(context.workflowRunId as string)
        : triggerId
        ? db.getPendingApprovalByTrigger(triggerId)
        : null;

      if (!approval) {
        await envelope.reply("No pending approval found.");
        return;
      }

      db.respondToApproval(approval.id, decision, sender, reason);

      if (decision === "approved") {
        // Re-trigger the build cycle — resume logic in orchestrator will pick up from DB state
        const workflowRun = db.getWorkflowRun(approval.workflowRunId);
        if (workflowRun && !github) {
          await envelope.reply("Approval recorded, but cannot resume: GitHub App is not configured. Configure GITHUB_APP_ID and related env vars to enable build resumption.");
          return;
        }
        if (workflowRun && github) {
          await envelope.reply(`Approved by ${sender}. Resuming \`${workflowRun.workflowName}\`...`);
          const [owner, repo] = workflowRun.triggerId.includes("/")
            ? workflowRun.triggerId.replace(/#\d+$/, "").split("/")
            : ["", ""];
          const issueNumber = workflowRun.issueNumber;
          if (owner && repo && issueNumber) {
            db.resumeWorkflowRun(workflowRun.id);
            dispatchWorkflow(workflowRun.workflowName, {
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
        const workflowRun = db.getWorkflowRun(approval.workflowRunId);
        if (workflowRun) {
          db.finishWorkflowRun(approval.workflowRunId, "failed", `Rejected by ${sender}: ${reason || "no reason given"}`);
        }
        await envelope.reply(`Rejected by ${sender}. Build cycle aborted.${reason ? ` Reason: ${reason}` : ""}`);
      }
      return;
    }

    // Build requests: route to the programmatic orchestrator instead of the SKILL.md
    if ((routeKey === "github.issue_build" || routeKey === "slack.build" || skill === "github-orchestrator") && context.issueNumber && context.repo) {
      const repoStr = context.repo as string;
      const [owner, repo] = repoStr.includes("/") ? repoStr.split("/") : ["", repoStr];
      const issueNumber = context.issueNumber as number;

      if (!owner || !repo) {
        console.error(`[event] Invalid repo format: ${repoStr}`);
        return;
      }

      // Fetch full issue details if we don't have them
      let issueTitle = (context.title as string) || "";
      let issueBody = (context.body as string) || "";
      let issueLabels: string[] = (context.labels as string[]) || [];
      if (github && (!issueTitle || !issueBody || issueLabels.length === 0)) {
        try {
          const issue = await github.getIssue(owner, repo, issueNumber);
          issueTitle = issueTitle || issue.title;
          issueBody = issueBody || issue.body || "";
          if (issueLabels.length === 0) {
            issueLabels = (issue.labels || []).map((l: any) =>
              typeof l === "string" ? l : l.name,
            ).filter(Boolean);
          }
        } catch (err: any) {
          console.warn(`[event] Could not fetch issue: ${err.message}`);
        }
      }

      const executionId = randomUUID();
      db.recordStart({
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
      } else if (github) {
        // GitHub-triggered builds: react with 🚀 on the triggering comment so
        // the user sees an instant ack before guardrails / architect / etc.
        // start running. Non-fatal if it fails.
        const commentId = (envelope.raw as { comment?: { id?: number } } | undefined)?.comment?.id;
        if (commentId) {
          github
            .reactToComment(owner, repo, commentId, "rocket")
            .catch((err: unknown) => {
              const msg = err instanceof Error ? err.message : String(err);
              console.warn(`[event] Could not react to trigger comment: ${msg}`);
            });
        }
      }

      const buildWorkflow = skill === "github-orchestrator" ? "build" : skill;
      dispatchWorkflow(buildWorkflow, {
        repo: repoStr,
        issueNumber,
        title: issueTitle || `Issue #${issueNumber}`,
        body: issueBody,
        labels: issueLabels,
        commentBody: context.commentBody as string,
        sender: (context.sender as string) || "unknown",
        _triggerType: envelope.type === "message" ? "chat" : "webhook",
      }).then((result) => {
        db.recordFinish(executionId, {
          success: result.success,
          error: result.success ? undefined : "Build cycle failed",
          durationMs: 0,
        });
        if (envelope.type === "message") {
          envelope.reply(result.success ? `Build cycle complete.` : `Build cycle failed.`);
        }
      }).catch((err) => {
        console.error(`[event] Build cycle failed:`, err);
        db.recordFinish(executionId, { success: false, error: err.message, durationMs: 0 });
      });

      return;
    }

    // For messaging-triggered skills, acknowledge and reply when done.
    // The router still uses skill names — they map 1:1 to workflow YAML names
    // for the four agent skills (issue-triage, pr-review, repo-health, issue-comment).
    if (envelope.type === "message") {
      // Post the "Starting *<skill>*" ack once the workflow_runs row exists,
      // so the reply can include a deep link to the dashboard. Falls back to
      // a plain ack when no PUBLIC_URL/DOMAIN is configured.
      const onRunStart = async (runId: string) => {
        const link = config.publicUrl
          ? `${config.publicUrl}/admin/?run=${encodeURIComponent(runId)}&tab=workflows`
          : undefined;
        const body = link
          ? `Starting *${skill}*... I'll report back when it's done.\n<${link}|Live progress>`
          : `Starting *${skill}*... I'll report back when it's done.`;
        try {
          await envelope.reply(body);
        } catch (err: unknown) {
          const m = err instanceof Error ? err.message : String(err);
          console.warn(`[event] failed to post run-start ack: ${m}`);
        }
      };
      dispatchWorkflow(skill, { ...workflowContext(), _triggerType: "chat" }, onRunStart).then(async (result) => {
        if (result.paused) {
          // Workflow paused at a gate (approval or reply) — don't say
          // "completed", the workflow itself already posted instructions.
        } else if (result.success) {
          await envelope.reply(`*${skill}* completed.`);
        } else {
          await envelope.reply(`*${skill}* failed${result.error ? `: ${result.error}` : ""}.`);
        }
      }).catch(async (err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`[event] workflow ${skill} threw: ${msg}`);
        await envelope.reply(`*${skill}* failed: ${msg}`);
      });
      return;
    }

    // Run workflow asynchronously (webhook triggers).
    //
    // Special case: when REVIEW_POSTS_CHECK=1, the pr-review workflow on a
    // pr-attention event (opened / synchronize / reopened) posts a
    // `last-light/review` Check Run on the PR's head SHA so branch
    // protection can gate the merge on its conclusion. The check goes
    // `in_progress` here and is completed below from the workflow's
    // terminal result. Critically — `synchronize` is what makes the check
    // refresh on every push, so a REQUEST_CHANGES followed by a fix
    // commit produces a fresh yellow→green check on the new SHA.
    const isPrReviewEvent =
      envelope.type === "pr.opened" ||
      envelope.type === "pr.synchronize" ||
      envelope.type === "pr.reopened";
    const wantReviewCheck =
      config.reviewPostsCheck &&
      isPrReviewEvent &&
      (routeKey === "github.pr_opened" || routeKey === "github.pr_synchronize" || routeKey === "github.pr_reopened" || skill === "pr-review") &&
      !!github &&
      !!envelope.repo &&
      typeof envelope.prNumber === "number";

    let prCheckRunId: number | undefined;
    let prHeadSha: string | undefined;
    let prOwner = "";
    let prRepoName = "";
    let prNumberForCheck = 0;
    if (wantReviewCheck) {
      [prOwner, prRepoName] = envelope.repo!.split("/");
      prNumberForCheck = envelope.prNumber as number;
      try {
        prHeadSha = await github!.getPullRequestHeadSha(prOwner, prRepoName, prNumberForCheck);
        prCheckRunId = await github!.createCheckRun(
          prOwner,
          prRepoName,
          prHeadSha,
          "last-light/review",
          {
            output: {
              title: "Review in progress",
              summary: "Last Light is reviewing this PR. The conclusion will land here when the review completes.",
            },
          },
        );
        console.log(
          `[check] Posted in-progress check ${prCheckRunId} for ${prOwner}/${prRepoName}#${prNumberForCheck} on ${prHeadSha.slice(0, 7)}`,
        );
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(`[check] failed to create in-progress check: ${msg}`);
      }
    }

    const workflowPromise = dispatchWorkflow(skill, { ...workflowContext(), _triggerType: "webhook" });

    if (prCheckRunId !== undefined) {
      // Capture local copies so the closure doesn't depend on the loop
      // variables changing between invocations.
      const checkId = prCheckRunId;
      const owner = prOwner;
      const repo = prRepoName;
      const prNumber = prNumberForCheck;
      workflowPromise
        .then(async (result) => {
          try {
            // Re-fetch head SHA in case the PR was rebased mid-review — the
            // bot's review is keyed off the SHA at submit time, so matching
            // on the latest SHA correctly skips stale reviews.
            const headSha = await github!.getPullRequestHeadSha(owner, repo, prNumber);
            const review = await github!.getLatestBotReview(owner, repo, prNumber, headSha);
            const conclusion: "success" | "failure" | "neutral" = !result.success
              ? "neutral"
              : review?.state === "APPROVED"
              ? "success"
              : review?.state === "CHANGES_REQUESTED"
              ? "failure"
              : "neutral";
            await github!.updateCheckRun(owner, repo, checkId, {
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
            await github!.updateCheckRun(owner, repo, checkId, {
              status: "completed",
              conclusion: "neutral",
              output: { title: "Review errored", summary: `Workflow threw: ${msg.slice(0, 1000)}` },
            });
          } catch { /* ignore — best effort */ }
        });
    }

    workflowPromise.catch((err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[event] Unhandled error in workflow ${skill}: ${msg}`);
    });
  });

  // Cron jobs — fan out from each tick into one workflow run per managed repo
  // (see dispatchCronWorkflow). The scheduler itself was constructed earlier
  // so the admin dashboard could be wired with it.
  const webhooksEnabled = !!(config.webhookSecret && config.githubApp);
  const jobs = getJobs({ webhooksEnabled, db });
  for (const job of jobs) {
    cron.register(job);
  }
  if (webhooksEnabled) {
    console.log("[cron] Webhooks enabled — skipping issue/PR polling crons");
  }

  // Start everything
  await registry.startAll();
  console.log("[main] All connectors started");
  console.log("[main] Cron jobs registered");

  // Chat runs in-process via pi-ai — no long-lived server to boot.

  // Boot-time recovery: any workflow_runs left in 'running' state from a
  // previous harness lifetime have already had their sandbox containers
  // killed by cleanupOrphanedSandboxes(). Mark their stale execution rows as
  // failed and re-dispatch each run so the runner can pick up after the last
  // completed phase. Skips 'paused' runs — those intentionally wait for a
  // human approval and are resumed via the dashboard / GitHub comment flow.
  resumeOrphanedWorkflows({
    db,
    github,
    config: {
      model: config.model,
      maxTurns: config.maxTurns,
      stateDir: config.stateDir,
      sandboxDir: config.sandboxDir,
      sessionsDir: config.sessionsDir,
      sandbox: config.sandbox,
    },
    models: config.models,
    variants: config.variants,
    approvalConfig: config.approval,
    bootstrapLabel: config.bootstrapLabel,
    slackPoster: slackConnector
      ? (channelId, threadId, msg) => slackConnector!.sendMessage(channelId, threadId, msg).then(() => {})
      : undefined,
  }).catch((err) => console.error("[main] Resume sweep failed:", err));

  console.log("[main] Ready to receive events");

  // Graceful shutdown
  const shutdown = async () => {
    console.log("\n[main] Shutting down...");
    cron.stopAll();
    await registry.stopAll();
    db.close();
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  console.error("[main] Fatal error:", err);
  // Exit 78 (EX_CONFIG) to signal Docker restart policy that looping won't help.
  // Common causes: bad PEM, wrong App ID, missing env vars.
  const msg = err?.message || "";
  const isConfig = msg.includes("could not be decoded") ||
    msg.includes("not found") ||
    msg.includes("ENOENT") ||
    msg.includes("required");
  process.exit(isConfig ? 78 : 1);
});
