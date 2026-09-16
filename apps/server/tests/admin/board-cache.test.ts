/**
 * `board-cache.ts` — the three properties that keep a 20 s browser poll off
 * GitHub's rate limit.
 *
 * The TTL, the single flight and degrade-to-last-good are not conveniences
 * here: without them the board is the exact shape the plan refuses to ship (per
 * repo, per poll, per open tab). So each gets a named test, and the fake client
 * COUNTS its calls — the assertion that matters is how many requests happened,
 * not what came back.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  boardRevision,
  getBoardItems,
  invalidateBoard,
  resetBoardCacheForTests,
  BOARD_TTL_MS,
} from "#src/admin/board-cache.js";
import type { GitHubClient, BoardItem, BoardRepoItems } from "#src/engine/github/github.js";

const OWNER = "acme";

function boardItem(repo: string, number: number): BoardItem {
  return {
    repo,
    number,
    title: `Item ${number}`,
    url: `https://github.com/${repo}/issues/${number}`,
    author: "maintainer",
    createdAt: "2026-09-01T00:00:00.000Z",
    updatedAt: "2026-09-01T00:00:00.000Z",
    linkedPrs: [],
    labels: [{ name: "ready-for-agent", color: "ededed" }],
  };
}

/** A client that records every call and can be made slow, failing or throttled. */
function fakeGithub(
  answer: (owner: string, repos: string[]) => Promise<Map<string, BoardRepoItems>>,
) {
  const listOpenBoardItems = vi.fn(answer);
  return { client: { listOpenBoardItems } as unknown as GitHubClient, listOpenBoardItems };
}

/** The happy path: one item per repo. */
const ok = async (owner: string, repos: string[]) =>
  new Map<string, BoardRepoItems>(
    repos.map((repo) => [`${owner}/${repo}`, { items: [boardItem(`${owner}/${repo}`, 1)] }]),
  );

beforeEach(() => {
  resetBoardCacheForTests();
  vi.useRealTimers();
});

describe("board cache", () => {
  it("serves a second read inside the TTL without touching GitHub", async () => {
    const { client, listOpenBoardItems } = fakeGithub(ok);

    const first = await getBoardItems([`${OWNER}/widget`], { github: client });
    const second = await getBoardItems([`${OWNER}/widget`], { github: client });

    expect(first.items).toHaveLength(1);
    expect(second.items).toHaveLength(1);
    expect(listOpenBoardItems).toHaveBeenCalledTimes(1);
  });

  it("batches one document per owner, not one per repo", async () => {
    const { client, listOpenBoardItems } = fakeGithub(ok);

    await getBoardItems([`${OWNER}/a`, `${OWNER}/b`, `other/c`], { github: client });

    expect(listOpenBoardItems).toHaveBeenCalledTimes(2);
    expect(listOpenBoardItems.mock.calls[0]).toEqual([OWNER, ["a", "b"]]);
  });

  it("single-flights concurrent callers — N dashboards cost ONE fetch", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { client, listOpenBoardItems } = fakeGithub(async (owner, repos) => {
      await gate;
      return ok(owner, repos);
    });

    const a = getBoardItems([`${OWNER}/widget`], { github: client });
    const b = getBoardItems([`${OWNER}/widget`], { github: client });
    release();
    const [first, second] = await Promise.all([a, b]);

    expect(listOpenBoardItems).toHaveBeenCalledTimes(1);
    expect(first.items).toHaveLength(1);
    expect(second.items).toHaveLength(1);
  });

  it("serves the cached answer immediately while the refresh runs behind it", async () => {
    vi.useFakeTimers();
    let slow = false;
    const { client, listOpenBoardItems } = fakeGithub(async (owner, repos) => {
      if (slow) await new Promise((resolve) => setTimeout(resolve, 60_000));
      return ok(owner, repos);
    });

    await getBoardItems([`${OWNER}/widget`], { github: client });
    vi.setSystemTime(Date.now() + BOARD_TTL_MS + 1);
    slow = true;

    // The refresh is in flight and will not settle for a minute. The read must
    // still come back now, with the last good items.
    const stale = await getBoardItems([`${OWNER}/widget`], { github: client });

    expect(stale.items).toHaveLength(1);
    expect(stale.degraded).toEqual([]);
    expect(listOpenBoardItems).toHaveBeenCalledTimes(2);
    await vi.runAllTimersAsync();
  });

  it("degrades to the last good items and reports the repo, rather than throwing", async () => {
    vi.useFakeTimers();
    let broken = false;
    const { client } = fakeGithub(async (owner, repos) => {
      if (broken) throw new Error("installation revoked");
      return ok(owner, repos);
    });

    await getBoardItems([`${OWNER}/widget`], { github: client });
    broken = true;
    vi.setSystemTime(Date.now() + BOARD_TTL_MS + 1);
    // Forced so the read waits on the failing fetch rather than racing it.
    invalidateBoard(`${OWNER}/widget`);
    const after = await getBoardItems([`${OWNER}/widget`], { github: client });

    expect(after.degraded).toHaveLength(1);
    expect(after.degraded[0]!.error).toContain("installation revoked");
    // A repo we have never fetched has nothing to serve, and says so.
    expect(after.items).toHaveLength(0);
  });

  it("reports a per-repo error as degraded without failing its neighbours", async () => {
    const { client } = fakeGithub(async (owner, repos) => {
      const out = new Map<string, BoardRepoItems>();
      for (const repo of repos) {
        out.set(
          `${owner}/${repo}`,
          repo === "broken"
            ? { items: [], error: "404 Not Found" }
            : { items: [boardItem(`${owner}/${repo}`, 1)] },
        );
      }
      return out;
    });

    const result = await getBoardItems([`${OWNER}/widget`, `${OWNER}/broken`], { github: client });

    expect(result.items).toHaveLength(1);
    expect(result.degraded).toEqual([
      expect.objectContaining({ repo: `${OWNER}/broken`, error: "404 Not Found" }),
    ]);
  });

  it("backs an owner off after a throttle instead of retrying on the next poll", async () => {
    vi.useFakeTimers();
    const { client, listOpenBoardItems } = fakeGithub(async (owner, repos) =>
      new Map<string, BoardRepoItems>(
        repos.map((repo) => [
          `${owner}/${repo}`,
          { items: [boardItem(`${owner}/${repo}`, 1)], error: "secondary rate limit", fallback: true, throttled: true },
        ]),
      ),
    );

    await getBoardItems([`${OWNER}/widget`], { github: client });
    vi.setSystemTime(Date.now() + BOARD_TTL_MS + 1);
    const second = await getBoardItems([`${OWNER}/widget`], { github: client });

    // The TTL has expired, but the owner is backing off — no second request.
    expect(listOpenBoardItems).toHaveBeenCalledTimes(1);
    // And the fallback data is still served, marked degraded.
    expect(second.items).toHaveLength(1);
    expect(second.degraded[0]!.error).toContain("secondary rate limit");
  });

  it("makes a FAILED repo wait out the TTL rather than re-requesting on every poll", async () => {
    const { client, listOpenBoardItems } = fakeGithub(async (owner, repos) =>
      new Map<string, BoardRepoItems>(
        repos.map((repo) => [`${owner}/${repo}`, { items: [], error: "404 Not Found" }]),
      ),
    );

    await getBoardItems([`${OWNER}/gone`], { github: client });
    await getBoardItems([`${OWNER}/gone`], { github: client });

    // A repo that is never going to answer must not cost its owner's whole
    // batch six times per TTL window.
    expect(listOpenBoardItems).toHaveBeenCalledTimes(1);
  });

  it("invalidateBoard sends the next read straight back to GitHub", async () => {
    const { client, listOpenBoardItems } = fakeGithub(ok);

    await getBoardItems([`${OWNER}/widget`], { github: client });
    invalidateBoard(`${OWNER}/widget`);
    await getBoardItems([`${OWNER}/widget`], { github: client });

    expect(listOpenBoardItems).toHaveBeenCalledTimes(2);
  });
});

