import { existsSync, mkdirSync, readFileSync } from "fs";
import { resolve } from "path";
import { randomUUID } from "crypto";
import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { loadConfig, resolveModel, resolveVariant, resolveGithubAuth } from "./config/config.js";
import { ConnectorRegistry, GitHubWebhookConnector, SlackConnector, SessionManager, recordThreadMessageForThread } from "./connectors/index.js";
import {
  dispatch,
  applyPrDispatchGate,
  prPolicyConfig,
  type DispatchDeps,
} from "./engine/dispatcher.js";
import { MessageBatcher } from "./engine/chat/message-batcher.js";
import { chatSystemSuffix, handleChatMessage, loadAgentContext } from "./engine/chat/chat.js";
import { configureWorkflowAssets, validateAssets, getWorkflow } from "./workflows/loader.js";
import { ChatRunner } from "./engine/chat/chat-runner.js";
import { buildReadSkillTool, loadChatSkillCatalogue } from "./engine/chat/chat-skills.js";
import { configureGitAuth } from "./engine/github/git-auth.js";
import {
  getInstallationDirectory,
  initInstallationDirectory,
} from "./engine/github/installations.js";
import { StateDb, isTriggerActorType, type TriggerActorType } from "./state/db.js";
import { redactDbUrl } from "lastlight-shared/database-url";
import { CronScheduler, type WorkflowRunner } from "./cron/scheduler.js";
import { getJobs } from "./cron/jobs.js";
import { makeCronRunner } from "./cron/runner.js";
import { sweepSandboxes } from "./cron/sandbox-sweep.js";
import { sweepK8sSandboxes } from "./sandbox/k8s/sweep.js";
import {
  discoverGreenDependencyPrs,
  discoverRedDependencyPrs,
  REQUIRES_HUMAN_LABEL,
  type DependencyPr,
} from "./cron/dependabot-discovery.js";
import { buildCronHandlers } from "./cron/handlers.js";
import type { KnownBlock } from "@slack/web-api";
import { discoverPrsAwaitingReview } from "./cron/review-discovery.js";
import { mountAdmin } from "./admin/index.js";
import { cleanupOrphanedSandboxes } from "./sandbox/index.js";
import { mountSkillBundle } from "./sandbox/k8s/skill-bundle-route.js";
import { skillBundleRegistry } from "./sandbox/k8s/skill-bundle.js";
import { mountAgentContext } from "./sandbox/k8s/agent-context-route.js";
import { agentContextRegistry } from "./sandbox/k8s/agent-context-registry.js";
import { mountArtifactUpload } from "./sandbox/k8s/artifact-upload-route.js";
import { artifactStore } from "./sandbox/artifact-store.js";
import { writeEgressFirewallConfigs, writeOtelCollectorConfig } from "./sandbox/egress-firewall-config.js";
import { initTelemetry, shutdownTelemetry } from "./telemetry/index.js";
import { authMiddleware, authIsEnabled, actorFromContext } from "./admin/auth.js";
import { recordActivity } from "./activity.js";
import { readPackageVersion } from "./admin/version.js";
import { GitHubClient } from "./engine/github/github.js";
import { setInstallationRepos, isManagedRepo, unmanagedReposInContext } from "./managed-repos.js";
import { screenForInjection, flagPrefix } from "./engine/screen/screen.js";
import {
  runSimpleWorkflow,
  resolveRepoRunConfig,
  prepopulatesPrHeadRef,
  isPrFixShaped,
  type SimpleWorkflowRequest,
} from "./workflows/simple.js";
import {
  resolvePrState,
  resolveSpecContext,
  prScopedWorkflows,
  type PrState,
} from "./engine/pr-state.js";
import { renderContext, type ReviewTriggerOptions } from "./engine/pr-decisions.js";
import {
  REVIEW_WORKFLOW,
  bindQueuedReviewCheck,
  installReviewCheckObserver,
  openAndBindReviewCheck,
} from "./engine/review-check.js";
import { runDashboardUrl } from "./notify/model.js";
import { harvestFixMarkers } from "./engine/fix-harvest.js";
import { handleSlackReaction, registerSlackAnchor } from "./engine/feedback/slack.js";
import { feedbackAnchorObserver, pollFeedbackReactions } from "./cron/feedback-poll.js";
import { drainFeedbackExport } from "./engine/feedback/ingest.js";
import type { RunnerCallbacks } from "./workflows/runner.js";
import { resumeOrphanedWorkflows, resumeSimpleRun, type ResumeOptions } from "./workflows/resume.js";
import { createAdmissionController, type AdmissionController } from "./workflows/admission.js";
import {
  ProgressNotifier,
  GitHubTransport,
  SlackTransport,
  type NotifierTransport,
  type NotifierState,
  type ProgressReporter,
} from "./notify/index.js";
import type { EventEnvelope } from "./connectors/types.js";
import { logger } from "./logging/logger.js";
import { logPhaseEnd, logPhaseStart } from "./logging/phase-log.js";

/**
/**
 * The `review.trigger` ROUTE this dispatch arrived on, off the context key the
 * cron fan-out sets (`_reviewRoute`).
 *
 * The webhook path sets it in the dispatcher, where the event type is still in
 * hand; everything reaching `dispatchWorkflow` cold is either the sweep (which
 * says so) or a hand-triggered run, and `attention` is the conservative default
 * — the one value `after-checks` refuses.
 */
function reviewRouteFromContext(
  context: Record<string, unknown>,
): NonNullable<ReviewTriggerOptions["route"]> {
  const raw = context._reviewRoute;
  return raw === "sweep" || raw === "checks-settled" || raw === "attention" ? raw : "attention";
}

/**
 * Pre-flight validation — checks that config is sane before starting any
 * services. Exits with code 78 (EX_CONFIG) on configuration errors so
 * Docker's restart policy doesn't loop forever on a misconfigured container.
 */
function validateConfig(config: ReturnType<typeof loadConfig>): void {
  const log = logger("startup");
  const fatal = (msg: string, fields?: Record<string, unknown>) => {
    log.fatal(msg, fields);
    log.fatal("Fix your .env and restart.");
    process.exit(78); // EX_CONFIG — sysexits.h convention
  };

  if (config.githubApp) {
    const { appId, privateKeyPath } = config.githubApp;
    // No installation-id check: installations are DISCOVERED from the App JWT
    // and resolved per repo owner, because an App installed on several accounts
    // has one id per account. `GITHUB_APP_INSTALLATION_ID` is honoured as a
    // legacy fallback when set, and is no longer required.
    if (!appId) {
      fatal("GITHUB_APP_ID is required when the GitHub App is configured.");
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
      fatal(`Cannot read GITHUB_APP_PRIVATE_KEY_PATH ("${privateKeyPath}")`, { err });
    }
  }

  if (!config.webhookSecret && config.githubApp) {
    log.warn("WEBHOOK_SECRET is not set — webhook signature verification is disabled.");
  }
}

