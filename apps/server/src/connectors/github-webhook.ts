import { EventEmitter } from "events";
import { Hono } from "hono";
import { createHmac, timingSafeEqual } from "crypto";
import type { Connector, EventEnvelope, EventType } from "./types.js";
import {
  isManagedRepo,
  setInstallationRepos,
  addInstallationRepos,
  removeInstallationRepos,
} from "../managed-repos.js";
import { logger } from "../logging/logger.js";

const log = logger("github");

export interface GitHubWebhookConfig {
  /**
   * Port the harness HTTP server listens on. Retained for compatibility with
   * existing callers/tests; the connector no longer opens the listener itself
   * — `main()` owns the shared Hono app + `serve()` lifecycle now.
   */
  port: number;
  webhookSecret: string;
  /** Bot login name to ignore self-events */
  botLogin: string;
  /**
   * Shared Hono app to register `/webhooks/github` onto. When omitted, the
   * connector creates its own app (used by unit tests that drive it via
   * `honoApp.request(...)` standalone).
   */
  app?: Hono;
  /** GitHub App MCP client for posting replies */
  replyFn?: (owner: string, repo: string, issueNumber: number, body: string) => Promise<void>;
  /**
   * Settle-aware aggregate check conclusion for a ref (delegates to
   * `GitHubClient.getChecksConclusion`). Lets the connector emit a
   * dependency-PR `pr.checks_passed` / `pr.checks_failed` event only when the
   * head SHA's checks have FULLY settled — so a repo with several
   * check-reporting apps fires ONE event per SHA (the last suite to settle),
   * not one per suite. When unset (standalone unit tests), the connector keeps
   * its legacy per-suite behaviour.
   */
  getChecksConclusion?: (
    owner: string,
    repo: string,
    ref: string,
  ) => Promise<"passing" | "failing" | "pending" | "none">;
  /**
   * The OPERATOR's `review.trigger`, read live.
   *
   * `check_suite.completed` is broadened past dependency PRs — to
   * `pr.checks_settled` — only under `after-checks`, because that is the only
   * mode with a consumer. Emitting is what costs event volume, and a repo that
   * opts itself into `after-checks` under an `eager` operator is covered by the
   * 30-minute `check-prs-awaiting-review` sweep. Unset (standalone unit tests)
   * reads as "not after-checks".
   */
  reviewTrigger?: () => "eager" | "after-checks" | "on-request";
}

/** The check-run name whose "Re-run" button is a review request. */
const REVIEW_CHECK_NAME = "last-light/review";

/**
 * GitHub webhook actions we skip — these are noisy and never need agent work.
 *
 * NOTE: `synchronize` is intentionally NOT in this set. It fires on every new
 * commit pushed to a PR's branch and is the canonical "needs a fresh review"
 * trigger — without it, branch protection requiring `last-light/review`
 * would block merges after a REQUEST_CHANGES + fix-commit cycle (the new
 * SHA would never get a check posted against it). The handler maps it to
 * `pr.synchronize` and routes to pr-review.
 *
 * `labeled` left this set in Phase 7: `review.requestLabel` is the real
 * `on-request` mechanism (GitHub App bot users are not selectable in the
 * reviewer picker, so `review_requested` cannot be). Everything that is not a
 * `pull_request` label still falls out of `normalize()` with a null type and is
 * answered `{ filtered: true, reason: "unmapped event" }`, and the router drops
 * every PR label that is not the configured one — so the widening costs a
 * normalize call, not a dispatch.
 */
const IGNORED_ACTIONS = new Set([
  "deleted",
  "edited",
  "unlabeled",
  "assigned",
  "unassigned",
  "closed",
  "milestoned",
  "demilestoned",
  "locked",
  "unlocked",
  "transferred",
  "pinned",
  "unpinned",
]);

export class GitHubWebhookConnector extends EventEmitter implements Connector {
  readonly name = "github";
  private app: Hono;
  private config: GitHubWebhookConfig;

  constructor(config: GitHubWebhookConfig) {
    super();
    this.config = config;
    // Register onto the shared app when given one; otherwise self-create (tests).
    this.app = config.app ?? new Hono();
    this.setupRoutes();
  }

  /**
   * Expose the Hono app so the main server can mount additional routes
   * (e.g., /api/run for the CLI trigger).
   */
  get honoApp() {
    return this.app;
  }

