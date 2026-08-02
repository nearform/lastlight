import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createHmac } from "crypto";

// src/connectors/github-webhook.ts now logs webhook/installation events via
// the pino LoggerPort instead of console — mock the logger module so the
// suite's stderr stays free of real pino JSON (no assertions here depend on
// the logged content).
vi.mock("#src/logging/logger.js", () => {
  const noopLogger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    fatal: vi.fn(),
    child: () => noopLogger,
  };
  return { logger: () => noopLogger };
});

import { GitHubWebhookConnector } from "#src/connectors/github-webhook.js";
import {
  setRuntimeConfig,
  resetRuntimeConfigForTests,
  type LastLightConfig,
} from "#src/config/config.js";
import {
  getInstallationRepos,
  getManagedRepos,
  isManagedRepo,
  setInstallationRepos,
  resetInstallationReposForTests,
} from "#src/managed-repos.js";

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

/** POST a signed `check_suite` webhook (with conclusion + head_commit). */
async function postCheckSuiteCompleted(
  conn: GitHubWebhookConnector,
  opts: {
    conclusion: string;
    prNumber?: number;
    senderLogin?: string;
    commitMessage?: string;
    commitAuthor?: string;
    headBranch?: string;
    headSha?: string;
  },
): Promise<{ status: number; json: any; emitted: any | null }> {
  let emitted: any = null;
  conn.on("event", (e) => { emitted = e; });
  const senderLogin = opts.senderLogin ?? "github-actions[bot]";
  const payload = {
    action: "completed",
    repository: { full_name: REPO },
    sender: { login: senderLogin, type: senderLogin.endsWith("[bot]") ? "Bot" : "User" },
    check_suite: {
      id: 1,
      conclusion: opts.conclusion,
      head_branch: opts.headBranch,
      head_sha: opts.headSha ?? "deadbeefcafe",
      pull_requests: opts.prNumber ? [{ number: opts.prNumber, head: { ref: "dependabot/npm/lodash-4.17.21" } }] : [],
      head_commit: {
        message: opts.commitMessage ?? "Bump lodash from 4.17.20 to 4.17.21",
        author: { name: opts.commitAuthor ?? "dependabot[bot]" },
      },
    },
  };
  const body = JSON.stringify(payload);
  const res = await conn.honoApp.request("/webhooks/github", {
    method: "POST",
    headers: {
      "x-hub-signature-256": sign(body),
      "x-github-event": "check_suite",
      "x-github-delivery": "test-delivery",
      "content-type": "application/json",
    },
    body,
  });
  const json = await res.json();
  await new Promise((r) => setImmediate(r));
  return { status: res.status, json, emitted };
}

