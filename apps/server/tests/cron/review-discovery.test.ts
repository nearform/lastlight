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

function fakeGh(listing: Record<string, PrEntry[]>): ReviewDiscoveryClient {
  return {
    listOpenPullRequests: vi.fn(async (owner: string, repo: string) =>
      (listing[`${owner}/${repo}`] ?? []).map(normalize),
    ),
  };
}

describe("discoverPrsAwaitingReview", () => {
  it("returns every open PR that isn't ours — shaped for dispatch with prNumber + branch", async () => {
    const gh = fakeGh({
      "yo61/repo": [
        { number: 3, title: "Add X", draft: false, authorLogin: "alice", headRef: "feat/x" },
        { number: 5, title: "Bot chore", draft: false, authorLogin: "last-light[bot]" },
      ],
    });

    const out = await discoverPrsAwaitingReview(["yo61/repo"], gh);
    expect(out).toEqual([{ repo: "yo61/repo", prNumber: 3, title: "Add X", branch: "feat/x" }]);
  });

  it("is a CANDIDATE FINDER, not policy — drafts and reviewed PRs are still candidates (09 → S2)", async () => {
    // The draft filter and the per-candidate `getLatestBotReview` call used to
    // live here, which made this a third implementation of `review.trigger`
    // alongside the webhook gate and the comment path's silent bypass. Both are
    // now fields of the ONE `PrState` snapshot `resolveReviewTrigger` decides
    // over at the dispatch choke point — so the sweep offers them and the gate
    // skips them, from exactly the code the webhook route uses.
    const gh = fakeGh({
      "yo61/repo": [
        { number: 3, title: "Add X", draft: false, authorLogin: "alice" },
        { number: 4, title: "Draft Y", draft: true, authorLogin: "bob" },
        { number: 6, title: "Already reviewed at head", draft: false, authorLogin: "carol" },
      ],
    });
    const out = await discoverPrsAwaitingReview(["yo61/repo"], gh);
    expect(out.map((p) => p.prNumber)).toEqual([3, 4, 6]);
    // And it asks GitHub nothing beyond the listing — one call per repo, no
    // per-candidate review lookup. The client surface is the proof.
    expect(gh.listOpenPullRequests).toHaveBeenCalledTimes(1);
    expect(Object.keys(gh)).toEqual(["listOpenPullRequests"]);
  });

  it("isolates a per-repo listing failure — one bad repo doesn't sink the sweep", async () => {
    const gh: ReviewDiscoveryClient = {
      listOpenPullRequests: vi.fn(async (_owner: string, repo: string) =>
        repo === "bad"
          ? Promise.reject(new Error("boom"))
          : [normalize({ number: 1, title: "ok", draft: false, authorLogin: "alice" })],
      ),
    };
    const out = await discoverPrsAwaitingReview(["yo61/bad", "yo61/good"], gh, { log: () => {} });
    expect(out.map((p) => p.repo)).toEqual(["yo61/good"]);
  });

  it("honours a custom botLogin for the self-PR skip", async () => {
    const gh = fakeGh({
      "yo61/repo": [
        { number: 8, title: "custom bot self PR", draft: false, authorLogin: "nearform-lastlight[bot]" },
        { number: 9, title: "human PR", draft: false, authorLogin: "erin" },
      ],
    });
    const out = await discoverPrsAwaitingReview(["yo61/repo"], gh, {
      botLogin: "nearform-lastlight[bot]",
    });
    expect(out.map((p) => p.prNumber)).toEqual([9]);
  });

  it("caps candidates per repo, oldest first, so one busy repo can't spin hundreds of dispatches", async () => {
    const gh = fakeGh({
      "yo61/repo": [
        { number: 5, title: "e", draft: false, authorLogin: "e" },
        { number: 1, title: "a", draft: false, authorLogin: "a" },
        { number: 3, title: "c", draft: false, authorLogin: "c" },
      ],
    });
    const out = await discoverPrsAwaitingReview(["yo61/repo"], gh, { maxPerRepo: 2 });
    expect(out.map((p) => p.prNumber)).toEqual([1, 3]);
  });
});
