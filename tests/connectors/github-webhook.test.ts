import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createHmac } from "crypto";
import { GitHubWebhookConnector } from "#src/connectors/github-webhook.js";
import {
  setRuntimeConfig,
  resetRuntimeConfigForTests,
  type LastLightConfig,
} from "#src/config/config.js";

const SECRET = "test-webhook-secret";
const BOT_LOGIN = "last-light[bot]";
const REPO = "acme/widgets";

function sign(body: string): string {
  return "sha256=" + createHmac("sha256", SECRET).update(body).digest("hex");
}

function connector(): GitHubWebhookConnector {
  return new GitHubWebhookConnector({
    port: 0,
    webhookSecret: SECRET,
    botLogin: BOT_LOGIN,
  });
}

/** POST a signed `pull_request` webhook and return the parsed JSON response. */
async function postPullRequest(
  conn: GitHubWebhookConnector,
  opts: { action: string; authorLogin: string; senderLogin: string },
): Promise<{ status: number; json: any }> {
  const payload = {
    action: opts.action,
    repository: { full_name: REPO },
    sender: { login: opts.senderLogin, type: opts.senderLogin.endsWith("[bot]") ? "Bot" : "User" },
    pull_request: {
      number: 109,
      title: "Some change",
      body: "",
      labels: [],
      user: { login: opts.authorLogin },
    },
  };
  const body = JSON.stringify(payload);
  const res = await conn.honoApp.request("/webhooks/github", {
    method: "POST",
    headers: {
      "x-hub-signature-256": sign(body),
      "x-github-event": "pull_request",
      "x-github-delivery": "test-delivery",
      "content-type": "application/json",
    },
    body,
  });
  return { status: res.status, json: await res.json() };
}

describe("GitHubWebhookConnector — self-review guard", () => {
  beforeEach(() => {
    setRuntimeConfig({ managedRepos: [REPO] } as unknown as LastLightConfig);
  });
  afterEach(() => resetRuntimeConfigForTests());

  it("drops a PR the bot itself authored (opened)", async () => {
    const { json } = await postPullRequest(connector(), {
      action: "opened",
      authorLogin: BOT_LOGIN,
      senderLogin: BOT_LOGIN,
    });
    expect(json.filtered).toBe(true);
    expect(json.reason).toBe("bot-authored PR (self-review)");
  });

  it("drops a bot-authored PR on synchronize too", async () => {
    const { json } = await postPullRequest(connector(), {
      action: "synchronize",
      authorLogin: BOT_LOGIN,
      senderLogin: BOT_LOGIN,
    });
    expect(json.filtered).toBe(true);
    expect(json.reason).toBe("bot-authored PR (self-review)");
  });

  it("accepts a bot fix-commit (synchronize) on a HUMAN-authored PR — the re-review case", async () => {
    // sender is the bot (it pushed the fix), but the PR author is a human:
    // this must still flow through so branch protection gets a check on the
    // new head SHA. The author-based guard must NOT fire here.
    const { status, json } = await postPullRequest(connector(), {
      action: "synchronize",
      authorLogin: "a-human",
      senderLogin: BOT_LOGIN,
    });
    expect(status).toBe(202);
    expect(json.accepted).toBe(true);
  });

  it("accepts a normal human-authored PR (opened)", async () => {
    const { status, json } = await postPullRequest(connector(), {
      action: "opened",
      authorLogin: "a-human",
      senderLogin: "a-human",
    });
    expect(status).toBe(202);
    expect(json.accepted).toBe(true);
  });
});

