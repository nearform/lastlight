import { describe, it, expect } from "vitest";
import { isRereview, openBotThreads } from "#src/workflows/handlers/post-review.js";
import type { PrDiscussionRead } from "#src/engine/github/github.js";

/**
 * What a clean re-review may claim (PR #427 review). "Thanks for the updates"
 * needs a head the author moved; "good to merge" needs no earlier point of
 * ours still open — including one no site re-found this round.
 */

describe("isRereview", () => {
  it("is a re-review only when our last review was of a different head", () => {
    expect(isRereview({ sha: "aaa" }, "bbb")).toBe(true);
    // `@bot review` on the head we already reviewed — nothing was pushed.
    expect(isRereview({ sha: "bbb" }, "bbb")).toBe(false);
    expect(isRereview(null, "bbb")).toBe(false);
    expect(isRereview({ sha: "aaa" }, undefined)).toBe(false);
  });
});

describe("openBotThreads", () => {
  const thread = (over: Partial<PrDiscussionRead["threads"][number]>, author = "nearform-lastlight", isBot = true) => ({
    path: "a.ts",
    line: 3,
    isResolved: false,
    isOutdated: false,
    comments: [{ author, isBot, body: "finding" }],
    ...over,
  });
  const client = (threads: PrDiscussionRead["threads"], threadsTruncated = false) => ({
    getPullRequestDiscussion: async () => ({ reviews: [], comments: [], threads, threadsTruncated }),
  });
  const open = (threads: PrDiscussionRead["threads"], truncated = false) =>
    openBotThreads(client(threads, truncated), "o", "r", 1, "nearform-lastlight[bot]");

  it("counts our unresolved thread on unchanged code", async () => {
    expect(await open([thread({})])).toBe(true);
  });

  it("ignores a resolved or outdated thread, and one another author opened", async () => {
    expect(await open([thread({ isResolved: true }), thread({ isOutdated: true })])).toBe(false);
    expect(await open([thread({}, "alice", false), thread({}, "other-bot", true)])).toBe(false);
  });

  it("counts a truncated read as open — the threads past the page are unknown, not closed", async () => {
    expect(await open([thread({ isResolved: true })], true)).toBe(true);
    expect(await open([thread({ isResolved: true })], false)).toBe(false);
  });

  it("counts a failed read as open — the claim that needs evidence is withheld", async () => {
    const failing = { getPullRequestDiscussion: async (): Promise<PrDiscussionRead> => { throw new Error("502"); } };
    expect(await openBotThreads(failing, "o", "r", 1, "nearform-lastlight[bot]")).toBe(true);
  });
});
