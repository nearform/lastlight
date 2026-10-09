import { describe, it, expect } from "vitest";
import {
  DISCUSSION_THREADS_MAX_PAGES,
  DISCUSSION_THREADS_PAGE,
  GitHubClient,
} from "#src/engine/github/github.js";
import { foldReviewLedger, carriedOpen, findingFingerprint, type LedgerFinding } from "#src/engine/review-ledger.js";

/**
 * `getPullRequestDiscussion` must see EVERY review thread, not the first page.
 *
 * Regression: nearform/techbase#2912 had 58 threads and the read took
 * `reviewThreads(first: 50)`, oldest first. The three threads a maintainer had
 * just resolved were #53, #55 and #57 — never read, so the review ledger could
 * not tell they were resolved and the bot reported "3 finding(s) from an
 * earlier review still open" on every run, forever.
 */

interface FakeThread {
  path: string;
  line: number;
  isResolved: boolean;
  isOutdated: boolean;
  comments: { nodes: Array<{ author: { __typename: string; login: string }; body: string }> };
}

const BOT = { __typename: "Bot", login: "nearform-lastlight" };

const thread = (n: number, over: Partial<FakeThread> = {}): FakeThread => ({
  path: `src/f${n}.ts`,
  line: n,
  isResolved: false,
  isOutdated: false,
  comments: { nodes: [{ author: BOT, body: `**[Minor] finding ${n}**` }] },
  ...over,
});

/** A fake Octokit whose `graphql` serves `threads` in cursor pages of whatever size is asked. */
function pagedOctokit(threads: FakeThread[]) {
  const calls: Array<{ after?: string; pageSize?: number }> = [];
  const octokit = {
    graphql: async (_query: string, vars: { after?: string; pageSize?: number }) => {
      calls.push({ after: vars.after, pageSize: vars.pageSize });
      const size = vars.pageSize ?? DISCUSSION_THREADS_PAGE;
      const start = vars.after ? Number(vars.after) : 0;
      const slice = threads.slice(start, start + size);
      const end = start + slice.length;
      return {
        repository: {
          pullRequest: {
            reviews: { nodes: [] },
            comments: { nodes: [] },
            reviewThreads: {
              pageInfo: { hasNextPage: end < threads.length, endCursor: String(end) },
              nodes: slice,
            },
          },
        },
      };
    },
  };
  return { octokit, calls };
}

function clientWith(octokit: unknown): GitHubClient {
  const c = GitHubClient.withToken("t", "http://mock");
  (c as unknown as { staticOctokit: unknown }).staticOctokit = octokit;
  return c;
}