// ── The change signal ───────────────────────────────────────────────────────

/**
 * `boardRevision` is what the SSE stream folds into its signature, so the rule
 * it has to keep is narrow: move when the board's CONTENT changes, and not
 * otherwise. A push that carries no news is just a poll with extra steps — and
 * since every board-relevant webhook invalidates, a revision that moved on
 * invalidation would push twice per delivery and wake every open tab for
 * labels nothing on the board renders.
 */
describe("boardRevision", () => {
  const REPO = `${OWNER}/repo-a`;

  /** The same item, wearing a different stage label — the card changes column. */
  const moved = async () =>
    new Map<string, BoardRepoItems>([
      [
        REPO,
        {
          items: [
            { ...boardItem(REPO, 1), labels: [{ name: "agent-building", color: "ededed" }] },
          ],
        },
      ],
    ]);

  it("moves when a refresh returns a different board", async () => {
    const { client, listOpenBoardItems } = fakeGithub(ok);
    await getBoardItems([REPO], { github: client });
    const afterFirstRead = boardRevision();

    invalidateBoard(REPO);
    listOpenBoardItems.mockImplementationOnce(moved);
    await getBoardItems([REPO], { github: client });

    expect(boardRevision()).toBe(afterFirstRead + 1);
  });

  it("stays put when a refresh returns exactly the same board", async () => {
    // The COMMON case, and the one that decides whether this is push-on-change
    // or a broadcast every time anything is invalidated.
    const { client } = fakeGithub(ok);
    await getBoardItems([REPO], { github: client });
    const afterFirstRead = boardRevision();

    invalidateBoard(REPO);
    await getBoardItems([REPO], { github: client });

    expect(boardRevision()).toBe(afterFirstRead);
  });

  it("does not move on invalidation itself — that is not a claim about content", async () => {
    const { client } = fakeGithub(ok);
    await getBoardItems([REPO], { github: client });
    const afterFirstRead = boardRevision();

    invalidateBoard(REPO);
    invalidateBoard(`${OWNER}/never-read`);
    invalidateBoard();

    expect(boardRevision()).toBe(afterFirstRead);
  });

  it("moves once when a repo goes degraded, not on every failed retry", async () => {
    const { client } = fakeGithub(async () => {
      throw new Error("no installation for this owner");
    });
    await getBoardItems([REPO], { github: client });
    const afterFirstFailure = boardRevision();

    invalidateBoard(REPO);
    await getBoardItems([REPO], { github: client });

    expect(boardRevision()).toBe(afterFirstFailure);
  });
});
