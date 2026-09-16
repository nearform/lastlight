import { describe, it, expect, vi } from "vitest";
import { GitHubClient } from "#src/engine/github/github.js";

/**
 * `listOpenBoardItems` — the board's one GitHub read.
 *
 * Pins three things: pull requests are never board items (the pipeline builds
 * issues), the PRs that close an issue ride along as links, and they cost NO
 * extra requests — they are a nested field of the same aliased search, so a
 * repo with fifty issues is still one GraphQL call, not fifty-one.
 */

function issueNode(number: number, prs: unknown[] = []) {
  return {
    __typename: "Issue",
    number,
    title: `Issue ${number}`,
    url: `https://github.com/acme/widget/issues/${number}`,
    createdAt: "2026-09-01T00:00:00.000Z",
    updatedAt: "2026-09-02T00:00:00.000Z",
    bodyText: "body",
    author: { login: "maintainer" },
    labels: { nodes: [{ name: "ready-for-agent", color: "ededed", description: null }] },
    closedByPullRequestsReferences: { nodes: prs },
  };
}

function clientWith(octokit: unknown): GitHubClient {
  const c = GitHubClient.withToken("t", "http://mock");
  (c as unknown as { staticOctokit: unknown }).staticOctokit = octokit;
  return c;
}

describe("listOpenBoardItems", () => {
  it("reads issues only, with their closing PRs, in ONE request for many issues", async () => {
    const nodes = Array.from({ length: 40 }, (_, i) => issueNode(i + 1));
    nodes[0] = issueNode(1, [
      { number: 31, url: "https://github.com/acme/widget/pull/31", title: "Build #1", state: "OPEN", isDraft: true },
      null,
    ]);
    // A PR that slipped into the results anyway must not become a board item.
    const graphql = vi.fn(async () => ({
      r0: { nodes: [...nodes, { ...issueNode(99), __typename: "PullRequest" }] },
    }));

    const out = await clientWith({ graphql }).listOpenBoardItems("acme", ["widget"]);

    expect(graphql).toHaveBeenCalledTimes(1);
    const [query, variables] = graphql.mock.calls[0] as unknown as [string, Record<string, unknown>];
    expect(variables.q0).toBe("repo:acme/widget is:open is:issue");
    expect(query).toContain("closedByPullRequestsReferences");
    expect(query).not.toContain("on PullRequest");

    const items = out.get("acme/widget")!.items;
    expect(items).toHaveLength(40);
    expect(items.map((i) => i.number)).not.toContain(99);
    expect(items[0]!.linkedPrs).toEqual([
      { number: 31, url: "https://github.com/acme/widget/pull/31", title: "Build #1", state: "OPEN", draft: true },
    ]);
    expect(items[1]!.linkedPrs).toEqual([]);
  });

  it("drops pull requests from the throttled REST fallback too", async () => {
    const throttled = Object.assign(new Error("secondary rate limit"), { status: 403 });
    const graphql = vi.fn(async () => {
      throw throttled;
    });
    const client = clientWith({ graphql });
    vi.spyOn(client, "listRepoActivitySince").mockResolvedValue([
      { number: 1, isPr: false, closedAt: null, title: "Issue", htmlUrl: "u1", authorLogin: "a", createdAt: "2026-09-01T00:00:00.000Z", draft: false, labels: [] },
      { number: 2, isPr: true, closedAt: null, title: "PR", htmlUrl: "u2", authorLogin: "a", createdAt: "2026-09-01T00:00:00.000Z", draft: false, labels: [] },
    ] as unknown as Awaited<ReturnType<GitHubClient["listRepoActivitySince"]>>);

    const out = await client.listOpenBoardItems("acme", ["widget"]);

    const entry = out.get("acme/widget")!;
    expect(entry.fallback).toBe(true);
    expect(entry.items.map((i) => i.number)).toEqual([1]);
    expect(entry.items[0]!.linkedPrs).toEqual([]);
  });
});
