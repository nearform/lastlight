import { describe, it, expect, vi } from "vitest";
import {
  discoverPrsAwaitingReview,
  type ReviewDiscoveryClient,
} from "#src/cron/review-discovery.js";

type PrEntry = {
  number: number;
  title: string;
  draft: boolean;
  authorLogin: string;
  headRef?: string;
  headSha?: string;
};

function normalize(p: PrEntry) {
  return {
    number: p.number,
    title: p.title,
    draft: p.draft,
    authorLogin: p.authorLogin,
    labels: [] as string[],
    headRef: p.headRef ?? `feature-${p.number}`,
    headSha: p.headSha ?? `sha-${p.number}`,
  };
}

/** `reviewed` holds `owner/repo#num@headSha` keys the bot has already reviewed. */
function fakeGh(listing: Record<string, PrEntry[]>, reviewed: Set<string>): ReviewDiscoveryClient {
  return {
    listOpenPullRequests: vi.fn(async (owner: string, repo: string) =>
      (listing[`${owner}/${repo}`] ?? []).map(normalize),
    ),
    getLatestBotReview: vi.fn(async (owner: string, repo: string, n: number, headSha: string) =>
      reviewed.has(`${owner}/${repo}#${n}@${headSha}`) ? { state: "COMMENTED" } : null,
    ),
  };
}

describe("discoverPrsAwaitingReview", () => {
  it("returns open, non-draft, non-bot, unreviewed PRs — shaped for dispatch with prNumber + branch", async () => {
    const gh = fakeGh(
      {
        "yo61/repo": [
          { number: 3, title: "Add X", draft: false, authorLogin: "alice", headRef: "feat/x" },
          { number: 4, title: "Draft Y", draft: true, authorLogin: "bob" }, // draft → skip
          { number: 5, title: "Bot chore", draft: false, authorLogin: "last-light[bot]" }, // our own → skip
          { number: 6, title: "Already reviewed", draft: false, authorLogin: "carol" }, // reviewed@head → skip
        ],
      },
      new Set(["yo61/repo#6@sha-6"]),
    );

    const out = await discoverPrsAwaitingReview(["yo61/repo"], gh);
    expect(out).toEqual([{ repo: "yo61/repo", prNumber: 3, title: "Add X", branch: "feat/x" }]);
  });

  it("re-reviews a PR whose latest bot review is on an OLD head SHA (new commits landed)", async () => {
    const gh = fakeGh(
      { "yo61/repo": [{ number: 7, title: "Reworked", draft: false, authorLogin: "dave", headSha: "sha-new" }] },
      new Set(["yo61/repo#7@sha-old"]), // reviewed at an old sha, not the current one
    );
    const out = await discoverPrsAwaitingReview(["yo61/repo"], gh);
    expect(out.map((p) => p.prNumber)).toEqual([7]);
  });

  it("isolates a per-repo listing failure — one bad repo doesn't sink the sweep", async () => {
    const gh: ReviewDiscoveryClient = {
      listOpenPullRequests: vi.fn(async (_owner: string, repo: string) =>
        repo === "bad"
          ? Promise.reject(new Error("boom"))
          : [normalize({ number: 1, title: "ok", draft: false, authorLogin: "alice" })],
      ),
      getLatestBotReview: vi.fn(async () => null),
    };
    const out = await discoverPrsAwaitingReview(["yo61/bad", "yo61/good"], gh, { log: () => {} });
    expect(out.map((p) => p.repo)).toEqual(["yo61/good"]);
  });

  it("honours a custom botLogin for both self-PR skip and prior-review dedup", async () => {
    const gh = fakeGh(
      {
        "yo61/repo": [
          { number: 8, title: "custom bot self PR", draft: false, authorLogin: "nearform-lastlight[bot]" },
          { number: 9, title: "human PR", draft: false, authorLogin: "erin" },
        ],
      },
      new Set(),
    );
    const out = await discoverPrsAwaitingReview(["yo61/repo"], gh, { botLogin: "nearform-lastlight[bot]" });
    expect(out.map((p) => p.prNumber)).toEqual([9]); // the bot's own PR (8) is skipped
  });

  it("caps RUNS dispatched, not candidates examined — reviewed PRs don't starve unreviewed ones behind them", async () => {
    // Steady state: the two oldest open PRs are already reviewed. With
    // maxPerRepo=2 the cap must still surface 2 UNreviewed PRs from behind them,
    // not stop after examining the first 2 (which would yield zero and defer the
    // rest indefinitely).
    const gh = fakeGh(
      {
        "yo61/repo": [
          { number: 1, title: "old reviewed", draft: false, authorLogin: "a" },
          { number: 2, title: "old reviewed", draft: false, authorLogin: "b" },
          { number: 3, title: "unreviewed", draft: false, authorLogin: "c" },
          { number: 4, title: "unreviewed", draft: false, authorLogin: "d" },
          { number: 5, title: "unreviewed", draft: false, authorLogin: "e" },
        ],
      },
      new Set(["yo61/repo#1@sha-1", "yo61/repo#2@sha-2"]),
    );
    const out = await discoverPrsAwaitingReview(["yo61/repo"], gh, { maxPerRepo: 2 });
    expect(out.map((p) => p.prNumber)).toEqual([3, 4]); // 2 dispatched, not starved by 1 & 2
  });
});
