import { EventEmitter } from "events";
import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { createHmac, timingSafeEqual } from "crypto";
import type { Connector, EventEnvelope, EventType } from "./types.js";
import { isManagedRepo } from "../managed-repos.js";

export interface GitHubWebhookConfig {
  port: number;
  webhookSecret: string;
  /** Bot login name to ignore self-events */
  botLogin: string;
  /** GitHub App MCP client for posting replies */
  replyFn?: (owner: string, repo: string, issueNumber: number, body: string) => Promise<void>;
}

/**
 * GitHub webhook actions we skip — these are noisy and never need agent work.
 *
 * NOTE: `synchronize` is intentionally NOT in this set. It fires on every new
 * commit pushed to a PR's branch and is the canonical "needs a fresh review"
 * trigger — without it, branch protection requiring `last-light/review`
 * would block merges after a REQUEST_CHANGES + fix-commit cycle (the new
 * SHA would never get a check posted against it). The handler maps it to
 * `pr.synchronize` and routes to pr-review.
 */
const IGNORED_ACTIONS = new Set([
  "deleted",
  "edited",
  "labeled",
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
  private server: ReturnType<typeof serve> | null = null;
  private config: GitHubWebhookConfig;

  constructor(config: GitHubWebhookConfig) {
    super();
    this.config = config;
    this.app = new Hono();
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
    // Health check
    this.app.get("/health", (c) => c.json({ status: "ok", connector: "github" }));

    // GitHub webhook endpoint
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
        (action === "opened" || action === "synchronize" || action === "reopened");
      if (isBotSender && !isPrAttention) {
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
        isPrAttention &&
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
        console.log(`[github] Filtered webhook for unmanaged repo: ${repoFullName}`);
        return c.json({ filtered: true, reason: `repo not managed: ${repoFullName}` }, 200);
      }

      // Normalize to EventEnvelope
      const envelope = this.normalize(eventType!, action, payload, deliveryId);
      if (!envelope) {
        return c.json({ filtered: true, reason: "unmapped event" }, 200);
      }

      // Emit asynchronously — don't block the webhook response
      setImmediate(() => this.emit("event", envelope));

      return c.json({ accepted: true, id: deliveryId }, 202);
    });
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

  private normalize(
    githubEvent: string,
    action: string | undefined,
    payload: any,
    deliveryId: string
  ): EventEnvelope | null {
    const repoFullName = payload.repository?.full_name;
    const sender = payload.sender?.login || "unknown";

    // Map GitHub event + action → our EventType
    let type: EventType | null = null;
    let issueNumber: number | undefined;
    let prNumber: number | undefined;
    let body = "";
    let title = "";
    let labels: string[] = [];

    switch (githubEvent) {
      case "issues":
        issueNumber = payload.issue?.number;
        body = payload.issue?.body || "";
        title = payload.issue?.title || "";
        labels = (payload.issue?.labels || []).map((l: any) => l.name);
        if (action === "opened") type = "issue.opened";
        else if (action === "reopened") type = "issue.reopened";
        break;

      case "pull_request":
        prNumber = payload.pull_request?.number;
        issueNumber = prNumber; // PRs are issues too
        body = payload.pull_request?.body || "";
        title = payload.pull_request?.title || "";
        labels = (payload.pull_request?.labels || []).map((l: any) => l.name);
        if (action === "opened") type = "pr.opened";
        // synchronize fires on every new commit pushed to the PR's branch.
        // We map it through so the pr-review workflow re-runs against the
        // new head SHA — without this, branch protection on the new SHA
        // sits with no `last-light/review` check after the first one.
        else if (action === "synchronize") type = "pr.synchronize";
        // reopened: closed-then-reopened PRs deserve a fresh look too.
        else if (action === "reopened") type = "pr.reopened";
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
          if (prNumber) type = "pr.synchronize";
        }
        break;

      case "check_suite":
        if (action === "rerequested") {
          prNumber = payload.check_suite?.pull_requests?.[0]?.number;
          issueNumber = prNumber;
          if (prNumber) type = "pr.synchronize";
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
      sender,
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
    this.server = serve({
      fetch: this.app.fetch,
      port: this.config.port,
      hostname: "0.0.0.0",
    });
    console.log(`[github] Webhook listener started on port ${this.config.port}`);
  }

  async stop(): Promise<void> {
    if (this.server) {
      this.server.close();
      this.server = null;
      console.log("[github] Webhook listener stopped");
    }
  }
}
