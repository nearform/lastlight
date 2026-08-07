import { randomUUID } from "crypto";
import type { EventEnvelope } from "../connectors/types.js";
import type { SessionManager } from "../connectors/index.js";
// Imported from the module, not the `connectors/` barrel — the barrel is a
// value import that would drag every connector (Slack, the GitHub webhook)
// into the dispatcher's module graph.
import { withThreadTranscript } from "../connectors/messaging/thread-transcript.js";
import type { StateDb } from "../state/db.js";
import { qualifyRepo } from "../state/repo-ref.js";
import type { GitHubClient } from "./github/github.js";
import type { ChatResult } from "./chat/chat.js";
import { routeEvent, type Route, type RouterDeps } from "./router.js";
import { runDashboardUrl } from "../notify/model.js";
import {
  getRuntimeConfig,
  getBotName,
  getHoldLabel,
  defaultFixConfig,
  defaultDependenciesConfig,
  defaultReviewConfig,
} from "../config/config.js";
import { PR_FIX_SHAPED_WORKFLOWS } from "../workflows/target-policy.js";
import {
  resolvePrState,
  prScopedWorkflows,
  type InterventionRequest,
  type PrState,
} from "./pr-state.js";
import {
  holdReply,
  resolveDispatchDisposition,
  reviewCheckPlacement,
  type Decision,
  type FixDisposition,
  type PrPolicyConfig,
  type ReviewTriggerOptions,
} from "./pr-decisions.js";
import { postReviewCheckForSkip } from "./review-check.js";
import {
  escalatePr,
  noticeForkPr,
  recordIntervention,
  type EscalationDeps,
} from "./pr-escalation.js";
import { logger } from "../logging/logger.js";

const eventLog = logger("event");
const dispatchLog = logger("dispatch");
const approvalLog = logger("approval");

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
  publicUrl?: string;
  /**
   * Resolve the target repo's `.lastlight/` POLICY layer for this dispatch.
   *
   * INJECTED rather than imported so the dispatcher keeps no edge to the runner
   * (`resolveRepoRunConfig` lives in `workflows/simple.ts`, which drags the
   * loader, the sandbox and the artifact store in with it). `main()` wires the
   * very same call `dispatchWorkflow` makes one level down, so both gates read
   * ONE config.
   *
   * Without it the dispatcher read the OPERATOR's values while `dispatchWorkflow`
   * read the repo-clamped ones, and the webhook route always hands `_prState`
   * down — so on EVERY webhook-originated PR dispatch a managed repo's clamped
   * `fix.maxAttempts` / `fix.maxCostUsd` / `fix.retryableClasses` /
   * `dependencies.requireSettledChecks` / `review.trigger` / `skipDraft` /
   * `postsCheck` were silently not applied, while `renderContext` rendered them
   * to the prompt and `lastlight repo config show` reported them. Only the cron
   * sweep and `/api/run` honoured them.
   *
   * Cheap: `fetchRepoLayer` memoises per repo for 60 s, so this call and
   * `dispatchWorkflow`'s are one conditional request per repo per minute
   * between them, and this one usually warms the cache for that one.
   *
   * Omitted (chat-only wiring, tests) means "no repo layer" — the operator's
   * config, which is what the layer clamps toward anyway.
   */
  resolveRepoPolicy?: ResolveRepoPolicyFn;
}

/**
 * The three policy blocks a repo's `.lastlight/` layer may clamp, or undefined
 * when no layer applies. Structurally the `RunRepoConfig` `resolveRepoRunConfig`
 * returns, narrowed to what the gate reads.
 */