  private setupRoutes() {
    // GitHub webhook endpoint. (`/health` is owned by main()'s shared app so it
    // exists in chat-only mode too — see src/index.ts.)
    this.app.post("/webhooks/github", async (c) => {
      const body = await c.req.text();

      // Verify webhook signature
      const signature = c.req.header("x-hub-signature-256");
      if (!signature || !this.verifySignature(body, signature)) {
        return c.json({ error: "Invalid signature" }, 401);
      }

      const eventType = c.req.header("x-github-event");
      const deliveryId = c.req.header("x-github-delivery") || crypto.randomUUID();

      let payload: any;
      try {
        payload = JSON.parse(body);
      } catch {
        return c.json({ error: "Invalid JSON" }, 400);
      }

      const action = payload.action;

      // Keep the discovered installation-repo list live. These events carry no
      // `payload.repository` (they're app-wide) and `installation`/`deleted`
      // would otherwise be dropped by IGNORED_ACTIONS below — so handle them
      // first, before any action/repo filtering. Signature is already verified.
      if (eventType === "installation" || eventType === "installation_repositories") {
        this.handleInstallationEvent(eventType, action, payload);
        return c.json({ accepted: true, kind: "installation-sync" }, 200);
      }

      // Filter out ignored actions
      if (action && IGNORED_ACTIONS.has(action)) {
        return c.json({ filtered: true, reason: `action=${action}` }, 200);
      }

      // Filter out bot events (self-loop prevention).
      //
      // Exception: `pull_request` opened/synchronize/reopened from a bot
      // sender must still flow through. A bot opening its own PR or
      // pushing a fix commit is the canonical "needs a fresh review"
      // signal — without this exception, a REQUEST_CHANGES verdict on a
      // bot-authored PR followed by a fix commit would be invisible to
      // the harness, leaving branch protection (which requires a check
      // on the latest SHA) permanently blocked.
      //
      // Loop risk on this exception is low: pr-review posts a PR Review
      // (`pr_review.submitted`, currently unrouted) and a Check Run
      // (`check_run.completed`, no event type at all here) — nothing the
      // agent acts on. Comment/issue paths still keep the strict filter
      // to avoid the bot replying to its own comments.
      const senderLogin = payload.sender?.login || "";
      const senderType = payload.sender?.type || "";
      const isBotSender =
        senderType === "Bot" ||
        senderLogin === this.config.botLogin ||
        senderLogin.endsWith("[bot]");
      const isPrAttention =
        eventType === "pull_request" &&
        (action === "opened" ||
          action === "synchronize" ||
          action === "reopened" ||
          // A draft becoming ready is exactly when a deferred review should
          // fire, so it carries the same exemption as `opened` — which it maps
          // to (07 §7.3). Pairs with `review.skipDraft`.
          action === "ready_for_review");
      // The two new review-request signals. They do NOT get the bot-sender
      // exemption above (a human applies a label or asks for a review), but they
      // DO get the bot-authored-PR filter below — we can never review our own PR.
      const isPrReviewSignal =
        eventType === "pull_request" && (action === "labeled" || action === "review_requested");
      // A `check_suite.completed` (CI went red) is always sent by a bot — the
      // CI app / github-actions[bot] — so it would be dropped by the bot-sender
      // filter below without this exception. It carries nothing the agent
      // replies to (it drives the pr.checks_failed → fix path), so there's no
      // self-reply loop risk. See normalize()'s check_suite case.
      const isCheckAttention = eventType === "check_suite" && action === "completed";
      if (isBotSender && !isPrAttention && !isCheckAttention) {
        return c.json({ filtered: true, reason: "bot sender" }, 200);
      }

      // Never review a PR the bot itself authored. The pr-attention exception
      // above deliberately lets bot *senders* through (a bot fix-commit on a
      // human's PR is a legitimate re-review signal), but a PR whose **author**
      // is the bot is a different thing: the App can't submit a formal review
      // of its own PR (GitHub 422 "Can not approve your own pull request") and
      // a self-review has no gating value. Filter on the author, not the
      // sender, so a bot `synchronize` on a human-authored PR still flows
      // through while the bot's own PRs are dropped before any sandbox spawns.
      const prAuthor = payload.pull_request?.user?.login || "";
      const isBotAuthoredPr =
        (isPrAttention || isPrReviewSignal) &&
        (prAuthor === this.config.botLogin || prAuthor.endsWith("[bot]"));
      if (isBotAuthoredPr) {
        return c.json(
          { filtered: true, reason: "bot-authored PR (self-review)" },
          200,
        );
      }

      // Filter out repos not in the managed allowlist. The GitHub App may be
      // installed on additional repos but we only operate on those we explicitly
      // manage. See src/managed-repos.ts.
      const repoFullName = payload.repository?.full_name;
      if (!isManagedRepo(repoFullName)) {
        log.info("Filtered webhook for unmanaged repo", { repoFullName });
        return c.json({ filtered: true, reason: `repo not managed: ${repoFullName}` }, 200);
      }

      // Normalize to EventEnvelope
      const envelope = await this.normalize(eventType!, action, payload, deliveryId);
      if (!envelope) {
        return c.json({ filtered: true, reason: "unmapped event" }, 200);
      }

      // Emit asynchronously — don't block the webhook response
      setImmediate(() => this.emit("event", envelope));

      return c.json({ accepted: true, id: deliveryId }, 202);
    });
  }