async function main() {
  const startupLog = logger("startup");
  startupLog.info(`Last Light v${readPackageVersion() ?? "unknown"} — Agent SDK Harness`);
  startupLog.info("====================================");

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
    validateAssets(config.routes, logger("workflows"));
  } catch (err: unknown) {
    startupLog.fatal((err as Error).message, { err });
    startupLog.fatal("Fix your config/overlay and restart.");
    process.exit(78); // EX_CONFIG — sysexits.h convention
  }
  validateConfig(config);
  const packageJson = JSON.parse(readFileSync(resolve("package.json"), "utf8")) as { version?: string };
  await initTelemetry(config.otel, { packageVersion: packageJson.version });
  let telemetryShutdownStarted = false;
  const configLog = logger("config");
  configLog.info(
    config.otel.enabled ? "otel enabled" : "otel disabled",
    config.otel.enabled
      ? {
          service: config.otel.serviceName,
          forwardToSandbox: config.otel.forwardToSandbox,
          includeContent: config.otel.includeContent,
        }
      : undefined,
  );

  configLog.info("Port and model", { port: config.port, model: config.model });
  const modelOverrides = Object.entries(config.models).filter(([k]) => k !== "default");
  if (modelOverrides.length > 0) {
    configLog.info("Model overrides", {
      overrides: Object.fromEntries(modelOverrides),
    });
  }

  // Clean up any sandbox containers left over from a previous run
  cleanupOrphanedSandboxes();

  // Ensure state directory structure exists (mountable as Docker volume)
  for (const sub of ["sessions", "logs", "sandboxes"]) {
    mkdirSync(resolve(config.stateDir, sub), { recursive: true });
  }
  configLog.info("State dirs", { stateDir: config.stateDir, sessionsDir: config.sessionsDir });
  configLog.info("Sandbox backend", { backend: config.sandbox });

  // Regenerate egress firewall configs (nginx ssl_preread + coredns) from
  // the allowlist source of truth. Only meaningful for the docker backend;
  // cheap enough to do unconditionally so a backend switch doesn't leave
  // stale configs on disk. The docker backend forwards sandbox telemetry
  // through the in-network OTEL collector (reached by IP), so the strict
  // SNI allowlist no longer needs collector hosts — that hop happens on
  // the collector's trusted outbound leg, not through the firewall.
  const proxyDir = writeEgressFirewallConfigs(config.stateDir);
  configLog.info("Egress firewall configs", { dir: proxyDir });

  // Generate the in-network OTEL collector config (docker backend). Derived
  // from the harness's OTEL_* backend env so the collector re-exports to the
  // same backend the harness uses — with auth headers that stay host-side.
  // Forwarding is gated on telemetry being active: when disabled (or sandbox
  // forwarding off) the collector renders an inert debug-only config so the
  // static collector IP can't be used as a sandbox exfil path.
  const collectorConfigPath = writeOtelCollectorConfig(config.stateDir, {
    active: config.otel.enabled && config.otel.forwardToSandbox,
  });
  configLog.info("OTEL collector config", {
    path: collectorConfigPath,
    forwarding: config.otel.enabled && config.otel.forwardToSandbox ? "active" : "disabled",
  });

  // Initialize state database first — ChatRunner needs SessionManager
  // (DB-backed) at construction time.
  // open() normalizes both forms (plan locked decision 9): a DATABASE_URL like
  // "file:/app/data/lastlight.db" passes through untouched; the bare dbPath
  // fallback gets resolved + `file:`-prefixed inside open(). Do NOT prefix here.
  const dbTarget = config.database.url ?? config.dbPath;
  const db = await StateDb.open(dbTarget, {
    driver: config.database.driver,
    poolMax: config.database.poolMax,
  });
  // NEVER log dbTarget raw: on the Postgres runtime it carries the userinfo,
  // and operational logs go to a sink that outlives the process.
  configLog.info("Database", { path: redactDbUrl(dbTarget), dialect: db.dialect });

  // Session manager for messaging connectors (shared across Slack, Discord, etc.)
  const sessionManager = new SessionManager(db.client, db.dialect);

  // In-process chat runner backs the messaging chat skill. One pi-ai
  // conversation per Slack/Discord thread; locked down to read-only
  // GitHub tools plus a `read_skill` tool that exposes the curated
  // chat skill catalogue. Skills are listed in the system prompt via
  // an XML <available_skills> block; the agent pulls full SKILL.md on
  // demand — same progressive-disclosure model the sandbox phases use.
  const chatSkills = loadChatSkillCatalogue();
  const readSkill = buildReadSkillTool(chatSkills.skills);
  // Resolve GitHub auth once (App wins; PAT fallback; else none). Drives the
  // chat GitHub tools, the harness client, and the chat prompt's tool section.
  const githubAuth = resolveGithubAuth(config);
  const chatGithubAuth =
    githubAuth?.kind === "app"
      ? {
          appId: githubAuth.appId,
          privateKeyPath: githubAuth.privateKeyPath,
          installationId: githubAuth.installationId,
        }
      : githubAuth?.kind === "token"
        ? { token: githubAuth.token }
        : undefined;
  // Boot-stable — the persona doesn't change under us, so it stays out of the
  // per-turn thunk below and off the filesystem on every chat message.
  const agentContext = loadAgentContext();
  const chatRunner = new ChatRunner(
    {
      model: resolveModel(config.models, "chat"),
      thinking: resolveVariant(config.variants, "chat"),
      // A thunk, not a string: the suffix advertises the ENABLED workflow set,
      // and the dashboard's per-workflow kill switch changes that without a
      // restart. The persona and skill catalogue are boot-stable, so only the
      // suffix is re-derived (and it caches on the loader's asset version).
      // The kill-switch predicate `chatSystemSuffix` takes stays SYNCHRONOUS
      // (it is applied inside `.filter()` callbacks), so the enabled set is
      // resolved ONCE per turn here and closed over — one read rather than one
      // per workflow.
      systemPrompt: async () => {
        const overrides = await db.getAllWorkflowOverrides();
        return (
          agentContext +
          chatSystemSuffix(githubAuth !== undefined, {
            // Same rule as `db.isWorkflowEnabled`: enabled unless an explicit
            // row says otherwise.
            isWorkflowEnabled: (name) => overrides.get(name)?.enabled ?? true,
          }) +
          chatSkills.catalogueXml
        );
      },
      github: chatGithubAuth,
      extraTools: chatSkills.skills.length > 0
        ? { tools: [readSkill.tool], execute: readSkill.execute }
        : undefined,
    },
    sessionManager,
  );
  const chatLog = logger("chat");
  if (chatSkills.skills.length > 0) {
    chatLog.info("Loaded skills", { names: chatSkills.skills.map((s) => s.name) });
  } else {
    chatLog.warn("No skills loaded — frontmatter missing or no matching SKILL.md found");
  }

  // The App may be installed on several ACCOUNTS, each with its own installation
  // id — and a token minted against the wrong one is rejected. The directory is
  // the single owner→installation authority every mint and every App-authed
  // Octokit resolves through, so it has to exist before either.
  if (config.githubApp) {
    initInstallationDirectory({
      appId: config.githubApp.appId,
      privateKeyPath: config.githubApp.privateKeyPath,
      fallbackInstallationId: config.githubApp.installationId,
    });
  }

  // GitHub API client for harness-level operations (posting comments, fetching
  // issues). App auth when configured; otherwise a PAT (read-only unless the
  // token carries write scope); null in chat-only mode.
  const github = config.githubApp
    ? new GitHubClient(config.githubApp)
    : config.githubToken
      ? GitHubClient.withToken(config.githubToken)
      : null;

  // The `last-light/review` check is a PROJECTION OF RUN STATE (09 → S2): this
  // is the one wiring that makes every terminal transition — `simple.ts`,
  // `resume.ts`, the queued-run TTL expiry, the admin cancel — conclude an open
  // check, instead of a `.then()` on an in-memory promise that a deploy,
  // a crash or an admission-queued run silently outlives.
  installReviewCheckObserver(db, {
    github,
    botLogin: config.botLogin,
    botMention: `@${config.botName}`,
  });

  // Feedback signals recorded while telemetry was off carry no export watermark
  // (issue #255), so enabling OTel later can still put them on the traces they
  // grade instead of starting the backend from zero. Bounded per boot; a no-op
  // when telemetry is disabled or there is no backlog.
  if (config.feedback.enabled && config.feedback.otel) await drainFeedbackExport(db);

  // Discover the repos the App can access — across EVERY installation — and seed
  // the managed-repo list. When the overlay's `managedRepos` is empty this
  // becomes the effective allowlist (getManagedRepos falls back to the union); a
  // configured list still wins. Kept live afterwards by installation webhooks
  // (github-webhook.ts). Non-fatal: on failure we fall back to whatever
  // `managedRepos` config provides. Runs before the HTTP listener opens, so the
  // list is warm before the first event.
  if (github && config.githubApp) {
    const githubLog = logger("github");
    try {
      const grants = await github.listAllInstallationRepos();
      for (const grant of grants) {
        if (grant.error) {
          githubLog.warn("Installation repo discovery failed for one account", {
            account: grant.account,
            installationId: grant.installationId,
            error: grant.error,
          });
          continue;
        }
        setInstallationRepos(grant.installationId, grant.repos);
      }
      githubLog.info("Discovered App installations", {
        installations: grants.length,
        accounts: grants.map((g) => `${g.account}=${g.installationId}(${g.repos.length})`).join(","),
      });
      if (grants.length === 0) {
        githubLog.warn(
          "The GitHub App has no installations — install it on an account before it can act",
        );
      }
    } catch (err) {
      githubLog.warn("Installation discovery failed", { err });
    }
  }

  // Configure git with a GitHub App token — only meaningful when the operator
  // opted into a global `~/.gitconfig` write (LASTLIGHT_WRITE_GLOBAL_GIT=1) and
  // only defensible with a single installation, since a global credential can
  // name exactly one. Every agent run mints its own owner-scoped token
  // regardless, so this is non-fatal and skipped when ambiguous.
  if (config.githubApp) {
    const gitAuthLog = logger("git-auth");
    try {
      const soleInstallation = await getInstallationDirectory()?.soleInstallationId();
      if (soleInstallation) {
        await configureGitAuth({
          appId: config.githubApp.appId,
          privateKeyPath: config.githubApp.privateKeyPath,
          installationId: soleInstallation,
          botLogin: config.botLogin,
        });
      }
    } catch (err: any) {
      gitAuthLog.warn("Initial token mint failed (will retry per-execution)", { err });
    }
  }

  // Late-bound: constructed after resumeOpts (below) because it closes over
  // resumeOpts. dispatchWorkflow closures run long after boot, so assignment
  // before first use is safe. Mirrors the cron/notifier late-bound patterns.
  let admissionController: AdmissionController;

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
  ): Promise<{ success: boolean; error?: string; paused?: boolean; queued?: boolean }> => {
    const log = logger("dispatch");
    // Slack-initiated workflows (explore, /explore) carry a
    // `slack:{team}:{channel}:{thread}` triggerId and don't require a
    // managed `repo` — their postComment goes back to the Slack thread.
    const slackTriggerId = typeof context.triggerId === "string" && context.triggerId.startsWith("slack:")
      ? (context.triggerId as string)
      : undefined;

    const repoStr = context.repo as string | undefined;
    if (!repoStr && !slackTriggerId) {
      const msg = `dispatchWorkflow(${workflowName}): missing 'repo' in context`;
      log.error(msg, { workflowName });
      return { success: false, error: msg };
    }
    const [owner, repo] = repoStr && repoStr.includes("/")
      ? repoStr.split("/")
      : repoStr
      ? ["", repoStr]
      : ["", ""];
    if (repoStr && (!owner || !repo)) {
      const msg = `dispatchWorkflow(${workflowName}): invalid repo format '${repoStr}'`;
      log.error(msg, { workflowName, repoStr });
      return { success: false, error: msg };
    }

    // Choke-point managedRepos guard: every trigger path (webhook, router,
    // cron, `/api/*`, resume) funnels through here, so this is the one place
    // that guarantees no workflow acts on a repo outside the allowlist —
    // notably the direct CLI/API triggers, which don't pass through the
    // connector/router ingress filters. Contexts with no concrete repo (Slack
    // triggers) yield an empty list and pass through untouched.
    const unmanaged = unmanagedReposInContext(context);
    if (unmanaged.length > 0) {
      const msg = `dispatchWorkflow(${workflowName}): refusing unmanaged repo(s): ${unmanaged.join(", ")}`;
      log.warn(msg, { workflowName, unmanaged });
      return { success: false, error: msg };
    }

    // Per-repository config layer (issue #180). Resolved at the SAME choke
    // point and for the same reason as the guard above: every trigger path
    // funnels through here, so one call covers webhook, router, cron, `/api/*`
    // and approval-resume alike. Never throws and never fails a run — a GitHub
    // outage or a malformed `.lastlight/lastlight.yml` degrades to the
    // un-overridden operator config with a warning. `github` is `null` in
    // chat-only mode, which skips the layer entirely.
    const { repoConfig, refusal } = await resolveRepoRunConfig(workflowName, context, { client: github });
    if (refusal) {
      // The repo opting itself out via `disabled.workflows`. Same refusal shape
      // as the unmanaged-repo guard, so every caller already handles it.
      const msg = `dispatchWorkflow(${workflowName}): refusing repo-disabled workflow: ${refusal}`;
      log.warn(msg, { workflowName, refusal });
      return { success: false, error: msg };
    }

    // ── The PR state machine (09-state-machine.md → S3) ────────────────────
    //
    // One resolved snapshot per dispatch, at the SAME choke point and for the
    // same reason as the two guards above: webhook, cron, `/api/*` and resume
    // all funnel through here.
    //
    // The webhook route already resolved it — the dispatcher needs
    // `runInFlight` before it can decide to dispatch at all — and hands it
    // down on `_prState`, so this costs nothing there. The cron fan-out and
    // the direct API triggers arrive COLD and resolve here, which is what
    // finally closes the gap where every nightly `fix-red-dependency-prs` run
    // carried `branch` + `reason` but an EMPTY `{{ciSection}}`, the repo's
    // default branch instead of the PR's real base, and no fork guard at all:
    // the fan-out calls this function directly and never crosses `handlePrFix`.
    const inheritedPrState =
      context._prState && typeof context._prState === "object"
        ? (context._prState as PrState)
        : null;
    let prState: PrState | null = inheritedPrState;

    // DID A HUMAN ASK FOR THIS RUN, BY NAME? Resolved once, here, for the same
    // reason the snapshot above is: every route funnels through this function,
    // and the two that can answer `true` answer it differently.
    //
    // It is NOT part of `PrState` and must not become one. The snapshot is what
    // is true of the pull request — re-resolvable from GitHub, identical for
    // every workflow that looks at the PR this minute. This is a property of
    // one DISPATCH: the same PR, at the same SHA, is explicitly requested on
    // the comment route and not on the sweep that follows it 30 minutes later.
    // Putting it on the snapshot would make `renderContext` — a pure function
    // over `PrState` — vary by how the run was triggered, and would let a
    // persisted snapshot claim a request that belonged to a different run.
    //
    // So it rides the run CONTEXT, projected below beside `prState`, which is
    // the record of what this dispatch decided rather than of what the PR is.
    const explicitRequest =
      // The event/comment route decided already (`dispatcher.ts`) — a
      // `@bot review`, a Slack ask, a review requested by name.
      context._explicitRequest === true ||
      // A direct `/api/run` (the CLI's `lastlight review`, the dashboard) is an
      // operator asking for a REVIEW by hand, and overrides mode, draft and
      // dedup exactly as `@bot review` does. Deliberately narrowed to
      // `pr-review`: the fix family's skips are budgets and live facts rather
      // than policy, and the human override for those already exists on the
      // comment path.
      (workflowName === REVIEW_WORKFLOW && context._triggerType === "api");
    if (
      !prState &&
      prScopedWorkflows().has(workflowName) &&
      owner &&
      repo &&
      typeof context.prNumber === "number"
    ) {
      prState = await resolvePrState(owner, repo, context.prNumber, {
        github,
        db,
        botLogin: config.botLogin,
        botName: config.botName,
      });
      // Only the routes that have NOT already decided are gated here. The
      // dispatcher decides for itself so it can reply to a human whose request
      // it dropped; deciding twice would double every skip and every log line.
      // It is the SAME function, reading the SAME repo-clamped config (it is
      // handed `resolveRepoPolicy`, which is this file's `resolveRepoRunConfig`),
      // so the two routes cannot answer differently.
      //
      // A skip writes NO run row, which is exactly why every gate reachable
      // from here is a LIVE precondition rather than a prior run's verdict —
      // a stored verdict read through a path that records nothing freezes, and
      // the PR is then dead with no label, no comment and no explanation
      // (09 → D1). The one exception, an ESCALATING skip, records one itself.
      const disposition = await applyPrDispatchGate(
        {
          workflowName,
          state: prState,
          policy: prPolicyConfig(repoConfig),
          // The cron fan-out marks itself `sweep` — the RELEASE MECHANISM for
          // every PR whose fix chain ended without pushing, and the only route
          // that reaches an `after-checks` PR no further `check_suite` will ever
          // fire for.
          route: reviewRouteFromContext(context),
          explicitRequest,
          logPrefix: "[dispatch]",
        },
        { db, github, botLogin: config.botLogin, botMention: `@${config.botName}` },
      );
      if (disposition.decision === "skip") {
        // Not an error: the harness correctly determined there is nothing to
        // do — including a run-lock drop, which the daily crons re-pick up.
        // Reporting it as a failure would paint a cron tick red and, on the
        // fan-out, count against `failures`.
        return { success: true };
      }
    }

    // ── The `last-light/review` check (09 → S2) ─────────────────────────────
    //
    // Created at the one choke point every route crosses, rather than in the
    // webhook branch of the dispatcher — a cron-, comment-, Slack- or
    // CLI-triggered review used to get no check at all — and completed from the
    // run's TERMINAL TRANSITION, so it can no longer strand `in_progress` across
    // a deploy. Reaching this line means some gate already said "run".
    //
    // CREATION AND PERSISTENCE ARE ONE STEP, and that is the whole of this
    // helper. The check used to be created here, unconditionally, and recorded
    // on `scratch.reviewCheck` only inside `onRunStart` — but `runSimpleWorkflow`
    // returns `{ queued: true }` BEFORE it invokes `onRunStart` when the run is
    // over the concurrency cap (and again on a duplicate trigger for an
    // already-queued run). The check was then created, never persisted, never
    // observed by the terminal observer, and never concluded. The old accidental
    // repair is gone too: while the run is `queued` it counts as active for the
    // trigger, so the 30-minute sweep resolves `run-in-flight` → placement
    // `none` and posts no superseding check. That is precisely the bug 09 → S2
    // exists to fix, reintroduced through the one path that skips `onRunStart`.
    //
    // So: nothing is created until a run ROW exists to hang it on, and it is
    // recorded in the same breath. `onRunStart` covers the ordinary path; the
    // queued path binds after the fact, below, against the row `runSimpleWorkflow`
    // did create before returning.
    const wantsReviewCheck =
      workflowName === REVIEW_WORKFLOW &&
      (repoConfig?.review ?? config.review).postsCheck &&
      !!prState?.headSha;
    let reviewCheckBound = false;
    const reviewCheckDeps = { github, botLogin: config.botLogin };
    const reviewCheckDetailsUrl = (runId: string) =>
      runDashboardUrl(config.publicUrl, runId, workflowName);
    const bindReviewCheck = async (runId: string): Promise<void> => {
      if (!wantsReviewCheck || reviewCheckBound) return;
      reviewCheckBound = true;
      await openAndBindReviewCheck(
        db,
        runId,
        {
          owner,
          repo,
          headSha: prState!.headSha,
          detailsUrl: reviewCheckDetailsUrl(runId),
        },
        reviewCheckDeps,
      );
    };
    /**
     * The queued half. `runSimpleWorkflow` writes the `queued` row and returns
     * before `onRunStart`, so the run id never reaches us — but the ROW exists,
     * keyed by exactly the trigger id `simple.ts` derived from this same
     * context.
     */
    const bindReviewCheckForQueuedRun = async (): Promise<void> => {
      if (!wantsReviewCheck || reviewCheckBound) return;
      const number =
        typeof context.issueNumber === "number"
          ? context.issueNumber
          : typeof context.prNumber === "number"
          ? context.prNumber
          : undefined;
      const triggerId = slackTriggerId ?? (number !== undefined ? `${owner}/${repo}#${number}` : undefined);
      if (!triggerId) return;
      reviewCheckBound = true;
      await bindQueuedReviewCheck(
        db,
        {
          triggerId,
          workflowName,
          owner,
          repo,
          headSha: prState!.headSha,
          detailsUrl: reviewCheckDetailsUrl,
        },
        reviewCheckDeps,
      );
    };

    // Pluck the standard fields, leave the rest in `extra` for the workflow
    // template to consume.
    const {
      _triggerType,
      _prState: _inheritedPrState,
      _reviewRoute: _ignoredReviewRoute,
      // Plucked so the wire name never reaches the run context: it is projected
      // below, once, under the name every reader uses.
      _explicitRequest: _ignoredExplicitRequest,
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
      triggeredBy: ctxTriggeredBy,
      triggerActorType: ctxTriggerActorType,
      source: ctxSource,
      ...rest
    } = context;

    // Actor logging (issue #205): who triggered this run and how. Callers can
    // set `triggerActorType` explicitly (the cron manual-fire / api routes);
    // otherwise derive it from the dispatch shape. `triggeredBy` defaults to
    // the acting handle (`sender`).
    const triggeredBy =
      (typeof ctxTriggeredBy === "string" && ctxTriggeredBy) ||
      (typeof sender === "string" ? sender : undefined);
    const triggerActorType: TriggerActorType =
      // Membership-checked, not a bare cast: `ctxTriggerActorType` is untrusted
      // `unknown` from the spread context, so an unrecognised value falls
      // through to the derived default rather than being persisted verbatim.
      (isTriggerActorType(ctxTriggerActorType) ? ctxTriggerActorType : undefined) ??
      (slackTriggerId || ctxSource === "slack"
        ? "slack"
        : _triggerType === "cron"
        ? "cron"
        : _triggerType === "api"
        ? "cli"
        : _triggerType === "chat"
        ? "slack"
        : "github");

    // Preserve channelId/threadId in extra so they're stored on the
    // workflow run context — needed by boot-time resume to rebuild the
    // Slack postComment callback after a harness restart.
    const extra: Record<string, unknown> = { ...(rest as Record<string, unknown>) };
    if (typeof channelId === "string") extra.channelId = channelId;
    if (typeof threadId === "string") extra.threadId = threadId;

    // Project the snapshot into the template variables the prompts render, and
    // persist the WHOLE thing on the run context rather than scattered leaves
    // (§S3) — so the run detail panel can show the decisions that were actually
    // taken, with the inputs that produced them, long after the live state has
    // moved on. One projection at one choke point is what makes the webhook and
    // cron dispatches of a `pr-fix`-shaped workflow carry identical context.
    if (prState) {
      const reviewConfig = repoConfig?.review ?? config.review;
      // The `spec` axis's two live reads — the issues this PR closes, and its
      // changed-file list (`docs/plans/deterministic-pr-levers.md` §Decisions,
      // D7). Gated on
      // `review.analysis.enabled`, which is operator-only, so a repo can neither
      // buy itself the extra reads nor opt out of the operator's pipeline.
      //
      // HERE rather than inside `resolvePrState` for two reasons: the reads cost
      // something and nothing but the reviewer consumes them, and locked
      // decision 8 wants the disabled path to fetch nothing at all so the
      // projection has nothing to project. Enriching at the choke point covers
      // every route — including the webhook's, whose snapshot arrives on
      // `_prState` already resolved and is enriched in place before it is
      // persisted below.
      //
      // Never throws; a failed read degrades the obligation set and says so in
      // the block rather than failing the dispatch.
      //
      // Scoped to `REVIEW_WORKFLOW` — the same constant `review-check.ts` gates
      // its own check-run projection on — rather than to every PR-scoped
      // workflow. The reviewer is the only consumer, and the fix family's
      // prompts are template files that would render none of these variables
      // while still paying for the reads. The cost of naming the workflow is
      // that a deployment which remaps `routes.github.pr_opened` to a FORK of
      // `pr-review` gets the plumbing but no obligations; that is a degradation
      // the block announces, not a silent one.
      if (reviewConfig.analysis.enabled && workflowName === REVIEW_WORKFLOW) {
        await resolveSpecContext(prState, { github });
      }
      Object.assign(
        extra,
        renderContext(
          prState,
          repoConfig?.fix ?? config.fix,
          repoConfig?.dependencies ?? config.dependencies,
          reviewConfig,
        ),
      );
      extra.prState = prState;
      // Beside the snapshot, and deliberately not inside it (see the resolution
      // above). Scoped to PR-scoped runs because they are the only ones with a
      // reader — `post-review`, whose `resolveReviewPost` needs to tell a
      // maintainer's deliberate re-review from its own re-entry — and because a
      // `false` on every issue-triage run is noise nobody can act on.
      extra.explicitRequest = explicitRequest;
    }

    // For PR-scoped read workflows, resolve the PR head ref and ask the
    // sandbox to pre-clone the repo at that branch. The agent then enters
    // a workspace that's already a checkout of the PR's actual code —
    // saves a redundant clone_repo MCP call inside the session.
    //
    // The snapshot's head ref is the authority for every PR-scoped workflow —
    // one read, already taken. It replaces the second `getPullRequest` the
    // block below used to issue for the read-only workflows, and it is the
    // only source the cron fan-out ever had for `dependabot-ci-fix` (via the
    // discoverer's `branch`, which stays as the fallback for a snapshot whose
    // PR read failed).
    let prePopulateBranch: string | undefined =
      typeof ctxPrePopulateBranch === "string" ? ctxPrePopulateBranch : undefined;
    if (
      !prePopulateBranch &&
      prState?.headRef &&
      (isPrFixShaped(workflowName) || prepopulatesPrHeadRef(workflowName))
    ) {
      prePopulateBranch = prState.headRef;
      log.info("Pre-populating workspace", {
        workflowName,
        repo: `${owner}/${repo}`,
        branch: prePopulateBranch,
        base: prState.baseRef || "?",
      });
    }
    if (!prePopulateBranch && typeof ctxBranch === "string" && ctxBranch && isPrFixShaped(workflowName)) {
      prePopulateBranch = ctxBranch;
    }
    // PR-scoped read workflows that benefit from a workspace pre-checked-out at
    // the PR's *real* head ref. Each one synthesizes a `lastlight/N-<title-slug>`
    // branch (see resolveRunBranch) that does NOT exist on the remote, so
    // prePopulateWorkspace's missing-branch fallback silently clones the
    // *default* branch — testing/demoing code that lacks the PR's changes
    // (a false-negative QA, or a before/after demo whose "after" matches
    // "before"). Resolving the head ref here pins the workspace to the actual
    // PR code. See the `prepopulate_pr_head_ref` schema key for the why.
    if (
      !prePopulateBranch &&
      prepopulatesPrHeadRef(workflowName) &&
      typeof prNumber === "number" &&
      github &&
      owner &&
      repo
    ) {
      try {
        const pr = await github.getPullRequest(owner, repo, prNumber);
        prePopulateBranch = pr.head.ref;
        // Surface the base ref so a before/after demo can fetch + check out the
        // baseline (the read-only pre-clone is shallow + single-branch at the
        // head ref, so `origin/<base>` isn't present until the agent fetches it).
        if (pr.base?.ref) extra.baseBranch = pr.base.ref;
        log.info("Pre-populating workspace", {
          workflowName,
          repo: `${owner}/${repo}`,
          headRef: prePopulateBranch,
          baseRef: pr.base?.ref ?? "?",
        });
      } catch (err: unknown) {
        log.warn("Could not resolve PR head ref; agent will need to clone via MCP", {
          workflowName,
          err,
        });
      }
    }

    // Base branch for scoping. PR-triggered runs set it from the PR's base ref
    // above; build/issue-triggered runs have no PR, so resolve the repo's real
    // default branch here. Without this, everything that diffs against the base
    // — notably the reviewer prompt's `git ... {{baseBranch}}..HEAD` — assumes
    // `main` and breaks on a `master`-default (or otherwise non-`main`) repo.
    // Best-effort: on failure fall back to `main` so the template still renders
    // a valid ref rather than an empty `..HEAD`.
    if (!extra.baseBranch && github && owner && repo) {
      try {
        extra.baseBranch = await github.getDefaultBranch(owner, repo);
      } catch (err: unknown) {
        log.warn("Could not resolve default branch; assuming main", {
          workflowName,
          repo: `${owner}/${repo}`,
          err,
        });
        extra.baseBranch = "main";
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
      triggeredBy,
      triggerActorType,
      triggerId: slackTriggerId,
      extra,
      prePopulateBranch,
      repoConfig,
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
            log.warn("Screener flagged combined issue context", {
              repo: `${owner}/${repo}`,
              issueNumber: request.issueNumber,
              reason: screen.reason || "no reason",
            });
          }
        }
      } catch (err: unknown) {
        log.warn("Failed to fetch/screen issue context", { err });
        // Non-fatal — workflow proceeds with whatever context the envelope had.
      }
    }

    // Set by `onRunStart` below, read by `onPhaseEnd` and the Slack poster.
    // Undefined only for the window before the run row exists, during which
    // neither can have fired.
    let harvestRunId: string | undefined;

    const slackPost = slackTriggerId && slackConnector && typeof channelId === "string" && typeof threadId === "string"
      ? async (msg: string) => {
          try {
            const ts = await slackConnector!.sendMessage(channelId, threadId, msg);
            // This message IS the run's answer, so it is the one most worth a
            // 👍/👎 (issue #255). Registering it here — with the run id — is
            // what lets a reaction minutes later resolve to this exact run
            // rather than merely to the thread.
            if (typeof ts === "string" && config.feedback.enabled) {
              await registerSlackAnchor(db, {
                channelId,
                threadId,
                messageId: ts,
                workflowRunId: harvestRunId,
                workflowName,
              });
            }
            // This is the workflow's ANSWER — the substantive thing the thread
            // will be asked follow-up questions about — so it belongs in the
            // thread's conversation alongside the turns `ChatRunner` records.
            // Addressed by thread because the runner never sees a messaging
            // session id; a thread with no live session records nothing.
            //
            // INSIDE the try, after the await: this transport swallows a send
            // failure, so recording outside it would write a message the user
            // never saw and have the next chat turn rehydrate it as fact —
            // the exact context drift the transcript exists to prevent.
            await recordThreadMessageForThread(
              sessionManager,
              "slack",
              channelId,
              threadId,
              "assistant",
              msg,
            );
          } catch (err: unknown) {
            log.warn("Failed to post to Slack thread", { err });
          }
        }
      : undefined;

    // In-place "task list" progress checklist — opt-in per workflow via
    // `status_checklist: true` in the YAML. Build a transport for whichever
    // surface triggered the run (GitHub comment and/or Slack thread) and hand
    // the runner a ProgressNotifier instead of letting it post a comment per
    // phase. The notifier is created inside onRunStart because it needs the
    // workflow-run id (only known once simple.ts creates the row) to persist
    // its in-place update handles to scratch.notifier. It is ready in time
    // because **simple.ts AWAITS onRunStart** before dispatching — the
    // guarantee used to come from the driver being synchronous, which it no
    // longer is, so the ordering is now explicit rather than incidental. The
    // proxy still guards the brief window before assignment.
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
          noteApproval: (m, meta) => notifier?.noteApproval(m, meta) ?? Promise.resolve(),
          footer: (m) => notifier?.footer(m) ?? Promise.resolve(),
          noteTerminal: (m) => notifier?.noteTerminal(m) ?? Promise.resolve(),
        }
      : undefined;

    const notifierOnRunStart = statusChecklist
      ? async (runId: string): Promise<void> => {
          try {
            const saved = (((await db.runs.getRun(runId))?.scratch?.notifier) ?? {}) as NotifierState;
            // Read-modify-write of the notifier handles. The transports' `save`
            // hooks stay SYNCHRONOUS on purpose — they fire from inside
            // `publish()`, mid-post — so this is invoked fire-and-forget there.
            // Losing a handle is cosmetic: a fresh status comment after a
            // restart, never a lost run.
            const persist = async (patch: Partial<NotifierState>) => {
              const cur = (((await db.runs.getRun(runId))?.scratch?.notifier) ?? {}) as NotifierState;
              await db.runs.mergeScratch(runId, { notifier: { ...cur, ...patch } });
            };
            const persistHandle = (patch: Partial<NotifierState>) => {
              void persist(patch).catch((err: unknown) => {
                log.warn("Failed to persist notifier handle", { runId, err });
              });
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
                  save: (id) => persistHandle({ githubCommentId: id }),
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
                  save: (ts) =>
                    persistHandle({ slackTs: ts, slackChannel: channelId, slackThread: threadId }),
                  // Every message the notifier posts is reactable: the status
                  // checklist, the terminal summary, an approval prompt
                  // (issue #255).
                  onPost: config.feedback.enabled
                    ? (ts) => {
                        // Synchronous hook (nothing awaits it), so the anchor
                        // write is fired and its failure logged here.
                        void registerSlackAnchor(db, {
                          channelId,
                          threadId,
                          messageId: ts,
                          workflowRunId: runId,
                          workflowName,
                        }).catch((err: unknown) => {
                          log.warn("Failed to register a Slack feedback anchor", { runId, err });
                        });
                      }
                    : undefined,
                }),
              );
            }
            if (transports.length > 0) notifier = new ProgressNotifier(transports);
          } catch (err: unknown) {
            log.warn("Notifier setup failed", { err });
          }
        }
      : undefined;

    const callbacks: RunnerCallbacks = {
      reporter: reporterProxy,
      publicUrl: config.publicUrl,
      postComment: slackPost
        ?? (github && issueNumber
          ? async (msg) => {
              try {
                // Return the new comment id: a transient comment (the enqueue
                // ack) needs a handle to retract itself with later (#244).
                return await github.postComment(owner, repo, issueNumber as number, msg);
              } catch (err: unknown) {
                log.warn("Failed to post comment", { err });
              }
            }
          : undefined),
      onPhaseStart: async (phase) => {
        logPhaseStart(log, workflowName, phase);
        // Refresh the Slack thinking indicator so long-running phases
        // don't leave the thread looking dead. threadId doubles as both
        // the message anchor and the thread root for DM threads.
        if (slackPost && slackConnector && typeof channelId === "string" && typeof threadId === "string") {
          slackConnector.showTyping(channelId as string, threadId as string, threadId as string).catch(() => {});
        }
      },
      onPhaseEnd: async (phase, result) => {
        logPhaseEnd(log, workflowName, phase, result);
        // The marker harvest (09 → S1). This is the ONLY moment the two marker
        // lines exist in memory — `{{phaseOutputs}}` is empty across a run
        // boundary and the shared per-PR workspace is `reset --hard`-ed between
        // runs, so a marker not persisted here is gone for good.
        if (harvestRunId) await harvestFixMarkers(db, harvestRunId, workflowName, phase, result.output);
      },
      onRunStart: async (runId: string) => {
        // The run id is not knowable when this object is built — the row is
        // created inside `runSimpleWorkflow` — and `onPhaseEnd` needs it to
        // write the harvest. This callback fires synchronously before the first
        // phase, so the assignment is always in place by the time it is read.
        harvestRunId = runId;
        // Notifier setup must finish before simple.ts calls reporter.start()
        // (the next statement after it invokes this), so it runs FIRST — and is
        // awaited, since its scratch read is no longer synchronous.
        if (notifierOnRunStart) await notifierOnRunStart(runId);
        // Create AND bind the review check the moment the row exists — this is
        // what makes it a projection of run state rather than of an in-memory
        // promise, and it is why every terminal path resolves it for free.
        await bindReviewCheck(runId);
        // The activity log's one workflow seam (issue #206). Here, rather than
        // at the top of dispatchWorkflow, because this fires only once the run
        // ROW exists — so every guard has passed and there is a real target to
        // point at.
        //
        // Gated on the actor type: a cron fan-out dispatches once PER REPO, and
        // those dispatches are not user actions. Logging them would make the
        // dominant row source a thing no human did, and would bury the actions
        // somebody actually took. The fire is recorded once, at its cause, as
        // `cron.fire` from the runner — the same reason `cron_runs` keys on the
        // cron rather than the workflow (spec/10-state.md → `cron_runs`).
        if (triggerActorType !== "cron" && triggerActorType !== "system") {
          await recordActivity(db, {
            actorLogin: triggeredBy ?? null,
            actorType: triggerActorType,
            action: "workflow.trigger",
            targetType: "workflow_run",
            targetId: runId,
            detail: {
              workflow: workflowName,
              ...(repoStr ? { repo: repoStr } : {}),
            },
          });
        }
        if (onRunStart) await onRunStart(runId);
      },
    };

    let result: Awaited<ReturnType<typeof runSimpleWorkflow>> | undefined;
    try {
      result = await runSimpleWorkflow(
        workflowName,
        request,
        {
          model: config.model,
          maxTurns: config.maxTurns,
          stateDir: config.stateDir,
          sandboxDir: config.sandboxDir,
          sessionsDir: config.sessionsDir,
          sandbox: config.sandbox,
          buildAssets: config.buildAssets,
          buildAssetsDir: config.buildAssetsDir,
          otel: config.otel,
        },
        callbacks,
        db,
        config.models,
        config.approval,
        config.bootstrapLabel,
        config.variants,
        config.concurrency,
      );
      const summary = result.phases.map((p) => `${p.phase}=${p.success ? "ok" : "fail"}`).join(", ");
      if (result.queued) {
        log.info("Queued (concurrency cap reached)", { workflowName });
        // A queued run never reaches `onRunStart` — `runSimpleWorkflow` returns
        // the moment it writes the `queued` row — so bind the check here instead
        // of leaving the run's only PR-visible artifact unowned. The row is
        // found the same way `simple.ts` found (or created) it: by trigger id.
        // Admission promotes it through `resumeSimpleRun`, which takes no
        // callbacks at all, so this is the ONLY point at which a queued review's
        // check can be bound to its run.
        await bindReviewCheckForQueuedRun();
      } else if (result.paused) {
        log.info("Paused", { workflowName, summary });
      } else if (result.success) {
        log.info("Completed", { workflowName, summary });
      } else {
        log.warn("Failed", { workflowName, summary });
      }
      return { success: result.success, paused: result.paused, queued: result.queued };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error("Threw", { workflowName, err });
      return { success: false, error: msg };
    } finally {
      // Event-driven admission: after each dispatch settles, pull the next
      // queued run into a free slot. Skip it when THIS dispatch just requeued
      // on quota backpressure — re-promoting instantly would re-hit the full
      // quota in a tight loop; the periodic sweep + real completions pace the
      // retry.
      if (!result?.backpressure) {
        admissionController?.admitNext().catch((err: unknown) => {
          logger("admission").warn("admitNext error", { err });
        });
      }
    }
  };

  // Set up connector registry
  const registry = new ConnectorRegistry();

  // Shared HTTP server — always boots, independent of GitHub. `main()` owns the
  // Hono app + serve() lifecycle that the webhook connector used to own, so the
  // `lastlight` CLI + admin dashboard + /api/* work even with no GitHub App
  // (chat-only / PAT modes). The root /health is what the CLI hits
  // (src/cli/cli.ts, cli-server.ts).
  const app = new Hono();
  app.get("/health", (c) => c.json({ status: "ok" }));
  mountSkillBundle(app, skillBundleRegistry);
  mountAgentContext(app, agentContextRegistry);
  mountArtifactUpload(app, artifactStore);

  // GitHub webhook connector (optional — requires both webhook secret and GitHub
  // App). It registers /webhooks/github onto the shared app; it no longer owns
  // the HTTP listener.
  let githubConnector: GitHubWebhookConnector | null = null;
  if (config.webhookSecret && config.githubApp) {
    githubConnector = new GitHubWebhookConnector({
      port: config.port,
      webhookSecret: config.webhookSecret,
      botLogin: config.botLogin,
      app,
      // Settle-aware gate: emit a dependency-PR checks event only once the head
      // SHA's checks have fully settled (green/red), so a multi-app repo fires
      // one event per SHA — the last suite to complete — not one per suite.
      // `excludeApp` is the self-gating deadlock fix (07 §7.2): our own
      // `last-light/review` check is on the same head SHA, so without it a
      // queued/in-progress review pins this aggregate at `pending` and the
      // settle event that would dispatch the review never fires.
      getChecksConclusion: github
        ? (owner, repo, ref) =>
            github.getChecksConclusion(owner, repo, ref, { excludeApp: config.botName })
        : undefined,
      // The FORK-PR fallback. `check_suite` / `check_run` payloads carry
      // `pull_requests[]` only for a same-repo PR, so without this every
      // check-driven route is same-repo-only — and under the packaged
      // `review.trigger: after-checks` a fork PR defers on `pr.opened`, posts
      // the `queued` placeholder, and never receives the settle event that
      // would conclude it. Asked of the BASE repo, which is the one the App is
      // installed on, so it needs no access to the fork.
      listOpenPrNumbersForHeadSha: github
        ? (owner, repo, sha) => github.listOpenPrNumbersForHeadSha(owner, repo, sha)
        : undefined,
      // Only broaden `check_suite.completed` beyond dependency PRs when the
      // operator's mode actually consumes a settle event. Deliberately the
      // OPERATOR's value, not a repo's: emitting is what costs event volume,
      // and a repo that opts itself into `after-checks` under an `eager`
      // operator is covered by the 30-minute `check-prs-awaiting-review` sweep.
      reviewTrigger: () => config.review.trigger,
      // The harness client memoizes an Octokit per installation; drop it when
      // the App is uninstalled so a re-install can't be served by a dead one.
      onInstallationRemoved: (installationId) => github?.forgetInstallation(installationId),
      // Team/org membership changed — forget the affected slice of the
      // dashboard visibility cache (issue #169). Deleting rows is the whole
      // response: the cache is filled on demand per logged-in user, so the next
      // dashboard request re-resolves, and only for people who actually use it.
      onTeamChanged: ({ org, teamSlug, login }) => {
        // The hook's contract is synchronous — the webhook connector never
        // awaits it — so the invalidation is fired and its failure logged here
        // rather than propagated. The cache refills on demand either way.
        const warn = (err: unknown) =>
          logger("team-visibility").warn("Failed to invalidate team visibility cache", {
            org,
            teamSlug,
            login,
            err,
          });
        try {
          if (login) void db.teams.invalidateLogin(login).catch(warn);
          else if (teamSlug) void db.teams.invalidateTeam(org, teamSlug).catch(warn);
        } catch (err: unknown) {
          warn(err);
        }
      },
    });
    registry.register(githubConnector);
  }

  // Slack connector (optional — only if SLACK_BOT_TOKEN is set)
  let slackConnector: SlackConnector | null = null;
  if (config.slack) {
    slackConnector = new SlackConnector(
      {
        botToken: config.slack.botToken,
        mode: config.slack.mode,
        appToken: config.slack.appToken,
        signingSecret: config.slack.signingSecret,
        // Webhook mode mounts /webhooks/slack on the shared HTTP server.
        honoApp: app,
        allowedUsers: config.slack.allowedUsers,
        deliveryChannel: config.slack.deliveryChannel,
        // Match a Slack user's email to a `users` row so a Slack-initiated
        // run/approval attributes to their GitHub login (issue #205).
        users: db.users,
        botIdentifier: "", // Will be resolved from Slack API on connect
        // Every chat reply the bot posts becomes a reaction target (issue
        // #255). The `ts` is only ever knowable here, in the send response —
        // and the connector layer must not reach for the database itself, so
        // the write is injected as a hook.
        // `workflowName: "chat"` because a chat turn has no workflow run to
        // borrow a name from, and a null there renders as "unattributed" — the
        // label for a signal we could not place at all. Chat is placed
        // precisely; it just isn't a workflow. Matches how the executions
        // ledger already names this surface (`skill: "chat"`).
        onBotMessage: config.feedback.enabled
          ? ({ channelId, messageId, sessionId }) => {
              // Synchronous hook (the connector never awaits it), so the anchor
              // write is fired and its failure logged here.
              void registerSlackAnchor(db, {
                channelId,
                messageId,
                messagingSessionId: sessionId,
                workflowName: "chat",
              }).catch((err: unknown) => {
                logger("feedback").warn("Failed to register a Slack feedback anchor", { err });
              });
            }
          : undefined,
      },
      sessionManager
    );
    registry.register(slackConnector);

    // Score emoji reactions on the bot's own messages (issue #255). Needs the
    // `reactions:read` bot scope + the reaction_added/removed subscriptions;
    // without them Slack never delivers and this is simply dormant.
    if (config.feedback.enabled) {
      slackConnector.onReactionAction((event) => {
        // The connector's handler slot is synchronous and nothing awaits it, so
        // the ingest is fired here and a failure logged rather than propagated.
        void handleSlackReaction(
          {
            db,
            botLogin: config.botLogin,
            otel: config.feedback.otel,
            allowedUsers: config.slack?.allowedUsers,
          },
          event,
        ).catch((err: unknown) => {
          logger("feedback").warn("Failed to handle a Slack reaction", { err });
        });
      });
    }

  }

  // Host-side cron handlers — what a `cron-*.yaml` may name in `handler:`.
  // Built here rather than imported as a constant because every handler needs
  // collaborators that only exist once the server has booted.
  //
  // The digest is registered only when there is BOTH a GitHub client to read
  // repos through and a Slack connector to post with. Missing either, the
  // handler is absent and `getJobs` drops `cron-digest.yaml` with a warning
  // naming it — which is the whole point: a cron that silently ticks into
  // nothing is exactly the failure mode this feature replaced.
  const cronHandlers = buildCronHandlers({
    db,
    digest:
      github && slackConnector
        ? {
            db,
            github,
            configClient: github,
            routing: config.slack
              ? { repoChannels: config.slack.repoChannels, deliveryChannel: config.slack.deliveryChannel }
              : undefined,
            config: config.digest,
            escalationLabel: REQUIRES_HUMAN_LABEL,
            post: async (channel, text, blocks) => {
              // No unfurls: a digest cites several PRs, and a preview card per
              // citation buries the six lines of summary they annotate.
              const ts = await slackConnector!.sendMessage(channel, null, text, blocks as KnownBlock[], {
                unfurl: false,
              });
              // A digest is a thing the bot wrote, so a 👍/👎 on it is a real
              // signal about whether it is worth sending (issue #255). The `ts`
              // exists only in this response — a send site that drops it makes
              // the reaction unattributable.
              if (typeof ts === "string" && config.feedback.enabled) {
                await registerSlackAnchor(db, { channelId: channel, messageId: ts, workflowName: "repo-digest" });
              }
            },
          }
        : undefined,
  });

  // PR discoverers keyed by a cron context's `discover` value. Each returns the
  // eligible PRs (in code, no LLM) and the runner fans out one bounded single-PR
  // run each (with prNumber + head ref) — the shape the pr.* webhooks produce.
  // Add a discoverer + a `cron-*.yaml` with the matching `discover:` key to
  // introduce a new sweep. The harness `github` client (App auth) is passed to
  // every discoverer, so a discoverer only needs the subset of it it uses.
  const PR_DISCOVERERS: Record<
    string,
    (
      repos: string[],
      gh: GitHubClient,
      opts: { log?: (msg: string) => void },
    ) => Promise<DependencyPr[]>
  > = {
    // The green sweep's notion of "green" must match the webhook's: on a repo
    // with no *required* checks, `mergeable_state: "clean"` is true for a PR
    // whose CI is red. `requireSettledChecks` makes it ask the checks too.
    "green-dependency-prs": (repos, gh, opts) =>
      discoverGreenDependencyPrs(repos, gh, {
        ...opts,
        requireSettledChecks: config.dependencies.requireSettledChecks,
        botName: config.botName,
      }),
    "red-dependency-prs": (repos, gh, opts) =>
      discoverRedDependencyPrs(repos, gh, { ...opts, botName: config.botName }),
    // The pr-review cron: find open PRs awaiting review and fan out one single-PR
    // pr-review run each. Replaces the old `mode: scan` review run, which ran the
    // whole listing/reviewing inside the sandbox with a static token it couldn't
    // re-mint and no way to hand its chosen PR to post-review.
    //
    // A pure CANDIDATE FINDER (09 → S2): it filters nothing but "open, not ours".
    // Draft, already-reviewed-at-this-SHA, run-in-flight and the trigger mode are
    // all decided once by `resolveReviewTrigger` at the dispatch choke point,
    // which the webhook route crosses too.
    "prs-awaiting-review": (repos, gh, opts) =>
      discoverPrsAwaitingReview(repos, gh, { ...opts, botLogin: config.botLogin }),
  };

  // Construct the cron scheduler before mounting admin so the dashboard can
  // list/toggle/edit registered cron jobs. Jobs are registered further down
  // (after we know whether webhooks are enabled). The runner closes over
  // `dispatchWorkflow`, which is defined earlier in this file. Named (not inline)
  // so the admin `triggerCron` callback can reuse it to fire a cron on demand.
  const cronRunner: WorkflowRunner = makeCronRunner({
    db,
    github,
    discoverers: PR_DISCOVERERS,
    dispatch: dispatchWorkflow,
  });
  const cron = new CronScheduler(db, cronRunner);

  // Options for the ledger-driven resume machinery (`resumeSimpleRun`). Shared
  // by the boot-time orphan sweep (`resumeOrphanedWorkflows`, below) AND the
  // dashboard/CLI "retry a failed run" callback (`retryWorkflow`, in mountAdmin)
  // so both reconstruct context from the stored `workflow_runs` row identically.
  const resumeOpts: ResumeOptions = {
    db,
    github,
    config: {
      model: config.model,
      maxTurns: config.maxTurns,
      stateDir: config.stateDir,
      sandboxDir: config.sandboxDir,
      sessionsDir: config.sessionsDir,
      sandbox: config.sandbox,
      buildAssets: config.buildAssets,
      buildAssetsDir: config.buildAssetsDir,
      otel: config.otel,
    },
    models: config.models,
    variants: config.variants,
    approvalConfig: config.approval,
    bootstrapLabel: config.bootstrapLabel,
    publicUrl: config.publicUrl,
    // Boot-recovery's Slack transport. Records into the thread's conversation
    // for the same reason the live `slackPost` above does — a run that finished
    // after a restart still owes its thread a transcript.
    slackPoster: slackConnector
      ? (channelId, threadId, msg) =>
          slackConnector!.sendMessage(channelId, threadId, msg).then(() =>
            recordThreadMessageForThread(sessionManager, "slack", channelId, threadId, "assistant", msg),
          )
      : undefined,
  };

  // Construct the admission controller now that resumeOpts is ready.
  // `admissionController` was declared (let) above dispatchWorkflow so the
  // closure can reference it; we assign here, after resumeOpts.
  admissionController = createAdmissionController({
    db,
    resumeOpts,
    maxWorkflows: config.concurrency.maxWorkflows,
    maxQueueWaitMs: config.concurrency.maxQueueWaitMs,
    backpressureMode: config.sandbox === "kubernetes",
  });

  // Mount admin dashboard on the shared HTTP server (always available).
  {
    const adminLog = logger("admin");
    mountAdmin(app, db, {
      cronScheduler: cron,
      triggerCron: cronRunner,
      // "Run now" for a host-side cron. Resolved against the SAME registry the
      // scheduler uses, so a manual fire is indistinguishable from a tick. An
      // unknown name throws rather than silently no-opping — the route has
      // already established the cron exists, so an absent handler here means
      // the registry declined to build it (e.g. no Slack connector), and that
      // is worth surfacing to whoever pressed the button.
      runCronHandler: async (handler, context) => {
        const fn = cronHandlers[handler];
        if (!fn) throw new Error(`No host-side cron handler named "${handler}" is available on this instance`);
        await fn(context);
      },
      // The three collaborators `POST /prs/:owner/:repo/:number/retry` needs to
      // do what `lastlight pr retry` asks: resolve the PR, cross the same gate
      // every other route crosses, and dispatch. `resolveRepoPolicy` is the very
      // same closure `dispatchDeps` gets below — one resolution of a repo's
      // clamped budgets, so the admin route can't read them looser than the repo
      // set them.
      github,
      dispatchWorkflow,
      resolveRepoPolicy: async (workflowName, context) => {
        const { repoConfig } = await resolveRepoRunConfig(workflowName, context, { client: github });
        return repoConfig;
      },
      stateDir: config.stateDir,
      sessionsDir: config.sessionsDir,
      buildAssetsDir: config.buildAssetsDir,
      buildAssets: config.buildAssets,
      adminPassword: process.env.ADMIN_PASSWORD ?? "",
      adminSecret: process.env.ADMIN_SECRET ?? "lastlight-dev-secret",
      publicConfig: config.publicConfig,
      builtInRoot: config.builtInRoot,
      overlayDir: config.overlayDir,
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
          adminLog.warn("Cannot resume workflow: GitHub App not configured", { runId: workflowRun.id });
          return;
        }
        // Derive owner/repo for the resume dispatch. Prefer the triggerId
        // (owner/repo#N) but fall back to the row's own (owner, BARE repo) pair
        // so a run keyed on a non-GitHub triggerId (e.g. a Slack-thread
        // override) still resumes from the dashboard/focused-approval flow.
        let [owner, repo] = workflowRun.triggerId.includes("/")
          ? workflowRun.triggerId.replace(/#\d+$/, "").split("/")
          : ["", ""];
        if (!owner || !repo) {
          const ctxOwner = (workflowRun.context?.owner as string | undefined) || "";
          owner = workflowRun.owner || ctxOwner;
          repo = workflowRun.repo || "";
        }
        const issueNumber = workflowRun.issueNumber;
        if (!owner || !repo || !issueNumber) {
          adminLog.warn("Cannot resume workflow: missing owner/repo/issueNumber", { runId: workflowRun.id });
          return;
        }
        await db.runs.setRunning(workflowRun.id);
        adminLog.info("Resuming after dashboard approval", {
          workflowName: workflowRun.workflowName,
          repo: `${owner}/${repo}`,
          issueNumber,
          sender,
        });
        dispatchWorkflow(workflowRun.workflowName, {
          repo: `${owner}/${repo}`,
          issueNumber,
          title: `Issue #${issueNumber}`,
          body: "",
          sender,
          _triggerType: "admin",
        }).catch((err) => adminLog.error("Resume failed", { err }));
      },
      // Retry a FAILED or CANCELLED run, resuming from where it stopped with the
      // same context. Unlike `resumeWorkflow` (approval-gate resume, which
      // rebuilds a lossy owner/repo/issueNumber context and bails on non-issue
      // runs), this re-enters via `resumeSimpleRun`, reconstructing the full
      // context from the stored `workflow_runs.context` + `scratch` — so it also
      // retries Slack-thread-scoped runs (e.g. an `explore` started from Slack).
      // The failed phase's ledger row is `success=0`, so it re-runs while
      // already-succeeded phases skip; a queue-dropped `cancelled` run ran no
      // phases and starts clean.
      retryWorkflow: async (workflowRun, sender) => {
        if (workflowRun.status !== "failed" && workflowRun.status !== "cancelled") {
          adminLog.warn("Cannot retry: not in a retryable status", {
            runId: workflowRun.id,
            status: workflowRun.status,
          });
          return;
        }
        // Compare-and-set: flip failed/cancelled→running and clear the terminal
        // markers. If a racing retry already flipped it, changes===0 and we don't
        // dispatch.
        const changed = await db.runs.restartRun(workflowRun.id);
        if (changed !== 1) {
          adminLog.warn("Retry: run is no longer retryable (raced) — skipping dispatch", {
            runId: workflowRun.id,
          });
          return;
        }
        const fresh = await db.runs.getRun(workflowRun.id);
        if (!fresh) return;
        adminLog.info("Retrying", {
          workflowName: fresh.workflowName,
          runId: fresh.id,
          previousPhase: workflowRun.currentPhase,
          sender,
        });
        resumeSimpleRun(fresh, resumeOpts).catch((err) =>
          adminLog.error("Retry failed", { runId: fresh.id, err }));
      },
    });
    adminLog.info("Dashboard mounted at /admin");
  }

  // Protect API endpoints with auth when any login method is configured
  // (password OR OAuth) — same gate as the dashboard, via the shared helper.
  const adminPassword = process.env.ADMIN_PASSWORD ?? "";
  const adminSecret = process.env.ADMIN_SECRET ?? "lastlight-dev-secret";
  const apiAuthEnabled = authIsEnabled({
    adminPassword,
    slackOAuthClientId: process.env.SLACK_OAUTH_CLIENT_ID,
    slackOAuthClientSecret: process.env.SLACK_OAUTH_CLIENT_SECRET,
    githubOAuthClientId: process.env.GITHUB_OAUTH_CLIENT_ID,
    githubOAuthClientSecret: process.env.GITHUB_OAUTH_CLIENT_SECRET,
    githubAllowedOrg: process.env.GITHUB_ALLOWED_ORG,
  });
  const apiLog = logger("api");
  if (apiAuthEnabled) {
    app.use("/api/*", authMiddleware(apiAuthEnabled, adminSecret));
    apiLog.info("API endpoints protected with auth");
  }

  // API endpoint for CLI triggers
  app.post("/api/run", async (c) => {
    const body = await c.req.json();
    // Accept either `skill` (legacy) or `workflow` (preferred). They map 1:1
    // for the four agent skills (issue-triage, pr-review, repo-health,
    // issue-comment) which are now backed by single-phase YAML workflows.
    const workflowName = (body.workflow ?? body.skill) as string | undefined;
    const context = (body.context ?? {}) as Record<string, unknown>;

    if (!workflowName) {
      return c.json({ error: "Missing 'workflow' (or 'skill') field" }, 400);
    }

    // Reject unmanaged repos up front so the CLI caller gets an immediate,
    // clear error. The dispatch below is fire-and-forget (returns 202 then runs
    // async), so dispatchWorkflow's own guard alone would be invisible here.
    const unmanaged = unmanagedReposInContext(context);
    if (unmanaged.length > 0) {
      return c.json({ error: `Repo not managed: ${unmanaged.join(", ")}` }, 403);
    }

    // Fail a context the dispatcher will reject BEFORE returning 202. The
    // dispatch below is fire-and-forget, so without this the caller gets
    // `{accepted: true}` and an execution id for a run that dies moments later
    // in the harness log — indistinguishable, from the CLI, from success.
    // Mirrors `dispatchWorkflow`'s own condition exactly, Slack exemption
    // included: a `slack:`-prefixed triggerId legitimately carries no repo.
    const hasSlackTrigger =
      typeof context.triggerId === "string" && context.triggerId.startsWith("slack:");
    if (typeof context.repo !== "string" && !hasSlackTrigger) {
      return c.json(
        { error: `Missing 'repo' in context for workflow '${workflowName}'` },
        400,
      );
    }

    apiLog.info("CLI triggered", { workflowName });

    // Run asynchronously — return immediately with a stable id the caller
    // can correlate with workflow_runs in the dashboard.
    const executionId = randomUUID();
    // Actor logging (issue #205): attribute to the authenticated CLI user when
    // the token carries a login (OAuth), else dispatchWorkflow falls back to
    // the context `sender` and the `cli` actor type (from `_triggerType: api`).
    const apiActor = actorFromContext(c);
    dispatchWorkflow(workflowName, {
      ...context,
      ...(apiActor ? { triggeredBy: apiActor } : {}),
      _triggerType: "api",
    }).catch((err: unknown) => {
      apiLog.error("Workflow failed", { workflowName, err });
    });

    return c.json({ accepted: true, executionId, workflow: workflowName }, 202);
  });

  // API endpoint for build cycle triggers (issue URL)
  app.post("/api/build", async (c) => {
    const body = await c.req.json();
    const { owner, repo, issueNumber, issueTitle, issueBody, issueLabels, sender } = body;

    if (!owner || !repo || !issueNumber) {
      return c.json({ error: "Missing owner, repo, or issueNumber" }, 400);
    }
    if (!isManagedRepo(`${owner}/${repo}`)) {
      return c.json({ error: `Repo not managed: ${owner}/${repo}` }, 403);
    }

    apiLog.info("CLI build triggered", { repo: `${owner}/${repo}`, issueNumber });

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
      // Attribute to the authenticated CLI user when the token carries a login
      // (OAuth); else falls back to the `sender` handle (issue #205).
      ...(actorFromContext(c) ? { triggeredBy: actorFromContext(c) } : {}),
      _triggerType: "api",
    }).catch((err) => {
      apiLog.error("Build failed", { err });
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
    publicUrl: config.publicUrl,
    // ONE config at the dispatch gate. The dispatcher decides for itself (it
    // has to — it replies to the human whose request it dropped, and its
    // dispatches are fire-and-forget), so the way to keep it from carrying a
    // second, operator-only view of policy is to hand it the very same
    // resolution `dispatchWorkflow` performs below. `fetchRepoLayer` memoises
    // per repo for 60 s, so the pair costs one conditional request between them.
    resolveRepoPolicy: async (workflowName, context) => {
      const { repoConfig } = await resolveRepoRunConfig(workflowName, context, { client: github });
      return repoConfig;
    },
  };

  // Wire Slack approval buttons into the SAME approval-resolution path as the
  // `/approve` slash command. The connector verifies + parses the button click
  // (on /webhooks/slack/interactions) and hands us the workflow run id; we force
  // the route to `approval-response`, reusing the whole dispatcher/resume seam.
  if (slackConnector) {
    slackConnector.onApprovalAction(async ({ decision, workflowRunId, sender, envelope }) => {
      await dispatch(envelope, {
        ...dispatchDeps,
        route: async () => ({
          action: "handler",
          handler: "approval-response",
          context: { decision, workflowRunId, sender, source: "slack" },
        }),
      });
    });
  }

  // One chat turn over HTTP — `lastlight chat` without a messaging platform.
  // Routes through the SAME dispatcher seam Slack uses (forcing the chat
  // handler), so the executions row, agent-session resume, and telemetry are
  // recorded identically and the turn shows up in the dashboard Chat tab. The
  // synthetic envelope's reply() just captures the assistant text to return.
  app.post("/api/chat", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const message = typeof body.message === "string" ? body.message : "";
    if (!message.trim()) return c.json({ error: "Missing 'message'" }, 400);
    const user = typeof body.user === "string" && body.user ? body.user : "cli";
    const threadId = typeof body.thread === "string" && body.thread ? body.thread : null;

    const session = await sessionManager.getOrCreateSession({
      platform: "cli", channelId: user, threadId, userId: user,
    });

    let reply = "";
    const envelope: EventEnvelope = {
      id: session.id,
      source: "cli",
      type: "message",
      sender: user,
      senderIsBot: false,
      body: message,
      raw: { cli: true },
      reply: async (msg: string) => { reply = msg; },
      timestamp: new Date(),
    };

    const outcome = await dispatch(envelope, {
      ...dispatchDeps,
      route: async () => ({
        action: "handler",
        handler: "chat",
        context: { sessionId: session.id, message, sender: user },
      }),
    });

    return c.json({ text: reply, thread: threadId ?? session.id, sessionId: session.id, outcome: outcome.kind });
  });

  const eventLog = logger("event");
  const handleEnvelope = async (envelope: EventEnvelope) => {
    eventLog.info("Received", {
      source: envelope.source,
      type: envelope.type,
      sender: envelope.sender,
      repo: envelope.repo,
    });
    try {
      const outcome = await dispatch(envelope, dispatchDeps);
      if (outcome.kind === "ignored") {
        eventLog.info("Ignored", { reason: outcome.reason });
      } else if (outcome.kind === "skipped") {
        eventLog.info("Skipped", { reason: outcome.reason });
      }
    } catch (err: unknown) {
      eventLog.error("Dispatch threw", { err });
    }
  };

  // Batch bursty messaging input per session BEFORE routing: a rapid Slack
  // burst is collected, sorted into send order, and collapsed into ONE
  // envelope so it's classified once and answered as a single ordered turn.
  // Gated on `type === "message"` — only messaging connectors emit that here
  // (GitHub events have richer types; the CLI dispatches directly, not via the
  // registry). Tunable settle window via CHAT_BATCH_DEBOUNCE_MS (default 700ms;
  // 0 disables).
  const messageBatcher = new MessageBatcher({
    dispatch: handleEnvelope,
    debounceMs: Number.parseInt(process.env.CHAT_BATCH_DEBOUNCE_MS || "700", 10),
  });

  registry.onEvent(async (envelope: EventEnvelope) => {
    if (envelope.type === "message") {
      messageBatcher.submit(envelope);
      return;
    }
    await handleEnvelope(envelope);
  });

  // Cron jobs — fan out from each tick into one workflow run per managed repo
  // (see dispatchCronWorkflow). The scheduler itself was constructed earlier
  // so the admin dashboard could be wired with it. Every job (health/security
  // reports + issue/PR polling) drives a GitHub-scoped workflow, so skip
  // registration entirely without a GitHub client — a chat-only instance would
  // otherwise fire periodic no-op dispatch failures.
  const webhooksEnabled = !!(config.webhookSecret && config.githubApp);
  if (github) {
    const jobs = await getJobs({ webhooksEnabled, db, handlers: cronHandlers });
    for (const job of jobs) {
      cron.register(job);
    }
    if (webhooksEnabled) {
      logger("cron").info("Webhooks enabled — skipping issue/PR polling crons");
    }
  } else {
    logger("cron").info("No GitHub client — skipping all cron jobs (chat-only mode)");
  }

  // Sandbox-workspace reaping backstop (issue #106) — a DIRECT (non-sandboxed)
  // job, registered regardless of `github` so it runs in chat-only mode too.
  // Reap-on-completion (workflows/simple.ts) handles the common case; this
  // sweeps failed/crashed leftovers and bounds the reusable per-PR cache. It
  // replaces the out-of-band host cron (scripts/cleanup-sandboxes.sh).
  // The `kubernetes` backend reclaims idle cluster PVCs (Plan 5) AND sweeps the
  // host-local artifact dirs its pods upload to (`<sandboxDir>/<taskId>`, since
  // the artifact store is host-local on every backend) — both via
  // `sweepK8sSandboxes`, which stands in for the host-dir sweep that's disabled
  // on k8s. Every other backend keeps the original host-dir sweep.
  const sweepCfg = config.cleanup.sandbox;
  if (sweepCfg.enabled) {
    cron.registerDirect({
      name: "sandbox-sweep",
      schedule: sweepCfg.sweepSchedule,
      handler: async () => {
        if (config.sandbox === "kubernetes") {
          await sweepK8sSandboxes({
            retentionHours: sweepCfg.retentionHours,
            maxIdlePVCs: sweepCfg.maxDirs,
            maxDirs: sweepCfg.maxDirs,
            stateDir: config.stateDir,
            sandboxDir: config.sandboxDir,
            trigger: "cron",
          });
          return;
        }
        sweepSandboxes({
          stateDir: config.stateDir,
          sandboxDir: config.sandboxDir,
          retentionHours: sweepCfg.retentionHours,
          maxDirs: sweepCfg.maxDirs,
        });
      },
    });
  }

  // GitHub feedback signals (issue #255) — OFF by default (`feedback.github`).
  // GitHub sends no webhook for reactions, so this is the only half of the
  // feature that has a recurring cost, and it should be switched on knowingly.
  // Two pieces: anchor discovery on each terminal run (one listing, attributed
  // while we still hold the run), and a batched GraphQL refresh on a cron
  // (100 anchors per request, one rate-limit point each).
  if (config.feedback.enabled && config.feedback.github && github) {
    const feedbackDeps = {
      db,
      github,
      botLogin: config.botLogin,
      otel: config.feedback.otel,
      windowDays: config.feedback.windowDays,
      maxAnchorsPerTick: config.feedback.maxAnchorsPerTick,
      retentionDays: config.feedback.retentionDays,
    };
    db.runs.addTerminalObserver(feedbackAnchorObserver(feedbackDeps));
    cron.registerDirect({
      name: "feedback-poll",
      schedule: config.feedback.pollSchedule,
      handler: () => pollFeedbackReactions(feedbackDeps).then(() => {}),
    });
    logger("feedback").info("GitHub reaction polling enabled", {
      schedule: config.feedback.pollSchedule,
      windowDays: config.feedback.windowDays,
      maxAnchorsPerTick: config.feedback.maxAnchorsPerTick,
    });
  }

  // Start everything
  const mainLog = logger("main");
  await registry.startAll();
  mainLog.info("All connectors started");
  mainLog.info("Cron jobs registered");

  // Open the shared HTTP listener. All routes (admin, /api/*, /health,
  // /webhooks/github, /webhooks/slack) are registered synchronously above, so
  // the port is ready the moment it opens. Always boots — chat-only, PAT, and
  // full GitHub App modes alike.
  const server = serve({ fetch: app.fetch, port: config.port, hostname: "0.0.0.0" });
  logger("http").info("Listening", { port: config.port });

  // Chat runs in-process via pi-ai — no long-lived server to boot.

  // Boot-time recovery: any workflow_runs left in 'running' state from a
  // previous harness lifetime have already had their sandbox containers
  // killed by cleanupOrphanedSandboxes(). Mark their stale execution rows as
  // failed and re-dispatch each run so the runner can pick up after the last
  // completed phase. Skips 'paused' runs — those intentionally wait for a
  // human approval and are resumed via the dashboard / GitHub comment flow.
  resumeOrphanedWorkflows(resumeOpts).catch((err) => mainLog.error("Resume sweep failed", { err }));

  // Start the periodic admission sweeper. Also admits any queued runs that
  // were persisted before the harness restarted (e.g. a queued run survived
  // a crash; the sweeper picks it up on the first tick).
  admissionController.start();

  mainLog.info("Ready to receive events");

  // Graceful shutdown
  const shutdown = async () => {
    mainLog.info("Shutting down");
    cron.stopAll();
    admissionController.stop();
    await registry.stopAll();
    // The shared HTTP server is owned here now (no longer by the webhook
    // connector's stop()), so close it explicitly.
    server.close();
    if (!telemetryShutdownStarted) {
      telemetryShutdownStarted = true;
      await shutdownTelemetry();
    }
    await db.close();
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  logger("main").fatal("Fatal error", { err });
  // Exit 78 (EX_CONFIG) to signal Docker restart policy that looping won't help.
  // Common causes: bad PEM, wrong App ID, missing env vars.
  const msg = err?.message || "";
  const isConfig = msg.includes("could not be decoded") ||
    msg.includes("not found") ||
    msg.includes("ENOENT") ||
    msg.includes("required");
  process.exit(isConfig ? 78 : 1);
});