export type ResolveRepoPolicyFn = (
  workflowName: string,
  context: Record<string, unknown>,
) => Promise<Partial<PrPolicyConfig> | undefined>;

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
  inbound: EventEnvelope,
  deps: DispatchDeps,
): Promise<DispatchOutcome> {
  const route = await (deps.route ?? routeEvent)(inbound, {
    db: deps.db,
    github: deps.github,
    // Threaded one level up so the `pr.labeled` branch can see a repo's own
    // `review.requestLabel`. Same resolver, same 60 s cache, so the resolution
    // this triggers usually warms the one the dispatch gate makes below.
    resolveRepoPolicy: deps.resolveRepoPolicy,
  });

  if (route.action === "ignore") {
    return { kind: "ignored", reason: route.reason };
  }

  // ── The thread transcript ──────────────────────────────────────────────────
  //
  // A Slack thread is ONE conversation whichever way each message was handled,
  // but only `ChatRunner` ever wrote to `messaging_messages` — so a message the
  // classifier sent to a workflow (`answer`, `build`, `explore`, a repo-less
  // "reply" refusal, …) left the thread's history untouched, and the next chat
  // turn in that same thread rehydrated nothing and answered as if it had just
  // been introduced to the user. Wrap every path `ChatRunner` does NOT own, so
  // the inbound message and each reply are recorded on the thread's session.
  //
  // Skipping the chat handlers is what keeps the two writers from double-
  // writing a turn (the bug that moved persistence into `ChatRunner` in the
  // first place); `chat-reset` is skipped because it deactivates the session it
  // would be writing to.
  const chatOwnsTranscript =
    route.action === "handler" && (route.handler === "chat" || route.handler === "chat-reset");
  const envelope = chatOwnsTranscript
    ? inbound
    : withThreadTranscript(inbound, deps.sessionManager);

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

  // ── The PR state machine (09-state-machine.md) ────────────────────────────
  //
  // Everything past this point is a workflow dispatch, so this is where the
  // pull request's state is resolved — ONCE — for every PR-scoped workflow.
  // The snapshot then answers three questions that used to be asked by three
  // separate pieces of code, each fetching an overlapping subset and each free
  // to disagree: is a run already in flight, may this run at all, and what do
  // the prompts render. It rides down to `dispatchWorkflow` on `_prState`, so
  // the enrichment there costs no second round of API calls.
  //
  // An explicit `@bot` request is an intentional override of the label guard
  // and the per-SHA dedup — the same carve-out `target-policy.ts` already
  // documents for the dependency guard, and the same discriminator the old
  // `dependencyDedupSkip` used (it keyed off the webhook event type, not the
  // handler, precisely so a human asking directly was never gated).
  const explicitRequest =
    envelope.type === "message" ||
    envelope.type === "comment.created" ||
    // A review requested BY NAME — the reviewer picker, or the Re-run button on
    // our own `last-light/review` check. Both are a human pointing at us, so
    // both override mode, draft and dedup exactly as `@bot review` does. The
    // router has already dropped requests naming somebody else.
    envelope.type === "pr.review_requested";
  // Which route this dispatch arrived on, for `resolveReviewTrigger`. Only
  // `checks-settled` satisfies `after-checks`; `attention` is what defers.
  const reviewRoute: ReviewTriggerOptions["route"] =
    envelope.type === "pr.checks_settled" ? "checks-settled" : "attention";
  // `@<bot> retry [reason]`, if that is what this was. Handed to the RESOLVER
  // rather than applied afterwards: the whole point of the record is that
  // `sameProblem` reads it, so an intervention stamped onto a snapshot that was
  // already derived would re-arm nothing (03-retry-intervention.md).
  const prState = await resolvePrStateForDispatch(
    handler,
    context,
    deps,
    retryRequest(context),
  );
  if (prState) context._prState = prState;

  // Guard against double-dispatching the same work. Everything past this
  // point is a workflow dispatch (or a resume of one), so a run already in
  // flight for this trigger is a no-op.
  //
  // For a PR-scoped workflow the authority is the snapshot's `runInFlight`
  // (09 → S4), NOT `db.executions.isRunning`. **That guard has never worked at
  // all for them**: it is called with a bare workflow name and a bare issue
  // number, while every phase ledger row is written by `phase-executor.ts`
  // with `skill = "<workflow>:<phase>"` and `trigger_id = "owner/repo#N"`, so
  // no row can ever match on both and it has always returned false. The lock
  // now lives in the DECISION functions (`runLockDrop`), so the cron fan-out
  // and `/api/run` obey it too — it used to be read here and in
  // `resolveReviewTrigger` only, which left `fix-red-dependency-prs` free to
  // dispatch `dependabot-ci-fix` onto a PR with a live `pr-fix` run.
  const triggerId = String(envelope.issueNumber || envelope.id);
  if (!prState && deps.db.executions.isRunning(handler, triggerId)) {
    eventLog.info("Skipping — already running", { handler, triggerId });
    if (envelope.type === "message") {
      await envelope.reply(`That task is already running. Use /status to check progress.`);
    }
    return { kind: "skipped", reason: `${handler} already running for ${triggerId}` };
  }

  // Should we spend a run on this PR at all? One pure decision over the
  // snapshot, replacing `dependencyDedupSkip` (the `requires-human` +
  // already-assessed pair) and the fork/branch preflight `handlePrFix` used to
  // do with its own second PR read. `{decision, reason}` rather than a bare
  // enum so the log line, the escalation comment and the admin detail panel are
  // three renderings of ONE source instead of three prose variants that drift.
  if (prState) {
    // The repo's `.lastlight/` layer, folded in BEFORE the decision — the same
    // resolution `dispatchWorkflow` makes one level down, hitting the same 60 s
    // cache. Without it this gate read the operator's budgets while the prompt
    // rendered the repo's.
    const policy = prPolicyConfig(await deps.resolveRepoPolicy?.(handler, context));
    const disposition = await applyPrDispatchGate(
      { workflowName: handler, state: prState, policy, explicitRequest, route: reviewRoute, logPrefix: "[event]" },
      deps,
    );
    if (disposition.decision === "skip") {
      // The two responses that belong to THIS route rather than to the decision
      // — both keyed on a typed field, never on the reason prose.
      //
      // A maintainer whose explicit request lost the run lock is told so; one
      // who is silently dropped will just ask again. (The lock is not policy but
      // a physical constraint, so `@bot` does not override it — the cron
      // re-pickup is what makes dropping sound.)
      if (disposition.runInFlight && explicitRequest) {
        await envelope.reply(
          `I'm already working on this PR (\`${disposition.runInFlight.workflow}\`). I'll finish that run first — ask me again if it doesn't cover what you need.`,
        );
      }
      // A maintainer whose explicit request lost to the HOLD label is told
      // which label is holding me off and how to lift it (locked decision 4).
      // Same rule as the reply above: it belongs to the ROUTE that has a human
      // on the other end, never to the decision — a cron tick must say nothing,
      // and a hold that commented once per tick would be worse than the silence
      // it replaced. No dedup needed: this fires only on an explicit ask, so it
      // is one reply per ask, which is correct.
      //
      // In practice the router usually answers first (it sees the same label on
      // the envelope and short-circuits before any `resolvePrState`); this is
      // the branch for a PR whose event carried no labels — a `check_suite`
      // route, a `/api/run` with `_triggerType: api` — where the live read is
      // the first sight of the hold.
      if (disposition.onHold && explicitRequest) {
        await envelope.reply(holdReply(disposition.onHold.label));
      }
      // A fork PR is the one skip a human is owed an explanation for on the PR
      // itself: there is nothing wrong with their change, we simply have no
      // branch to push to.
      //
      // Keyed on the DECISION, not on `prState.isFork`. `isFork` is true on
      // every skip a fork PR takes, so it used to explain a decision that was
      // not taken — a run-lock drop, a deferred review or a head-SHA dedup on a
      // fork PR each earned "I can't apply fixes to this PR", once per skip.
      // `noticeForkPr` supplies the other half, the de-duplication (#256).
      if (disposition.forkPr) {
        await noticeForkPr(handler, prState, deps);
      }
      return { kind: "skipped", reason: `${handler}: ${disposition.reason}` };
    }
  }

  // PR fix: lightweight fix-and-push driven by CI failures / a comment. Also
  // covers pr-fix-shaped workflows (e.g. dependabot-ci-fix) reached via the
  // classifier — they all need the PR head branch the snapshot resolved, and
  // it dispatches the passed `handler` unchanged.
  if (
    (routeKey === "github.pr_fix" || PR_FIX_SHAPED_WORKFLOWS.has(handler)) &&
    context.prNumber &&
    context.repo
  ) {
    return handlePrFix(context, handler, deps, prState);
  }

  if (handler === "explore-reply") {
    return handleExploreReply(envelope, context, deps);
  }

  if (handler === "approval-response") {
    return handleApprovalResponse(envelope, context, deps);
  }

  // Build requests → the programmatic build orchestrator (the `build` workflow).
  if (
    (routeKey === "github.issue_build" || routeKey === "slack.build") &&
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
  return handleWebhookDispatch(handler, workflowContext, deps);
}

/**
 * Resolve the PR snapshot for this dispatch, or null when the event is not a
 * PR-scoped one.
 *
 * Null is a real answer, not a failure: it means "no PR policy governs this
 * handler", and the caller falls back to the generic already-running guard.
 * `resolvePrState` itself never throws — every live read is best-effort and
 * degrades to a value that cannot cause a skip (see `PrState.readErrors`), so
 * a GitHub outage can slow us down but can never drop a genuine event.
 */
async function resolvePrStateForDispatch(
  handler: string,
  context: Record<string, unknown>,
  deps: DispatchDeps,
  intervention?: InterventionRequest,
): Promise<PrState | null> {
  if (!prScopedWorkflows().has(handler)) return null;
  const repoStr = typeof context.repo === "string" ? context.repo : "";
  const prNumber = typeof context.prNumber === "number" ? context.prNumber : undefined;
  const [owner, name] = repoStr.split("/");
  if (!owner || !name || !prNumber) return null;
  return resolvePrState(owner, name, prNumber, {
    github: deps.github,
    db: deps.db,
    botLogin: getRuntimeConfig()?.botLogin ?? "",
    ...(intervention ? { intervention } : {}),
  });
}

/**
 * Read the router's `_retry` marker off the route context.
 *
 * Defensive rather than a cast: `context` is untyped by construction (every
 * route builds its own), so an unrecognised shape reads as "no retry" — which
 * is the inert case — rather than being stamped onto the snapshot verbatim. The
 * `note` is NOT sanitized here; `resolvePrState` does that once, where the
 * record is built, so no surface can skip it.
 */
function retryRequest(context: Record<string, unknown>): InterventionRequest | undefined {
  const raw = context._retry;
  if (!raw || typeof raw !== "object") return undefined;
  const r = raw as Record<string, unknown>;
  if (r.via !== "comment" && r.via !== "label" && r.via !== "api") return undefined;
  return {
    via: r.via,
    ...(typeof r.by === "string" && r.by ? { by: r.by } : {}),
    ...(typeof r.note === "string" && r.note ? { note: r.note } : {}),
  };
}

/**
 * The three policy blocks the dispatch gate reads — the operator's config with
 * the target repo's `.lastlight/` layer folded in.
 *
 * ONE config, one decision, every route. This used to be operator-only in the
 * dispatcher and repo-clamped in `dispatchWorkflow`, which failed silently and
 * asymmetrically: the gate used one number while `renderContext` rendered
 * another to the prompt and `lastlight repo config show` reported the same one
 * the prompt got. The repo layer may only ever clamp TIGHTER (add-only, see
 * `packages/shared/src/repo-config-schema.ts`), so the old seam always erred by
 * letting a run through the repo would have refused — which is exactly the
 * direction a budget cap must not err in.
 *
 * `layer` comes from {@link DispatchDeps.resolveRepoPolicy}, which is the same
 * `resolveRepoRunConfig` call `dispatchWorkflow` makes; the `?? operator`
 * fallbacks mirror its `repoConfig?.fix ?? config.fix` exactly.
 */
export function prPolicyConfig(layer?: Partial<PrPolicyConfig>): PrPolicyConfig {
  const rt = getRuntimeConfig();
  return {
    fix: layer?.fix ?? rt?.fix ?? defaultFixConfig(),
    dependencies: layer?.dependencies ?? rt?.dependencies ?? defaultDependenciesConfig(),
    review: layer?.review ?? rt?.review ?? defaultReviewConfig(),
    // The HOLD label. Read off the OPERATOR's config only — never the `layer` —
    // because it is not in `repoConfig.allowKeys` and there is no direction to
    // clamp a label name in. A repo that could rename it could rename it to
    // something nobody applies.
    holdLabel: getHoldLabel(),
  };
}

/** Everything {@link applyPrDispatchGate} needs to act on its own verdict. */
export interface PrGateDeps extends EscalationDeps {
  /** `<botName>[bot]`. Defaults to the boot config's. */
  botLogin?: string;
  /**
   * `@<botName>` — the `on-request` placeholder's instructions, and the handle
   * the escalation comment tells a maintainer to address `retry` to. Defaults
   * to the boot config's.
   */
  botMention?: string;
}

/** What {@link applyPrDispatchGate} was asked to decide. */
export interface PrGateArgs {
  workflowName: string;
  state: PrState;
  /** Already repo-clamped — see {@link prPolicyConfig}. */
  policy: PrPolicyConfig;
  explicitRequest?: boolean;
  route: NonNullable<ReviewTriggerOptions["route"]>;
  /** `[event]` (webhook/comment) or `[dispatch]` (cron, `/api/run`). */
  logPrefix: string;
}

/**
 * THE dispatch gate — decide, log, and apply the decision's own consequences.
 *
 * Both routes call this one function: the dispatcher for webhook/comment
 * events, and `dispatchWorkflow` for the cron fan-out, `/api/run` and resume.
 * They used to carry two hand-kept-in-step copies of it, reading two different
 * configs (see {@link prPolicyConfig}) and diverging on which side effects a
 * skip earns.
 *
 * The two consequences that belong to the DECISION rather than to the route are
 * applied here, so neither can be forgotten by one caller:
 *
 * - a **deferred review** leaves the placeholder check that says "not yet"
 *   (itself route-limited inside `postReviewCheckForSkip` — a statement about a
 *   head SHA belongs on PR attention, not on every sweep tick);
 * - a skip that is **terminal for this problem** is labelled and explained, and
 *   RECORDS A RUN ROW without which `escalatedAtSha` never persists and the next
 *   dispatch reads our own label as a human's permanent hold (09 → D1).
 *
 * What is NOT applied here is the route's own courtesy: replying to the human
 * whose request was dropped, and the fork-PR notice. Both are answers to a
 * person who is watching, so they belong to the route that has one — a daily
 * cron re-posting a fork notice for the life of the PR is spam, not
 * transparency. The caller keys them on the TYPED fields the deciding branch
 * set (`decision.runInFlight`, `state.isFork`), never on the reason prose.
 */
export async function applyPrDispatchGate(
  args: PrGateArgs,
  deps: PrGateDeps,
): Promise<Decision<FixDisposition>> {
  const { workflowName, state, policy, route } = args;
  const disposition = resolveDispatchDisposition(workflowName, state, policy, {
    explicitRequest: args.explicitRequest,
    dedupOnHeadSha: true,
    route,
  });
  const gateLog = args.logPrefix === "[dispatch]" ? dispatchLog : eventLog;
  gateLog.info("Dispatch gate decision", {
    workflow: workflowName,
    repo: state.repo,
    prNumber: state.prNumber,
    decision: disposition.decision,
    reason: disposition.reason,
  });
  if (disposition.decision !== "skip") return disposition;

  // The HOLD is an instruction, not a verdict: no placeholder, no label, no
  // comment, no run row — silent, exactly like `upstream-broken`. Stated here as
  // its own early return rather than relied on falling through: `escalatePr`
  // would no-op anyway (no `EscalationCase`), but a future skip consequence
  // added below must not quietly start firing on a PR a maintainer told us to
  // leave alone. Returned to the caller so the route with a human on the other
  // end can reply.
  if (disposition.onHold) return disposition;

  // A run-lock drop is a "come back later", not a verdict: no placeholder, no
  // label, no comment, no run row. Returned to the caller so the route that has
  // a human on the other end can reply.
  //
  // ALSO no intervention row, and that is a decision rather than an omission. A
  // row written while another run owns the PR would become the `latestForTrigger`
  // the next dispatch reads its history off, displacing the live run's own
  // snapshot and losing its harvested attempt line. The route's reply already
  // says "ask me again if it doesn't cover what you need", which is the right
  // answer to a retry aimed at work that is currently happening.
  if (disposition.runInFlight) return disposition;

  // Neither is a failed PR read (`readDegradedDrop`), and here the reason is
  // sharper: every side effect below writes to a pull request we could not
  // read. Labelling `requires-human` off a `labels: []` default, or posting a
  // review placeholder against a head SHA we do not have, would each be a
  // durable statement made on no information.
  if (disposition.readDegraded) return disposition;

  // A retry that produced no run. The snapshot re-armed the budgets, but a skip
  // writes no row — so without this the ask evaporates and the PR escalates
  // again the moment whatever blocked it clears (`upstream-broken` is the case
  // that matters: the base is red at the exact moment the maintainer asks).
  // Idempotent: `recordIntervention` refuses when the record is already on a
  // row, which is why it is safe on a route that fires per cron tick.
  //
  // Below the three guards above on purpose. The HOLD beats a retry outright
  // (locked decision 4), a degraded read knows nothing, and a lock drop is
  // covered by the note above.
  await recordIntervention(workflowName, state, deps);

  if (disposition.review) {
    await postReviewCheckForSkip(
      {
        workflowName,
        placement: reviewCheckPlacement(disposition.review, policy.review, {
          unchanged: !!disposition.reviewUnchanged,
        }),
        postsCheck: policy.review.postsCheck,
        route,
        owner: state.repo.split("/")[0] ?? "",
        repo: state.repo.split("/")[1] ?? "",
        headSha: state.headSha,
        carriedOver: disposition.reviewUnchanged,
      },
      {
        github: deps.github,
        botLogin: deps.botLogin ?? getRuntimeConfig()?.botLogin,
        botMention: deps.botMention ?? `@${getBotName()}`,
      },
    );
    return disposition;
  }

  await escalatePr(workflowName, state, disposition, policy.fix, {
    ...deps,
    // The two operator-configurable names the escalation comment has to speak,
    // so the exits it lists are the ones this deployment actually has.
    holdLabel: deps.holdLabel ?? policy.holdLabel ?? getHoldLabel(),
    botMention: deps.botMention ?? `@${getBotName()}`,
  });
  return disposition;
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
    eventLog.warn("Could not react to event", { type: envelope.type, err });
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
      eventLog.warn("Failed to post run-start ack", { err });
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
      eventLog.error("Workflow threw", { handler, err });
      await envelope.reply(`*${handler}* failed: ${msg}`);
    });

  return { kind: "dispatched", workflow: handler };
}