  /**
   * Apply an `installation` / `installation_repositories` event to the in-memory
   * managed-repo list (src/managed-repos.ts). We apply the payload diff directly
   * — the events carry the affected repos' `full_name`, so no API round-trip is
   * needed. The list is seeded at boot; these keep it current between restarts.
   */
  private handleInstallationEvent(
    eventType: string,
    action: string | undefined,
    payload: any,
  ): void {
    const names = (repos: any): string[] =>
      Array.isArray(repos) ? repos.map((r: any) => r?.full_name).filter(Boolean) : [];

    if (eventType === "installation_repositories") {
      if (action === "added") {
        const added = names(payload.repositories_added);
        addInstallationRepos(added);
        log.info("Installation repos added", { repos: added });
      } else if (action === "removed") {
        const removed = names(payload.repositories_removed);
        removeInstallationRepos(removed);
        log.info("Installation repos removed", { repos: removed });
      }
      return;
    }

    // eventType === "installation"
    if (action === "created") {
      // The initial-install payload lists the granted repos; reset to exactly them.
      const repos = names(payload.repositories);
      setInstallationRepos(repos);
      log.info("App installed", { repoCount: repos.length });
    } else if (action === "deleted") {
      setInstallationRepos([]);
      log.info("App uninstalled — cleared installation repos");
    }
  }

  /**
   * Settle-aware aggregate check conclusion for a ref, via the injected
   * `getChecksConclusion` client. Returns `fallback` when no client is wired
   * (standalone unit tests) or the SHA is missing, preserving the legacy
   * per-suite emit so those paths behave as before. Never throws — a lookup
   * error resolves to the fallback so a transient GitHub hiccup doesn't drop a
   * genuine event.
   */
  private async settledConclusion(
    repoFullName: string | undefined,
    sha: string | undefined,
    fallback: "passing" | "failing",
  ): Promise<"passing" | "failing" | "pending" | "none"> {
    if (!this.config.getChecksConclusion || !repoFullName || !sha) return fallback;
    const [owner, repo] = repoFullName.split("/");
    try {
      return await this.config.getChecksConclusion(owner, repo, sha);
    } catch (err) {
      log.warn("getChecksConclusion failed", { repoFullName, sha: sha.slice(0, 7), err });
      return fallback;
    }
  }

  /**
   * Is the operator running `review.trigger: after-checks`? Only then does a
   * settled check suite on a PR neither check-outcome route claimed become a
   * `pr.checks_settled` event; every other mode has no consumer for it.
   */
  private afterChecks(): boolean {
    try {
      return this.config.reviewTrigger?.() === "after-checks";
    } catch {
      return false;
    }
  }

  private verifySignature(body: string, signature: string): boolean {
    const expected = "sha256=" + createHmac("sha256", this.config.webhookSecret)
      .update(body)
      .digest("hex");
    try {
      return timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
    } catch {
      return false;
    }
  }