/** POST a signed check_run/check_suite event; capture any emitted envelope. */
async function postCheckEvent(
  conn: GitHubWebhookConnector,
  event: "check_run" | "check_suite",
  opts: { action: string; prNumber?: number },
): Promise<{ status: number; json: any; emitted: any | null }> {
  let emitted: any = null;
  conn.on("event", (e) => { emitted = e; });
  const prs = opts.prNumber ? [{ number: opts.prNumber, head: { ref: "feature" } }] : [];
  const payload = {
    action: opts.action,
    repository: { full_name: REPO },
    sender: { login: "a-human", type: "User" },
    [event]: { id: 1, head_sha: "abc123", pull_requests: prs },
  };
  const body = JSON.stringify(payload);
  const res = await conn.honoApp.request("/webhooks/github", {
    method: "POST",
    headers: {
      "x-hub-signature-256": sign(body),
      "x-github-event": event,
      "x-github-delivery": "test-delivery",
      "content-type": "application/json",
    },
    body,
  });
  const json = await res.json();
  // emission is scheduled via setImmediate — let it flush
  await new Promise((r) => setImmediate(r));
  return { status: res.status, json, emitted };
}

describe("GitHubWebhookConnector — re-run checks", () => {
  beforeEach(() => {
    setRuntimeConfig({ managedRepos: [REPO] } as unknown as LastLightConfig);
  });
  afterEach(() => resetRuntimeConfigForTests());

  it("maps check_run.rerequested to a pr.synchronize for the associated PR", async () => {
    const { status, emitted } = await postCheckEvent(connector(), "check_run", {
      action: "rerequested",
      prNumber: 42,
    });
    expect(status).toBe(202);
    expect(emitted).not.toBeNull();
    expect(emitted.type).toBe("pr.synchronize");
    expect(emitted.prNumber).toBe(42);
  });

  it("maps check_suite.rerequested to a pr.synchronize", async () => {
    const { emitted } = await postCheckEvent(connector(), "check_suite", {
      action: "rerequested",
      prNumber: 7,
    });
    expect(emitted?.type).toBe("pr.synchronize");
    expect(emitted?.prNumber).toBe(7);
  });

  it("ignores check_run.completed (only re-runs should trigger)", async () => {
    const { json, emitted } = await postCheckEvent(connector(), "check_run", {
      action: "completed",
      prNumber: 42,
    });
    expect(json.filtered).toBe(true);
    expect(emitted).toBeNull();
  });

  it("ignores a rerequested check_run with no associated PR", async () => {
    const { json, emitted } = await postCheckEvent(connector(), "check_run", {
      action: "rerequested",
    });
    expect(json.filtered).toBe(true);
    expect(emitted).toBeNull();
  });
});

/** POST a signed `issue_comment` webhook; capture any emitted envelope. */
async function postIssueComment(
  conn: GitHubWebhookConnector,
  opts: { issueAuthor: string; commenter: string; labels?: string[] },
): Promise<{ emitted: any | null }> {
  let emitted: any = null;
  conn.on("event", (e) => { emitted = e; });
  const payload = {
    action: "created",
    repository: { full_name: REPO },
    sender: { login: opts.commenter, type: "User" },
    issue: {
      number: 14,
      title: "Make sure todos have a target date",
      body: "original report",
      labels: (opts.labels || []).map((name) => ({ name })),
      user: { login: opts.issueAuthor },
    },
    comment: { body: "here are the repro steps", author_association: "NONE" },
  };
  const body = JSON.stringify(payload);
  await conn.honoApp.request("/webhooks/github", {
    method: "POST",
    headers: {
      "x-hub-signature-256": sign(body),
      "x-github-event": "issue_comment",
      "x-github-delivery": "test-delivery",
      "content-type": "application/json",
    },
    body,
  });
  await new Promise((r) => setImmediate(r));
  return { emitted };
}

describe("GitHubWebhookConnector — issue_comment normalization", () => {
  beforeEach(() => {
    setRuntimeConfig({ managedRepos: [REPO] } as unknown as LastLightConfig);
  });
  afterEach(() => resetRuntimeConfigForTests());

  it("sets issueAuthor to the issue's original author, distinct from the commenter", async () => {
    const { emitted } = await postIssueComment(connector(), {
      issueAuthor: "reporter",
      commenter: "someone-else",
      labels: ["enhancement", "needs-info"],
    });
    expect(emitted).not.toBeNull();
    expect(emitted.type).toBe("comment.created");
    expect(emitted.issueAuthor).toBe("reporter");
    expect(emitted.sender).toBe("someone-else");
    expect(emitted.labels).toContain("needs-info");
  });
});
