import { existsSync, mkdirSync, readFileSync } from "fs";
import { resolve } from "path";
import { randomUUID } from "crypto";
import { loadConfig, resolveModel, resolveVariant } from "./config.js";
import { ConnectorRegistry, GitHubWebhookConnector, SlackConnector, SessionManager, MessageDeliveryService } from "./connectors/index.js";
import { dispatch, type DispatchDeps } from "./engine/dispatcher.js";
import { CHAT_SYSTEM_SUFFIX, handleChatMessage, loadAgentContext } from "./engine/chat.js";
import { configureWorkflowAssets, validateAssets, getWorkflow } from "./workflows/loader.js";
import { ChatRunner } from "./engine/chat-runner.js";
import { buildReadSkillTool, loadChatSkillCatalogue } from "./engine/chat-skills.js";
import { configureGitAuth } from "./engine/git-auth.js";
import { StateDb } from "./state/db.js";
import { CronScheduler } from "./cron/scheduler.js";
import { getJobs } from "./cron/jobs.js";
import { dispatchCronWorkflow } from "./cron/fanout.js";
import { mountAdmin } from "./admin/index.js";
import { cleanupOrphanedSandboxes } from "./sandbox/index.js";
import { writeEgressFirewallConfigs, writeOtelCollectorConfig } from "./sandbox/egress-firewall-config.js";
import { initTelemetry, shutdownTelemetry } from "./telemetry/index.js";
import { authMiddleware } from "./admin/auth.js";
import { GitHubClient } from "./engine/github.js";
import { screenForInjection, flagPrefix } from "./engine/screen.js";
import { runSimpleWorkflow, type SimpleWorkflowRequest } from "./workflows/simple.js";
import type { RunnerCallbacks } from "./workflows/runner.js";
import { resumeOrphanedWorkflows } from "./workflows/resume.js";
import {
  ProgressNotifier,
  GitHubTransport,
  SlackTransport,
  type NotifierTransport,
  type NotifierState,
  type ProgressReporter,
} from "./notify/index.js";
import type { EventEnvelope } from "./connectors/types.js";

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
  const packageJson = JSON.parse(readFileSync(resolve("package.json"), "utf8")) as { version?: string };
  await initTelemetry(config.otel, { packageVersion: packageJson.version });
  let telemetryShutdownStarted = false;
  console.log(config.otel.enabled
    ? `[otel] enabled service=${config.otel.serviceName} forwardToSandbox=${config.otel.forwardToSandbox} includeContent=${config.otel.includeContent}`
    : "[otel] disabled");

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
  // stale configs on disk. The docker backend forwards sandbox telemetry
  // through the in-network OTEL collector (reached by IP), so the strict
  // SNI allowlist no longer needs collector hosts — that hop happens on
  // the collector's trusted outbound leg, not through the firewall.
  const proxyDir = writeEgressFirewallConfigs(config.stateDir);
  console.log(`[state] Egress firewall configs: ${proxyDir}`);

  // Generate the in-network OTEL collector config (docker backend). Derived
  // from the harness's OTEL_* backend env so the collector re-exports to the
  // same backend the harness uses — with auth headers that stay host-side.
  // Forwarding is gated on telemetry being active: when disabled (or sandbox
  // forwarding off) the collector renders an inert debug-only config so the
  // static collector IP can't be used as a sandbox exfil path.
  const collectorConfigPath = writeOtelCollectorConfig(config.stateDir, {
    active: config.otel.enabled && config.otel.forwardToSandbox,
  });
  console.log(`[state] OTEL collector config: ${collectorConfigPath} (forwarding ${config.otel.enabled && config.otel.forwardToSandbox ? "active" : "disabled"})`);

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

    // In-place "task list" progress checklist — opt-in per workflow via
    // `status_checklist: true` in the YAML. Build a transport for whichever
    // surface triggered the run (GitHub comment and/or Slack thread) and hand
    // the runner a ProgressNotifier instead of letting it post a comment per
    // phase. The notifier is created inside onRunStart because it needs the
    // workflow-run id (only known once simple.ts creates the row) to persist
    // its in-place update handles to scratch.notifier. better-sqlite3 is
    // synchronous and simple.ts invokes onRunStart synchronously before the
    // first reporter call, so the notifier is ready in time; the proxy guards
    // the brief window before assignment.
    // Which in-place surface(s) can the checklist edit? Knowable synchronously
    // (transport existence needs only github/issue or slack/channel/thread —
    // the run id is needed solely for persistence + resume handles).
    const ghChecklist = !!(github && typeof issueNumber === "number");
    const slackChecklist = !!(
      slackConnector && typeof channelId === "string" && typeof threadId === "string"
    );
    let statusChecklist = false;
    try {
      // Only activate the checklist when the workflow opts in AND there's a
      // surface to render it on — otherwise leave `reporter` undefined so the
      // runner keeps its legacy per-phase comment behavior instead of going
      // silent.
      statusChecklist =
        getWorkflow(workflowName).status_checklist === true && (ghChecklist || slackChecklist);
    } catch {
      /* unknown workflow — surfaced downstream by runSimpleWorkflow */
    }

    let notifier: ProgressNotifier | undefined;
    const reporterProxy: ProgressReporter | undefined = statusChecklist
      ? {
          start: (m) => notifier?.start(m) ?? Promise.resolve(),
          step: (k, s, d) => notifier?.step(k, s, d) ?? Promise.resolve(),
          insertStep: (st, b) => notifier?.insertStep(st, b) ?? Promise.resolve(),
          note: (m) => notifier?.note(m) ?? Promise.resolve(),
          noteTerminal: (m) => notifier?.noteTerminal(m) ?? Promise.resolve(),
        }
      : undefined;

    const notifierOnRunStart = statusChecklist
      ? (runId: string): void => {
          try {
            const saved = ((db.getWorkflowRun(runId)?.scratch?.notifier) ?? {}) as NotifierState;
            const persist = (patch: Partial<NotifierState>) => {
              const cur = ((db.getWorkflowRun(runId)?.scratch?.notifier) ?? {}) as NotifierState;
              db.updateWorkflowRunScratch(runId, { notifier: { ...cur, ...patch } });
            };
            const transports: NotifierTransport[] = [];
            if (ghChecklist && github && typeof issueNumber === "number") {
              transports.push(
                new GitHubTransport({
                  github,
                  owner,
                  repo,
                  issueNumber,
                  commentId: saved.githubCommentId,
                  save: (id) => persist({ githubCommentId: id }),
                }),
              );
            }
            if (slackChecklist && slackConnector && typeof channelId === "string" && typeof threadId === "string") {
              transports.push(
                new SlackTransport({
                  slack: slackConnector,
                  channel: channelId,
                  thread: threadId,
                  ts: saved.slackTs,
                  save: (ts) => persist({ slackTs: ts, slackChannel: channelId, slackThread: threadId }),
                }),
              );
            }
            if (transports.length > 0) notifier = new ProgressNotifier(transports);
          } catch (err: unknown) {
            const m = err instanceof Error ? err.message : String(err);
            console.warn(`[dispatch] notifier setup failed: ${m}`);
          }
        }
      : undefined;

    const callbacks: RunnerCallbacks = {
      reporter: reporterProxy,
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
      onRunStart: notifierOnRunStart
        ? async (runId: string) => {
            // Synchronous notifier setup must finish before simple.ts calls
            // reporter.start() (the next statement after it invokes this), so
            // run it first, then chain any caller-provided onRunStart.
            notifierOnRunStart(runId);
            if (onRunStart) await onRunStart(runId);
          }
        : onRunStart,
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
          otel: config.otel,
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
  // Handle events from any connector. The dispatcher turns each EventEnvelope
  // into a workflow dispatch (or in-process handler run) through one testable
  // seam; every per-event branch lives in src/engine/dispatcher.ts. main()
  // only constructs the deps and relays the typed outcome.
  const dispatchDeps: DispatchDeps = {
    db,
    github,
    dispatchWorkflow,
    sessionManager,
    // One in-process chat turn. handleChatMessage manages session resume via
    // sessionManager internally; the dispatcher uses resumeAgentSessionId only
    // to decide whether to persist a newly-minted agent session id.
    runChat: (message, messagingSessionId, sender) =>
      handleChatMessage(
        message,
        messagingSessionId,
        sender,
        sessionManager,
        { chatRunner, sessionsHomeDir: config.sessionsDir },
        { model: resolveModel(config.models, "chat"), maxTurns: 10 },
      ),
    reviewPostsCheck: config.reviewPostsCheck,
    publicUrl: config.publicUrl,
  };

  registry.onEvent(async (envelope: EventEnvelope) => {
    console.log(`[event] ${envelope.source}:${envelope.type} from ${envelope.sender}${envelope.repo ? ` on ${envelope.repo}` : ""}`);
    try {
      const outcome = await dispatch(envelope, dispatchDeps);
      if (outcome.kind === "ignored") {
        console.log(`[event] Ignored: ${outcome.reason}`);
      } else if (outcome.kind === "skipped") {
        console.log(`[event] Skipped: ${outcome.reason}`);
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[event] dispatch threw: ${msg}`);
    }
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
      otel: config.otel,
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
    if (!telemetryShutdownStarted) {
      telemetryShutdownStarted = true;
      await shutdownTelemetry();
    }
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