/**
 * Webhook-triggered workflow dispatch.
 *
 * It used to own the `last-light/review` Check Run too — created here for the
 * three PR-attention routes only, and completed inside a `.then()` chained onto
 * the in-memory workflow promise. Both halves were wrong (09 → S2): a
 * cron-, comment-, Slack- or CLI-triggered review never got a check at all, and
 * the one that did got stranded `in_progress` on every deploy, every
 * queued-then-resumed run, every cancellation and every crash. The lifecycle now
 * lives in `./review-check.ts` — created once at the `dispatchWorkflow` choke
 * point every route crosses, completed from the run's terminal transition — so
 * this function is back to doing one thing.
 */
async function handleWebhookDispatch(
  handler: string,
  workflowContext: Record<string, unknown>,
  deps: DispatchDeps,
): Promise<DispatchOutcome> {
  deps
    .dispatchWorkflow(handler, { ...workflowContext, _triggerType: "webhook" })
    .catch((err: unknown) => {
      eventLog.error("Unhandled error in workflow", { handler, err });
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
    eventLog.error("Invalid repo format", { repoStr });
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
      eventLog.warn("Could not fetch issue", { err });
    }
  }

  const executionId = randomUUID();
  deps.db.executions.recordStart({
    id: executionId,
    triggerType: envelope.type === "message" ? "chat" : "webhook",
    triggerId: String(issueNumber),
    skill: "build-cycle",
    // The pair, not the qualified string this used to write (issue #279) — a
    // `build-cycle` row has no `workflow_run_id`, so its own columns are the
    // only place the account can be recovered from.
    owner,
    repo,
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
        eventLog.warn("Could not react to trigger comment", { err });
      });
    }
  }

  deps.dispatchWorkflow(handler, {
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
    eventLog.error("Build cycle failed", { err });
    deps.db.executions.recordFinish(executionId, { success: false, error: err.message, durationMs: 0 });
  });

  return { kind: "dispatched", workflow: handler };
}