describe("GitHubWebhookConnector — failed checks", () => {
  beforeEach(() => {
    setRuntimeConfig({ managedRepos: [REPO] } as unknown as LastLightConfig);
  });
  afterEach(() => resetRuntimeConfigForTests());

  it("emits pr.checks_failed for a failing check_suite, even from a bot sender", async () => {
    const { status, emitted } = await postCheckSuiteCompleted(connector(), {
      conclusion: "failure",
      prNumber: 681,
    });
    expect(status).toBe(202);
    expect(emitted).not.toBeNull();
    expect(emitted.type).toBe("pr.checks_failed");
    expect(emitted.prNumber).toBe(681);
    // classifier signal comes from the head commit (the PR ref carries neither)
    expect(emitted.title).toBe("Bump lodash from 4.17.20 to 4.17.21");
    expect(emitted.issueAuthor).toBe("dependabot[bot]");
  });

  it("also emits for a timed_out conclusion", async () => {
    const { emitted } = await postCheckSuiteCompleted(connector(), {
      conclusion: "timed_out",
      prNumber: 5,
    });
    expect(emitted?.type).toBe("pr.checks_failed");
  });

  it("ignores a successful check_suite from a non-dependency author", async () => {
    // A green PR authored by a human is not a dependency bump — no event fires
    // (we don't flood the router with every green PR).
    const { json, emitted } = await postCheckSuiteCompleted(connector(), {
      conclusion: "success",
      prNumber: 5,
      commitAuthor: "Ada Lovelace",
      commitMessage: "Add feature",
    });
    expect(json.filtered).toBe(true);
    expect(emitted).toBeNull();
  });

  it("ignores a failing check_suite on a non-dependency (human) PR", async () => {
    // Regression: a human's red PR must NOT reach the router — only a
    // Dependabot/Renovate bump does. The red path is gated by the same
    // deterministic commit-author / branch-prefix check as the green path;
    // without it the LLM classifier misfired human PRs onto dependabot-ci-fix.
    const { json, emitted } = await postCheckSuiteCompleted(connector(), {
      conclusion: "failure",
      prNumber: 207,
      commitAuthor: "Ada Lovelace",
      commitMessage: "feat(identity): user identity records + actor logging",
      headBranch: "lastlight/205-user-identity",
    });
    expect(json.filtered).toBe(true);
    expect(emitted).toBeNull();
  });

  it("emits pr.checks_failed on a human PR whose head commit WE pushed", async () => {
    // The CI feedback loop `pr-fix` has never had: it could push a fix and
    // never learn whether the build went green, because this event only ever
    // fired for dependency PRs. `git-auth.ts` stamps `user.name = botLogin` on
    // our commits and the check_suite payload carries the same field.
    const { emitted } = await postCheckSuiteCompleted(connector(), {
      conclusion: "failure",
      prNumber: 207,
      commitAuthor: BOT_LOGIN,
      commitMessage: "fix(ci): pin vitest to 3.2.4",
      headBranch: "lastlight/205-user-identity",
    });
    expect(emitted?.type).toBe("pr.checks_failed");
    // ...and the router must send it to `pr-fix`, not the dependency workflow.
    expect(emitted.isDependencyPr).toBe(false);
  });

  it("carries isDependencyPr: true for a genuine bump", async () => {
    const { emitted } = await postCheckSuiteCompleted(connector(), {
      conclusion: "failure",
      prNumber: 681,
    });
    expect(emitted.isDependencyPr).toBe(true);
  });

  it("still ignores a human PR the bot has never pushed to", async () => {
    const { json, emitted } = await postCheckSuiteCompleted(connector(), {
      conclusion: "failure",
      prNumber: 207,
      commitAuthor: "Ada Lovelace",
      commitMessage: "feat: something human",
      headBranch: "feature/whatever",
    });
    expect(json.filtered).toBe(true);
    expect(emitted).toBeNull();
  });

  it("emits pr.checks_failed for a Renovate PR detected by head branch", async () => {
    // The commit author isn't the bot (squashed/proxied), but the branch is.
    const { emitted } = await postCheckSuiteCompleted(connector(), {
      conclusion: "failure",
      prNumber: 42,
      commitAuthor: "Ada Lovelace",
      headBranch: "renovate/lodash-4.x",
    });
    expect(emitted?.type).toBe("pr.checks_failed");
    expect(emitted.prNumber).toBe(42);
  });

  it("ignores a failing check_suite with no associated PR (e.g. a fork)", async () => {
    const { json, emitted } = await postCheckSuiteCompleted(connector(), {
      conclusion: "failure",
    });
    expect(json.filtered).toBe(true);
    expect(emitted).toBeNull();
  });
});

describe("GitHubWebhookConnector — passed checks (dependency PRs)", () => {
  beforeEach(() => {
    setRuntimeConfig({ managedRepos: [REPO] } as unknown as LastLightConfig);
  });
  afterEach(() => resetRuntimeConfigForTests());

  it("emits pr.checks_passed for a green Dependabot PR (detected by commit author)", async () => {
    const { status, emitted } = await postCheckSuiteCompleted(connector(), {
      conclusion: "success",
      prNumber: 681,
      commitAuthor: "dependabot[bot]",
    });
    expect(status).toBe(202);
    expect(emitted).not.toBeNull();
    expect(emitted.type).toBe("pr.checks_passed");
    expect(emitted.prNumber).toBe(681);
    expect(emitted.title).toBe("Bump lodash from 4.17.20 to 4.17.21");
    expect(emitted.issueAuthor).toBe("dependabot[bot]");
  });

  it("emits pr.checks_passed for a green Renovate PR (detected by head branch)", async () => {
    const { emitted } = await postCheckSuiteCompleted(connector(), {
      conclusion: "success",
      prNumber: 42,
      commitAuthor: "Ada Lovelace", // author isn't the bot; branch is the signal
      headBranch: "renovate/lodash-4.x",
    });
    expect(emitted?.type).toBe("pr.checks_passed");
    expect(emitted.prNumber).toBe(42);
  });

  it("ignores a green dependency check_suite with no associated PR", async () => {
    const { json, emitted } = await postCheckSuiteCompleted(connector(), {
      conclusion: "success",
      commitAuthor: "dependabot[bot]",
    });
    expect(json.filtered).toBe(true);
    expect(emitted).toBeNull();
  });
});