describe("GitHubClient.getPullRequestDiscussion — review thread paging", () => {
  it("makes a single request for a PR that fits one page", async () => {
    const { octokit, calls } = pagedOctokit(Array.from({ length: 40 }, (_, i) => thread(i + 1)));
    const d = await clientWith(octokit).getPullRequestDiscussion("o", "r", 1);
    expect(d.threads).toHaveLength(40);
    expect(d.threadsTruncated).toBe(false);
    expect(calls).toHaveLength(1);
  });

  it("reads every thread of a PR with more than one page of them (the #2912 shape: 58)", async () => {
    const all = Array.from({ length: 58 }, (_, i) => thread(i + 1));
    const { octokit } = pagedOctokit(all);
    const d = await clientWith(octokit).getPullRequestDiscussion("o", "r", 1);
    expect(d.threads).toHaveLength(58);
    expect(d.threads.at(-1)?.path).toBe("src/f58.ts");
    expect(d.threadsTruncated).toBe(false);
  });

  it("follows the cursor across several pages, in order", async () => {
    const all = Array.from({ length: 250 }, (_, i) => thread(i + 1));
    const { octokit, calls } = pagedOctokit(all);
    const d = await clientWith(octokit).getPullRequestDiscussion("o", "r", 1);
    expect(d.threads.map((t) => t.line)).toEqual(all.map((t) => t.line));
    expect(d.threadsTruncated).toBe(false);
    expect(calls.map((c) => c.after)).toEqual([undefined, "100", "200"]);
    expect(calls.every((c) => c.pageSize === DISCUSSION_THREADS_PAGE)).toBe(true);
  });

  it("reports truncation only when the page cap runs out, not when the PR has more than one page", async () => {
    const all = Array.from({ length: 400 }, (_, i) => thread(i + 1));
    const { octokit, calls } = pagedOctokit(all);
    const d = await clientWith(octokit).getPullRequestDiscussion("o", "r", 1);
    expect(calls).toHaveLength(DISCUSSION_THREADS_MAX_PAGES);
    expect(d.threads).toHaveLength(DISCUSSION_THREADS_PAGE * DISCUSSION_THREADS_MAX_PAGES);
    expect(d.threadsTruncated).toBe(true);
  });

  it("honours a smaller threadPageSize", async () => {
    const all = Array.from({ length: 12 }, (_, i) => thread(i + 1));
    const { octokit, calls } = pagedOctokit(all);
    const d = await clientWith(octokit).getPullRequestDiscussion("o", "r", 1, { threadPageSize: 5 });
    expect(d.threads).toHaveLength(12);
    expect(d.threadsTruncated).toBe(false);
    expect(calls.map((c) => c.after)).toEqual([undefined, "5", "10"]);
    expect(calls.every((c) => c.pageSize === 5)).toBe(true);
  });

  it("honours a smaller threadMaxPages", async () => {
    const all = Array.from({ length: 20 }, (_, i) => thread(i + 1));
    const { octokit, calls } = pagedOctokit(all);
    const d = await clientWith(octokit).getPullRequestDiscussion("o", "r", 1, {
      threadPageSize: 5,
      threadMaxPages: 2,
    });
    expect(calls).toHaveLength(2);
    expect(d.threads).toHaveLength(10);
    expect(d.threadsTruncated).toBe(true);
  });

  it("clamps threadPageSize to GitHub's 1..100 GraphQL first-range", async () => {
    const all = Array.from({ length: 3 }, (_, i) => thread(i + 1));
    const { octokit: over, calls: overCalls } = pagedOctokit(all);
    await clientWith(over).getPullRequestDiscussion("o", "r", 1, { threadPageSize: 200 });
    expect(overCalls[0]?.pageSize).toBe(100);

    const { octokit: under, calls: underCalls } = pagedOctokit(all);
    await clientWith(under).getPullRequestDiscussion("o", "r", 1, { threadPageSize: 0 });
    expect(underCalls[0]?.pageSize).toBe(1);
  });

  it("keeps the mapped shape for threads on later pages (resolved, bot, author)", async () => {
    const all = Array.from({ length: 120 }, (_, i) => thread(i + 1));
    all[110] = thread(111, { isResolved: true });
    const { octokit } = pagedOctokit(all);
    const d = await clientWith(octokit).getPullRequestDiscussion("o", "r", 1);
    expect(d.threads[110]).toMatchObject({
      path: "src/f111.ts",
      isResolved: true,
      comments: [{ author: "nearform-lastlight", isBot: true, body: "**[Minor] finding 111**" }],
    });
  });
});

describe("review ledger ← discussion: a resolved thread past the first page closes its finding", () => {
  const finding = (n: number): LedgerFinding => ({
    fp: findingFingerprint(`src/f${n}.ts`, `code ${n}`, `finding ${n}`),
    path: `src/f${n}.ts`,
    line: n,
    excerpt: `code ${n}`,
    title: `finding ${n}`,
    severity: "Minor",
    importance: "worth-mentioning",
    tier: "inline",
    reason: null,
    status: "open",
    foundAt: "aaa",
    lastSeenAt: "aaa",
  });

  it("no longer reports findings as open when their threads are resolved on page 2", async () => {
    // 58 threads; the last three (the #2912 shape) are resolved.
    const all = Array.from({ length: 58 }, (_, i) =>
      thread(i + 1, i >= 55 ? { isResolved: true } : {}),
    );
    const { octokit } = pagedOctokit(all);
    const d = await clientWith(octokit).getPullRequestDiscussion("o", "r", 1);

    const prior = {
      version: 1 as const,
      head: "aaa",
      at: new Date(0).toISOString(),
      rounds: 1,
      units: [],
      findings: [56, 57, 58].map(finding),
    };
    expect(carriedOpen(prior)).toHaveLength(3);

    const folded = foldReviewLedger({
      prior,
      head: "bbb",
      units: null,
      dispositions: [],
      excerptPresent: () => true, // the quoted code is still there — only the thread says it is done
      threads: d.threads,
      bot: "nearform-lastlight",
    });
    expect(carriedOpen(folded)).toHaveLength(0);
    expect(folded.findings.every((f) => f.status === "resolved")).toBe(true);
  });
});
