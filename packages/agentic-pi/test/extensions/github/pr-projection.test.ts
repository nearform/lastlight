import { describe, test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import { GitHubClient } from "../../../src/extensions/github/client.js";
import type { GitHubAuth } from "../../../src/extensions/github/auth.js";

const staticAuth: GitHubAuth = {
  getToken: async () => "t",
  expiresAt: null,
  canRefresh: false,
};

/**
 * The bulk of a real PR payload: two full repository objects under head/base
 * plus a changelog-sized body. Sized to make an unprojected response obvious.
 */
const FAT_REPO = { id: 1, full_name: "acme/app", description: "x".repeat(4000) };
const LONG_BODY = "release notes\n".repeat(1000);

function pr(number: number) {
  return {
    number,
    title: `Bump left-pad to ${number}`,
    state: "open",
    draft: false,
    html_url: `https://github.com/acme/app/pull/${number}`,
    created_at: "2026-07-01T00:00:00Z",
    updated_at: "2026-07-02T00:00:00Z",
    merged_at: null,
    body: LONG_BODY,
    user: { login: "dependabot[bot]", id: 9, avatar_url: "https://…", node_id: "MDQ6" },
    labels: [{ id: 1, name: "dependencies", color: "0366d6", description: "d" }],
    head: { ref: "dependabot/npm/left-pad", sha: "aaa", repo: FAT_REPO },
    base: { ref: "main", sha: "bbb", repo: FAT_REPO },
    _links: { self: { href: "…" }, html: { href: "…" } },
    mergeable: true,
    mergeable_state: "clean",
    merged: false,
    maintainer_can_modify: true,
    additions: 1,
    deletions: 1,
    changed_files: 2,
    commits: 1,
  };
}

let server: Server;
let gh: GitHubClient;

describe("pull-request payload projection", () => {
  before(async () => {
    server = createServer((req, res) => {
      res.setHeader("content-type", "application/json");
      const list = req.url?.startsWith("/repos/acme/app/pulls?");
      res.end(JSON.stringify(list ? [pr(1), pr(2)] : pr(1)));
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    gh = new GitHubClient(staticAuth, {
      baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    });
  });

  after(() => server.close());

  test("listPullRequests returns a summary, not the raw payload", async () => {
    const { items: prs } = (await gh.listPullRequests("acme", "app")) as {
      items: Array<Record<string, unknown>>;
    };

    assert.equal(prs.length, 2);
    assert.deepEqual(prs[0], {
      number: 1,
      title: "Bump left-pad to 1",
      state: "open",
      draft: false,
      html_url: "https://github.com/acme/app/pull/1",
      author: "dependabot[bot]",
      head: "dependabot/npm/left-pad",
      base: "main",
      labels: ["dependencies"],
      created_at: "2026-07-01T00:00:00Z",
      updated_at: "2026-07-02T00:00:00Z",
      merged_at: null,
    });
    // The nested repo objects and the body are what made this call 345 kB on a
    // Renovate-heavy repo. Listing is for finding a PR, not for reading one.
    const json = JSON.stringify(prs);
    assert.ok(!json.includes("release notes"), "body must not be in the list");
    assert.ok(!json.includes(FAT_REPO.description), "head/base repo must not be in the list");
  });

  test("getPullRequest keeps mergeability and a bounded body", async () => {
    const got = (await gh.getPullRequest("acme", "app", 1)) as Record<string, unknown>;

    // The fields the merge/review prompts actually branch on.
    assert.equal(got.mergeable_state, "clean");
    assert.equal(got.author, "dependabot[bot]");
    assert.equal(got.head_sha, "aaa");
    assert.equal(got.head_repo, "acme/app");
    assert.equal(got.changed_files, 2);
    assert.deepEqual(got.labels, ["dependencies"]);

    // The dependency-impact rubric reads release notes out of the body, so it
    // survives — capped, with the cut declared.
    const body = got.body as string;
    assert.ok(body.startsWith("release notes"));
    assert.ok(body.length < LONG_BODY.length);
    // The notice names the escape hatch: that is how the agent learns the flag
    // exists, so it must stay in the message.
    assert.match(body, /truncated \d+ chars.*full_body: true/);

    assert.ok(
      !JSON.stringify(got).includes(FAT_REPO.description),
      "head/base repo objects must not survive",
    );
  });

  test("full_body lifts the cap without restoring the rest of the payload", async () => {
    const got = (await gh.getPullRequest("acme", "app", 1, { fullBody: true })) as Record<
      string,
      unknown
    >;

    assert.equal(got.body, LONG_BODY);
    // Opting into the whole changelog is not opting back into the raw PR.
    assert.ok(!JSON.stringify(got).includes(FAT_REPO.description));
    assert.equal(got.mergeable_state, "clean");
  });

  test("listPullRequests pages rather than silently cutting", async () => {
    // The stub always returns 2 PRs, so per_page: 2 is a "full" page.
    const p = (await gh.listPullRequests("acme", "app", { per_page: 2, page: 3 })) as {
      has_more: boolean;
      next_page: number;
      items: unknown[];
    };
    assert.equal(p.items.length, 2);
    assert.equal(p.has_more, true);
    assert.equal(p.next_page, 4);
  });

  test("a short body is returned verbatim", async () => {
    const short = { ...pr(1), body: "just a bump" };
    const one = createServer((_req, res) => {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(short));
    });
    await new Promise<void>((r) => one.listen(0, "127.0.0.1", r));
    try {
      const client = new GitHubClient(staticAuth, {
        baseUrl: `http://127.0.0.1:${(one.address() as AddressInfo).port}`,
      });
      const got = (await client.getPullRequest("acme", "app", 1)) as { body: string };
      assert.equal(got.body, "just a bump");
    } finally {
      one.close();
    }
  });
});