describe("GitHubWebhookConnector — settle-aware emit gate", () => {
  beforeEach(() => {
    setRuntimeConfig({ managedRepos: [REPO] } as unknown as LastLightConfig);
  });
  afterEach(() => resetRuntimeConfigForTests());

  /** A connector whose aggregate check-conclusion lookup is stubbed. */
  function connectorWithChecks(
    conclusion: "passing" | "failing" | "pending" | "none",
    trigger: "eager" | "after-checks" | "on-request" = "eager",
  ): { conn: GitHubWebhookConnector; calls: Array<[string, string, string]> } {
    const calls: Array<[string, string, string]> = [];
    const conn = new GitHubWebhookConnector({
      port: 0,
      webhookSecret: SECRET,
      botLogin: BOT_LOGIN,
      getChecksConclusion: async (owner, repo, ref) => {
        calls.push([owner, repo, ref]);
        return conclusion;
      },
      reviewTrigger: () => trigger,
    });
    return { conn, calls };
  }

  it("emits pr.checks_passed ONLY when the whole SHA has settled green", async () => {
    const { conn, calls } = connectorWithChecks("passing");
    const { emitted } = await postCheckSuiteCompleted(conn, {
      conclusion: "success",
      prNumber: 190,
      commitAuthor: "dependabot[bot]",
      headSha: "abc1234def",
    });
    expect(emitted?.type).toBe("pr.checks_passed");
    expect(emitted.headSha).toBe("abc1234def");
    // queried the aggregate state for the head SHA
    expect(calls).toEqual([["acme", "widgets", "abc1234def"]]);
  });

  it("drops a green suite while sibling suites are still pending", async () => {
    // A repo with several check-reporting apps: this suite is green but the
    // aggregate is still 'pending' — no event, so we don't assess mid-flight.
    // Only the LAST suite to settle flips it to 'passing' → exactly one event.
    const { conn } = connectorWithChecks("pending");
    const { json, emitted } = await postCheckSuiteCompleted(conn, {
      conclusion: "success",
      prNumber: 190,
      commitAuthor: "dependabot[bot]",
    });
    expect(json.filtered).toBe(true);
    expect(emitted).toBeNull();
  });

  it("emits pr.checks_failed ONLY when the SHA has settled red", async () => {
    const { conn } = connectorWithChecks("failing");
    const { emitted } = await postCheckSuiteCompleted(conn, {
      conclusion: "failure",
      prNumber: 7,
      headSha: "feed0000",
    });
    expect(emitted?.type).toBe("pr.checks_failed");
    expect(emitted.headSha).toBe("feed0000");
  });

  it("drops a red suite while the aggregate is still pending", async () => {
    const { conn } = connectorWithChecks("pending");
    const { json, emitted } = await postCheckSuiteCompleted(conn, {
      conclusion: "failure",
      prNumber: 7,
    });
    expect(json.filtered).toBe(true);
    expect(emitted).toBeNull();
  });

  it("applies the settle gate to a bot-authored head too", async () => {
    // The broadened emit (§3.4) does NOT get a free pass on settling: a repo
    // with several check-reporting apps must still fire once per SHA, not once
    // per suite, when the head commit is ours.
    const { conn, calls } = connectorWithChecks("pending");
    const { json, emitted } = await postCheckSuiteCompleted(conn, {
      conclusion: "failure",
      prNumber: 207,
      commitAuthor: BOT_LOGIN,
      headBranch: "lastlight/205-user-identity",
      headSha: "cafe1234",
    });
    expect(json.filtered).toBe(true);
    expect(emitted).toBeNull();
    expect(calls).toEqual([["acme", "widgets", "cafe1234"]]);
  });

  it("does not broaden past dependency PRs unless review.trigger is after-checks", async () => {
    // Emitting is what costs event volume, so the broadening is gated on the
    // operator's mode actually having a consumer for the settle event.
    const { conn, calls } = connectorWithChecks("passing", "eager");
    const { json, emitted } = await postCheckSuiteCompleted(conn, {
      conclusion: "success",
      prNumber: 7,
      commitAuthor: "Ada Lovelace",
      commitMessage: "feat: something human",
      headBranch: "feature/whatever",
    });
    expect(json.filtered).toBe(true);
    expect(emitted).toBeNull();
    expect(calls).toEqual([]);
  });

  it("emits pr.checks_settled for a settled-GREEN non-dependency PR under after-checks", async () => {
    const { conn } = connectorWithChecks("passing", "after-checks");
    const { emitted } = await postCheckSuiteCompleted(conn, {
      conclusion: "success",
      prNumber: 7,
      commitAuthor: "Ada Lovelace",
      commitMessage: "feat: something human",
      headBranch: "feature/whatever",
      headSha: "beef0001",
    });
    expect(emitted?.type).toBe("pr.checks_settled");
    expect(emitted.headSha).toBe("beef0001");
  });

  it("emits pr.checks_settled for a settled-RED human PR too — either colour", async () => {
    // 09 locked decision 14: the `passing` variant was deleted. A red result is
    // useful review input, and a PR we gave up on never goes green.
    const { conn } = connectorWithChecks("failing", "after-checks");
    const { emitted } = await postCheckSuiteCompleted(conn, {
      conclusion: "failure",
      prNumber: 7,
      commitAuthor: "Ada Lovelace",
      commitMessage: "feat: something human",
      headBranch: "feature/whatever",
    });
    expect(emitted?.type).toBe("pr.checks_settled");
  });

  it("FIX OUTRANKS REVIEW — a red dependency PR stays pr.checks_failed under after-checks", async () => {
    // One envelope per delivery is all `normalize()` can return, so the
    // precedence is the shape of the pipeline, not a policy bolted on later.
    const { conn } = connectorWithChecks("failing", "after-checks");
    const { emitted } = await postCheckSuiteCompleted(conn, {
      conclusion: "failure",
      prNumber: 190,
      commitAuthor: "dependabot[bot]",
    });
    expect(emitted?.type).toBe("pr.checks_failed");
  });

  it("a green dependency PR still routes to the MERGE path, not a review", async () => {
    const { conn } = connectorWithChecks("passing", "after-checks");
    const { emitted } = await postCheckSuiteCompleted(conn, {
      conclusion: "success",
      prNumber: 190,
      commitAuthor: "dependabot[bot]",
    });
    expect(emitted?.type).toBe("pr.checks_passed");
  });

  it("still drops a settle whose aggregate has not settled", async () => {
    const { conn } = connectorWithChecks("pending", "after-checks");
    const { json, emitted } = await postCheckSuiteCompleted(conn, {
      conclusion: "success",
      prNumber: 7,
      commitAuthor: "Ada Lovelace",
      commitMessage: "feat: something human",
      headBranch: "feature/whatever",
    });
    expect(json.filtered).toBe(true);
    expect(emitted).toBeNull();
  });

  it("skips the settle lookup entirely for a non-dependency red PR", async () => {
    // The dependency gate short-circuits before the network call, so a human's
    // red PR costs no getChecksConclusion round-trip.
    const { conn, calls } = connectorWithChecks("failing");
    const { json, emitted } = await postCheckSuiteCompleted(conn, {
      conclusion: "failure",
      prNumber: 7,
      commitAuthor: "Ada Lovelace",
      commitMessage: "feat: something human",
      headBranch: "feature/whatever",
    });
    expect(json.filtered).toBe(true);
    expect(emitted).toBeNull();
    expect(calls).toEqual([]);
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

/** POST a signed installation-family webhook (no `payload.repository`). */
async function postInstallationEvent(
  conn: GitHubWebhookConnector,
  event: "installation" | "installation_repositories",
  payload: Record<string, unknown>,
): Promise<{ status: number; json: any }> {
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
  return { status: res.status, json: await res.json() };
}

describe("GitHubWebhookConnector — installation repo sync", () => {
  beforeEach(() => {
    // Empty configured list → the effective list falls back to the installation cache.
    setRuntimeConfig({ managedRepos: [] } as unknown as LastLightConfig);
    resetInstallationReposForTests();
  });
  afterEach(() => {
    resetRuntimeConfigForTests();
    resetInstallationReposForTests();
  });

  it("seeds the cache from an `installation` created event", async () => {
    const { status, json } = await postInstallationEvent(connector(), "installation", {
      action: "created",
      installation: { id: 1 },
      repositories: [{ full_name: "acme/one" }, { full_name: "acme/two" }],
    });
    expect(status).toBe(200);
    expect(json).toMatchObject({ accepted: true, kind: "installation-sync" });
    expect(getInstallationRepos().sort()).toEqual(["acme/one", "acme/two"]);
    expect(isManagedRepo("acme/one")).toBe(true);
    expect(getManagedRepos()).toContain("acme/two");
  });

  it("adds and removes repos on installation_repositories events", async () => {
    setInstallationRepos(["acme/one"]);
    await postInstallationEvent(connector(), "installation_repositories", {
      action: "added",
      repositories_added: [{ full_name: "acme/two" }, { full_name: "acme/three" }],
    });
    expect(getInstallationRepos().sort()).toEqual(["acme/one", "acme/three", "acme/two"]);

    await postInstallationEvent(connector(), "installation_repositories", {
      action: "removed",
      repositories_removed: [{ full_name: "acme/one" }],
    });
    expect(getInstallationRepos().sort()).toEqual(["acme/three", "acme/two"]);
    expect(isManagedRepo("acme/one")).toBe(false);
  });

  it("clears the cache when the app is uninstalled", async () => {
    setInstallationRepos(["acme/one", "acme/two"]);
    await postInstallationEvent(connector(), "installation", {
      action: "deleted",
      installation: { id: 1 },
    });
    expect(getInstallationRepos()).toEqual([]);
  });

  it("processes installation events even when the action is in IGNORED_ACTIONS (deleted)", async () => {
    // `deleted` is an ignored action for repo events, but installation/deleted
    // must still be handled — it's intercepted before the IGNORED_ACTIONS filter.
    setInstallationRepos(["acme/one"]);
    const { json } = await postInstallationEvent(connector(), "installation", {
      action: "deleted",
      installation: { id: 1 },
    });
    expect(json.kind).toBe("installation-sync");
    expect(getInstallationRepos()).toEqual([]);
  });
});

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

/**
 * Phase 7's new PR-review signals. `normalize()` is the first of the four
 * places `review.trigger` used to be enforceable, and the only one that decides
 * whether a GitHub action becomes an event AT ALL — before this, `labeled`,
 * `review_requested` and `ready_for_review` all produced nothing and the
 * delivery was answered `{ filtered: true, reason: "unmapped event" }`.
 */
describe("GitHubWebhookConnector — review-request signals", () => {
  beforeEach(() => {
    setRuntimeConfig({ managedRepos: [REPO] } as unknown as LastLightConfig);
  });
  afterEach(() => resetRuntimeConfigForTests());

  async function postPr(
    conn: GitHubWebhookConnector,
    payloadOver: Record<string, unknown>,
  ): Promise<{ json: any; emitted: any | null }> {
    let emitted: any = null;
    conn.on("event", (e) => { emitted = e; });
    const payload = {
      repository: { full_name: REPO },
      sender: { login: "maintainer", type: "User" },
      pull_request: {
        number: 42,
        title: "Add X",
        body: "",
        labels: [{ name: "enhancement" }],
        draft: false,
        user: { login: "alice" },
      },
      ...payloadOver,
    };
    const body = JSON.stringify(payload);
    const res = await conn.honoApp.request("/webhooks/github", {
      method: "POST",
      headers: {
        "x-hub-signature-256": sign(body),
        "x-github-event": "pull_request",
        "x-github-delivery": "d",
        "content-type": "application/json",
      },
      body,
    });
    const json = await res.json();
    await new Promise((r) => setImmediate(r));
    return { json, emitted };
  }

  it("maps ready_for_review to pr.opened SEMANTICS — the event that un-defers a draft", async () => {
    // With `review.skipDraft: true` and nothing else, a PR opened as a draft and
    // later marked ready would get no webhook-driven review at all.
    const { emitted } = await postPr(connector(), { action: "ready_for_review" });
    expect(emitted?.type).toBe("pr.opened");
    expect(emitted.prNumber).toBe(42);
  });

  it("maps labeled to pr.labeled, carrying the label that was just added", async () => {
    const { emitted } = await postPr(connector(), {
      action: "labeled",
      label: { name: "lastlight:review" },
    });
    expect(emitted?.type).toBe("pr.labeled");
    expect(emitted.addedLabel).toBe("lastlight:review");
  });

  it("maps review_requested to pr.review_requested, carrying the reviewer", async () => {
    const { emitted } = await postPr(connector(), {
      action: "review_requested",
      requested_reviewer: { login: "last-light[bot]" },
    });
    expect(emitted?.type).toBe("pr.review_requested");
    expect(emitted.requestedReviewer).toBe("last-light[bot]");
  });

  it("carries a TEAM request too — the router decides it isn't ours", async () => {
    const { emitted } = await postPr(connector(), {
      action: "review_requested",
      requested_team: { slug: "reviewers" },
    });
    expect(emitted?.requestedReviewer).toBe("team/reviewers");
  });

  it("still never reviews a PR the bot itself authored, on either new signal", async () => {
    for (const over of [
      { action: "labeled", label: { name: "lastlight:review" } },
      { action: "review_requested", requested_reviewer: { login: BOT_LOGIN } },
    ]) {
      const { json, emitted } = await postPr(connector(), {
        ...over,
        pull_request: {
          number: 42,
          title: "Bot PR",
          body: "",
          labels: [],
          draft: false,
          user: { login: BOT_LOGIN },
        },
      });
      expect(json.filtered).toBe(true);
      expect(emitted).toBeNull();
    }
  });

  it("a label with no name produces nothing rather than an event with an empty label", async () => {
    const { json, emitted } = await postPr(connector(), { action: "labeled", label: {} });
    expect(json.filtered).toBe(true);
    expect(emitted).toBeNull();
  });

  it("a Re-run on OUR check is a review REQUEST, not a synchronize", async () => {
    // `pr.synchronize` is an attention event, which `after-checks`/`on-request`
    // defer — so routing the Re-run there would make the check's own button a
    // no-op, which is precisely what it is advertised as.
    const conn = connector();
    let emitted: any = null;
    conn.on("event", (e) => { emitted = e; });
    const payload = {
      action: "rerequested",
      repository: { full_name: REPO },
      sender: { login: "maintainer", type: "User" },
      check_run: { name: "last-light/review", pull_requests: [{ number: 42 }] },
    };
    const body = JSON.stringify(payload);
    await conn.honoApp.request("/webhooks/github", {
      method: "POST",
      headers: {
        "x-hub-signature-256": sign(body),
        "x-github-event": "check_run",
        "x-github-delivery": "d",
        "content-type": "application/json",
      },
      body,
    });
    await new Promise((r) => setImmediate(r));
    expect(emitted?.type).toBe("pr.review_requested");
    expect(emitted.requestedReviewer).toBe(BOT_LOGIN);
  });

  it("a Re-run on somebody ELSE's check still means 'the checks changed'", async () => {
    const conn = connector();
    let emitted: any = null;
    conn.on("event", (e) => { emitted = e; });
    const payload = {
      action: "rerequested",
      repository: { full_name: REPO },
      sender: { login: "maintainer", type: "User" },
      check_run: { name: "CI / build", pull_requests: [{ number: 42 }] },
    };
    const body = JSON.stringify(payload);
    await conn.honoApp.request("/webhooks/github", {
      method: "POST",
      headers: {
        "x-hub-signature-256": sign(body),
        "x-github-event": "check_run",
        "x-github-delivery": "d",
        "content-type": "application/json",
      },
      body,
    });
    await new Promise((r) => setImmediate(r));
    expect(emitted?.type).toBe("pr.synchronize");
  });

  it("an ISSUE label is still nothing — the widening costs a normalize, not a dispatch", async () => {
    const conn = connector();
    let emitted: any = null;
    conn.on("event", (e) => { emitted = e; });
    const payload = {
      action: "labeled",
      repository: { full_name: REPO },
      sender: { login: "maintainer", type: "User" },
      issue: { number: 9, title: "t", body: "", labels: [], user: { login: "alice" } },
      label: { name: "bug" },
    };
    const body = JSON.stringify(payload);
    const res = await conn.honoApp.request("/webhooks/github", {
      method: "POST",
      headers: {
        "x-hub-signature-256": sign(body),
        "x-github-event": "issues",
        "x-github-delivery": "d",
        "content-type": "application/json",
      },
      body,
    });
    expect((await res.json()).filtered).toBe(true);
    await new Promise((r) => setImmediate(r));
    expect(emitted).toBeNull();
  });
});