  private async normalize(
    githubEvent: string,
    action: string | undefined,
    payload: any,
    deliveryId: string
  ): Promise<EventEnvelope | null> {
    const repoFullName = payload.repository?.full_name;
    const sender = payload.sender?.login || "unknown";

    // Map GitHub event + action → our EventType
    let type: EventType | null = null;
    let issueNumber: number | undefined;
    let prNumber: number | undefined;
    let body = "";
    let title = "";
    let labels: string[] = [];
    let issueAuthor: string | undefined;
    let headSha: string | undefined;
    // The dependency discriminator, CARRIED rather than discarded. The
    // connector has to compute it to decide whether to emit at all; the router
    // used to pay an LLM classifier call to re-guess it from a prose sentence,
    // and got it wrong — see the `pr.checks_failed` case in `engine/router.ts`
    // (09-state-machine.md → D5).
    let isDependencyPr: boolean | undefined;
    /** `pr.labeled` only — the label just added, for `review.requestLabel`. */
    let addedLabel: string | undefined;
    /** `pr.review_requested` only — who the review was asked of. */
    let requestedReviewer: string | undefined;

    switch (githubEvent) {
      case "issues":
        issueNumber = payload.issue?.number;
        body = payload.issue?.body || "";
        title = payload.issue?.title || "";
        labels = (payload.issue?.labels || []).map((l: any) => l.name);
        issueAuthor = payload.issue?.user?.login;
        if (action === "opened") type = "issue.opened";
        else if (action === "reopened") type = "issue.reopened";
        break;

      case "pull_request":
        prNumber = payload.pull_request?.number;
        issueNumber = prNumber; // PRs are issues too
        body = payload.pull_request?.body || "";
        title = payload.pull_request?.title || "";
        labels = (payload.pull_request?.labels || []).map((l: any) => l.name);
        issueAuthor = payload.pull_request?.user?.login;
        if (action === "opened") type = "pr.opened";
        // synchronize fires on every new commit pushed to the PR's branch.
        // We map it through so the pr-review workflow re-runs against the
        // new head SHA — without this, branch protection on the new SHA
        // sits with no `last-light/review` check after the first one.
        else if (action === "synchronize") type = "pr.synchronize";
        // reopened: closed-then-reopened PRs deserve a fresh look too.
        else if (action === "reopened") type = "pr.reopened";
        // A draft marked ready maps to `pr.opened` SEMANTICS — it is the moment
        // the PR first asks to be looked at. This is what un-defers a review
        // `review.skipDraft` held back; without it a PR opened as a draft and
        // later marked ready would get no webhook-driven review at all.
        else if (action === "ready_for_review") type = "pr.opened";
        // A label was added. The router drops every label that is not the
        // configured `review.requestLabel`, so this only ever reaches a
        // dispatch when somebody asked for a review by label.
        else if (action === "labeled") {
          const name = payload.label?.name;
          if (typeof name === "string" && name) {
            type = "pr.labeled";
            addedLabel = name;
          }
        }
        // Opportunistic (07 §7.1's caveat): GitHub App bot users are not
        // selectable in the reviewer picker, so `on-request` must NOT depend on
        // this — it costs almost nothing and future-proofs. The router discards
        // a request naming anybody else.
        else if (action === "review_requested") {
          const reviewer =
            payload.requested_reviewer?.login ??
            (payload.requested_team?.slug ? `team/${payload.requested_team.slug}` : undefined);
          if (reviewer) {
            type = "pr.review_requested";
            requestedReviewer = reviewer;
          }
        }
        break;

      case "issue_comment":
        issueNumber = payload.issue?.number;
        body = payload.comment?.body || "";
        title = payload.issue?.title || "";
        // Carry the parent issue's labels through — the router keys on
        // `security-scan` to divert comments on summary issues to the
        // security-feedback skill. Without this, every comment arrived
        // label-less and fell through to the build path.
        labels = (payload.issue?.labels || []).map((l: any) => l.name);
        issueAuthor = payload.issue?.user?.login;
        if (action === "created") type = "comment.created";
        // Detect if this is on a PR
        if (payload.issue?.pull_request) {
          prNumber = issueNumber;
        }
        break;

      case "pull_request_review":
        prNumber = payload.pull_request?.number;
        issueNumber = prNumber;
        body = payload.review?.body || "";
        title = payload.pull_request?.title || "";
        if (action === "submitted") type = "pr_review.submitted";
        break;

      case "pull_request_review_comment":
        prNumber = payload.pull_request?.number;
        issueNumber = prNumber;
        body = payload.comment?.body || "";
        title = payload.pull_request?.title || "";
        if (action === "created") type = "pr_review_comment.created";
        break;

      // "Re-run" / "Re-run all checks" on the PR's Checks tab. GitHub fires
      // check_run.rerequested (one check) or check_suite.rerequested (all) to
      // the App that owns the check. Map either to pr.synchronize so the runner
      // re-reviews the PR's current head — the same path a fresh push takes.
      // The associated PR comes from the event's `pull_requests[]` (populated
      // for same-repo PRs). Other check_run/check_suite actions (created /
      // completed / requested, fired on every check) leave `type` null and are
      // ignored. NOTE: requires the GitHub App to be subscribed to the "Check
      // run" / "Check suite" events — without that GitHub never delivers these.
      case "check_run":
        if (action === "rerequested" || action === "requested_action") {
          prNumber = payload.check_run?.pull_requests?.[0]?.number;
          issueNumber = prNumber;
          if (prNumber) {
            // Re-running OUR OWN review check is an explicit review request,
            // not "the code changed". That distinction is what makes the
            // `on-request` placeholder check work as advertised: `neutral`
            // never blocks a merge and its Re-run button IS the affordance —
            // but only if pressing it overrides the mode, which `pr.synchronize`
            // (an attention event) would not.
            if (payload.check_run?.name === REVIEW_CHECK_NAME) {
              type = "pr.review_requested";
              requestedReviewer = this.config.botLogin;
            } else {
              type = "pr.synchronize";
            }
          }
        }
        break;

      case "check_suite":
        if (action === "rerequested") {
          prNumber = payload.check_suite?.pull_requests?.[0]?.number;
          issueNumber = prNumber;
          if (prNumber) type = "pr.synchronize";
        } else if (
          action === "completed" &&
          (payload.check_suite?.conclusion === "failure" ||
            payload.check_suite?.conclusion === "timed_out")
        ) {
          // A PR's CI has gone red. Emit a dedicated event so a workflow can
          // react (e.g. fix a failing Dependabot PR). We use check_suite
          // (aggregate — ~one event per push) rather than per-check_run.completed
          // to avoid a burst of duplicates. `pull_requests[]` is populated for
          // same-repo PRs (fork PRs carry an empty array and are dropped below).
          const pr = payload.check_suite?.pull_requests?.[0];
          const sha: string | undefined = payload.check_suite?.head_sha;
          // The check_suite `pull_requests[]` entry is minimal (number/refs
          // only — no title or author). The head commit carries the useful
          // classifier signal instead: for a Dependabot PR the commit message
          // is the bump description ("Bump lodash from …") and the commit
          // author name is "dependabot[bot]". The router feeds these to the
          // classifier; the dispatcher later fetches the full PR for the fix.
          const headCommit = payload.check_suite?.head_commit;
          const commitAuthor: string = headCommit?.author?.name || "";
          const headBranch: string = payload.check_suite?.head_branch || "";
          // GATE: which red PRs may kick off the fix path at all. Commit author
          // OR branch prefix for the dependency case, so a squashed/proxied bot
          // commit still matches via its branch.
          const isDependency =
            /^(dependabot|renovate)\[bot\]$/.test(commitAuthor) ||
            /^(dependabot|renovate)\//.test(headBranch);
          // ...plus a head commit WE pushed. `git-auth.ts` stamps
          // `user.name = <botName>[bot]` on the agent's own commits and the
          // check_suite payload carries the same field, so this is precisely
          // "did my fix work?" — the CI feedback loop `pr-fix` has never had
          // (it could push a fix and never learn whether the build went green,
          // because this event only ever fired for dependency PRs). It stays
          // bounded: it cannot fire for an ordinary human PR the bot has not
          // touched. It is nonetheless the one change here that can increase
          // run volume on non-dependency PRs — watch it after rollout.
          const isOurOwnPush = !!this.config.botLogin && commitAuthor === this.config.botLogin;
          // Only fire once the PR's checks have FULLY SETTLED red — a repo with
          // several check-reporting apps completes one suite at a time, and a
          // failure in one while another is still running should not kick off a
          // fix mid-flight. `getChecksConclusion` returns "failing" only when
          // nothing is pending and ≥1 check concluded red, so exactly one event
          // fires per SHA (the last suite to settle). Absent a wired client
          // (standalone tests) we keep the legacy per-suite behaviour. Gated
          // behind the emit check so an untouched human PR never makes the call.
          if (pr?.number && (isDependency || isOurOwnPush)) {
            const settled = await this.settledConclusion(repoFullName, sha, "failing");
            if (settled === "failing") {
              prNumber = pr.number;
              issueNumber = prNumber;
              headSha = sha;
              type = "pr.checks_failed";
              title = (headCommit?.message || "").split("\n")[0] || title;
              issueAuthor = commitAuthor || issueAuthor;
              // The router routes on THIS, deterministically: dependency →
              // `dependabot-ci-fix`, everything else → `pr-fix`. Without it a
              // human's red PR would run a dependency-bump prompt, the
              // `dependency-*` label vocabulary and a `requires-human`
              // preflight it was never designed for.
              isDependencyPr = isDependency;
            }
          } else if (pr?.number && this.afterChecks()) {
            // FIX OUTRANKS REVIEW (09 → S2). A settled-red PR the fix family can
            // act on has already been claimed above; only what is LEFT becomes a
            // review settle. One envelope per delivery is all `normalize()` can
            // return, so this precedence is not a policy choice bolted on later
            // — it is the shape of the pipeline.
            const settled = await this.settledConclusion(repoFullName, sha, "failing");
            if (settled === "failing" || settled === "passing") {
              prNumber = pr.number;
              issueNumber = prNumber;
              headSha = sha;
              type = "pr.checks_settled";
              title = (headCommit?.message || "").split("\n")[0] || title;
              isDependencyPr = isDependency;
            }
          }
        } else if (
          action === "completed" &&
          payload.check_suite?.conclusion === "success"
        ) {
          // A PR's CI has gone fully green. Emit a dedicated event ONLY for
          // dependency-update PRs (Dependabot / Renovate) so a workflow can
          // enable auto-merge on the trivial ones — we deliberately do NOT fire
          // on every green PR (that would flood the router with events for
          // unrelated work). The dependency signal comes cheaply from the head
          // commit author + the suite's head branch, with no extra PR fetch.
          const pr = payload.check_suite?.pull_requests?.[0];
          const sha: string | undefined = payload.check_suite?.head_sha;
          const headCommit = payload.check_suite?.head_commit;
          const commitAuthor: string = headCommit?.author?.name || "";
          const headBranch: string = payload.check_suite?.head_branch || "";
          const isDependency =
            /^(dependabot|renovate)\[bot\]$/.test(commitAuthor) ||
            /^(dependabot|renovate)\//.test(headBranch);
          // Fire ONLY when the head SHA's checks have fully settled green. A
          // suite going green while sibling suites are still running reports
          // "pending" here and is dropped; the last suite to settle flips the
          // aggregate to "passing", so exactly one `pr.checks_passed` fires per
          // SHA instead of one per check-reporting app. (Legacy per-suite
          // behaviour is preserved when no client is wired — standalone tests.)
          if (pr?.number && isDependency) {
            const settled = await this.settledConclusion(repoFullName, sha, "passing");
            if (settled === "passing") {
              prNumber = pr.number;
              issueNumber = prNumber;
              headSha = sha;
              type = "pr.checks_passed";
              title = (headCommit?.message || "").split("\n")[0] || title;
              issueAuthor = commitAuthor || issueAuthor;
              // Always true on this branch (the green route is dependency-only),
              // set for symmetry so the envelope's discriminator is never
              // undefined on a check-outcome event.
              isDependencyPr = true;
            }
          } else if (pr?.number && this.afterChecks()) {
            // The green half of the same broadening. A non-dependency PR whose
            // CI has fully settled green is the canonical `after-checks` review:
            // nothing is going to change about this head, and the review can now
            // say so.
            const settled = await this.settledConclusion(repoFullName, sha, "passing");
            if (settled === "passing") {
              prNumber = pr.number;
              issueNumber = prNumber;
              headSha = sha;
              type = "pr.checks_settled";
              title = (headCommit?.message || "").split("\n")[0] || title;
              isDependencyPr = isDependency;
            }
          }
        }
        break;
    }

    if (!type) return null;

    const [owner, repo] = (repoFullName || "/").split("/");

    const reply = async (msg: string) => {
      if (this.config.replyFn && repoFullName && issueNumber) {
        await this.config.replyFn(owner, repo, issueNumber, msg);
      }
    };

    return {
      id: deliveryId,
      source: "github",
      type,
      repo: repoFullName,
      issueNumber,
      prNumber,
      headSha,
      isDependencyPr,
      addedLabel,
      requestedReviewer,
      sender,
      issueAuthor,
      senderIsBot: false, // already filtered bots above
      body,
      title,
      labels,
      authorAssociation: payload.comment?.author_association || payload.issue?.author_association || payload.pull_request?.author_association,
      raw: payload,
      reply,
      timestamp: new Date(),
    };
  }

  async start(): Promise<void> {
    // No-op: the HTTP listener is owned by main()'s shared server. Routes are
    // already registered on the shared app at construction time. This connector
    // stays registered purely so its `emit("event", …)` flows through the
    // ConnectorRegistry.
    log.info("Webhook routes registered on shared HTTP server");
  }

  async stop(): Promise<void> {
    // No-op: no server owned here to close.
  }
}