/**
 * Lightweight PR fix — fix-and-push, no full build cycle.
 *
 * This used to be the second of six places that read a PR's state: it fetched
 * the PR again for the head branch, ran its own fork guard, and downloaded the
 * failed-check text — none of which the cron fan-out got, because that calls
 * `dispatchWorkflow` DIRECTLY and never crosses this function. All of it is now
 * one field lookup on the snapshot, and the enrichment the prompts render
 * (`ciSection`, `baseBranch`, `attempt`, `priorAttempts`, …) is projected once
 * at `dispatchWorkflow` by `renderContext`, so both routes carry identical
 * context by construction.
 *
 * The fork guard and every other skip already ran in `dispatch` via
 * `resolveDispatchDisposition`; what is left here is the one degenerate case
 * that is not a policy decision — we could not read the PR at all, so there is
 * no branch to fix.
 */
async function handlePrFix(
  context: Record<string, unknown>,
  handler: string,
  deps: DispatchDeps,
  state: PrState | null,
): Promise<DispatchOutcome> {
  const repoStr = context.repo as string;
  const [owner, repo] = repoStr.includes("/") ? repoStr.split("/") : ["", repoStr];
  const prNumber = context.prNumber as number;

  if (!owner || !repo) {
    eventLog.error("Invalid repo format", { repoStr });
    return { kind: "ignored", reason: `invalid repo format: ${repoStr}` };
  }

  if (!state?.headRef) {
    eventLog.error("Could not determine branch for PR", { prNumber });
    return { kind: "ignored", reason: `could not determine branch for PR #${prNumber}` };
  }

  eventLog.info("PR fix dispatch", { repo: repoStr, prNumber, headRef: state.headRef });

  deps.dispatchWorkflow(handler, {
    repo: repoStr,
    prNumber,
    // The event's own title/body win when it carried them (a comment trigger
    // quotes the PR it was posted on); the snapshot is the fallback and the
    // only source on the check_suite + cron routes.
    title: (context.title as string) || state.title,
    body: (context.body as string) || state.body,
    commentBody: (context.commentBody as string) || "",
    sender: (context.sender as string) || "unknown",
    // Cron-only: WHY the red sweep summoned this PR (checks-failing | behind |
    // dirty | blocked). Nothing in the snapshot can reconstruct it.
    ...(typeof context.reason === "string" ? { reason: context.reason } : {}),
    _prState: state,
    _triggerType: "webhook",
  }).catch((err) => {
    eventLog.error("PR fix failed", { err });
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
    eventLog.warn("explore-reply: run not found", { workflowRunId });
    return handled;
  }
  const pending = deps.db.approvals.getPendingForWorkflow(workflowRunId);
  if (!pending || pending.kind !== "reply") {
    eventLog.warn("explore-reply: no pending reply gate", { workflowRunId });
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
    eventLog.warn("explore-reply: reply gate already resolved — skipping duplicate resume", {
      pendingId: pending.id,
      err,
    });
    return handled;
  }

  // Re-dispatch. Use channelId/threadId from the current event context (the
  // router captured them from the reply envelope), not stored workflow
  // context — they were never persisted there.
  const isSlack = run.triggerId.startsWith("slack:");
  const replyChannelId = context.channelId as string | undefined;
  const replyThreadId = context.threadId as string | undefined;
  // `dispatchWorkflow` speaks the qualified `owner/repo`, so compose it from
  // the row's pair — through `qualifyRepo`, which is a no-op on a value that
  // already carries a slash. This used to join unconditionally, so a legacy
  // qualified `run.repo` produced `acme/acme/widgets`, which the dispatch split
  // then read as the repo `acme` — a different real repository (issue #279).
  const storedCtx = (run.context || {}) as Record<string, unknown>;
  const storedOwner = storedCtx.owner as string | undefined;
  const resumeRepo = qualifyRepo(run.owner ?? storedOwner, run.repo);
  eventLog.info("explore-reply: resuming after reply", { workflowRunId, sender });
  deps.dispatchWorkflow("explore", {
    repo: resumeRepo || (isSlack ? undefined : run.triggerId.split("#")[0]),
    issueNumber: run.issueNumber,
    sender,
    _triggerType: envelope.type === "message" ? "chat" : "webhook",
    triggerId: isSlack ? run.triggerId : undefined,
    channelId: replyChannelId,
    threadId: replyThreadId,
  }).catch((err) => eventLog.error("explore-reply resume failed", { err }));
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
        }).catch((err) => approvalLog.error("Resume failed", { err }));
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
    dispatchLog.error("Chat error", { err });
    deps.db.executions.recordFinish(executionId, { success: false, error: msg, durationMs: 0 });
    await reply("Sorry, I encountered an error. Please try again.");
  }
}
