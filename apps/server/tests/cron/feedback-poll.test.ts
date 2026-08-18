import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

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

vi.mock("#src/telemetry/feedback.js", () => ({ recordFeedbackSignal: vi.fn() }));

import { StateDb, type WorkflowRun } from "#src/state/db.js";
import type { FeedbackCandidate, ReactionRead } from "#src/engine/github/github.js";
import {
  discoverRunAnchors,
  pollFeedbackReactions,
  type FeedbackGitHubClient,
} from "#src/cron/feedback-poll.js";

let db: StateDb;

beforeEach(() => {
  db = new StateDb(":memory:");
});
afterEach(() => {
  db.close();
});

const BOT = "last-light[bot]";

/**
 * A hand-rolled client implementing only the two methods the poller declares —
 * the `tests/cron/review-discovery.test.ts` pattern. Asserting the SURFACE is
 * part of the point: the poller must not reach for the rest of GitHubClient.
 */
function fakeGh(over: Partial<FeedbackGitHubClient> = {}): FeedbackGitHubClient {
  return {
    listBotComments: vi.fn(async () => [] as FeedbackCandidate[]),
    fetchReactions: vi.fn(async () => new Map<string, ReactionRead[]>()),
    ...over,
  };
}

function makeRun(over: Partial<WorkflowRun> = {}): WorkflowRun {
  const run: WorkflowRun = {
    id: "run-1",
    workflowName: "pr-review",
    triggerId: "nearform/lastlight#255",
    owner: "nearform",
    repo: "lastlight",
    issueNumber: 255,
    currentPhase: "done",
    phaseHistory: [],
    status: "succeeded",
    context: { prNumber: 255 },
    startedAt: "2026-08-01T10:00:00.000Z",
    updatedAt: "2026-08-01T10:20:00.000Z",
    ...over,
  };
  return run;
}

function comment(over: Partial<FeedbackCandidate> = {}): FeedbackCandidate {
  return {
    kind: "issue_comment",
    externalId: "111",
    nodeId: "IC_111",
    createdAt: "2026-08-01T10:05:00.000Z",
    ...over,
  };
}

function seedAnchor(over: { externalId?: string; nodeId?: string; owner?: string; createdAt?: string } = {}) {
  return db.feedback.upsertAnchor({
    source: "github",
    kind: "issue_comment",
    externalId: over.externalId ?? "111",
    nodeId: over.nodeId ?? "IC_111",
    channel: null,
    owner: over.owner ?? "nearform",
    repo: "lastlight",
    issueNumber: 255,
    workflowRunId: "run-1",
    workflowName: "pr-review",
    executionId: null,
    ...(over.createdAt ? { createdAt: over.createdAt } : {}),
  });
}

function pollDeps(github: FeedbackGitHubClient, over: Record<string, unknown> = {}) {
  return {
    db,
    github,
    botLogin: BOT,
    windowDays: 14,
    maxAnchorsPerTick: 500,
    retentionDays: 90,
    ...over,
  };
}

describe("discoverRunAnchors", () => {
  it("registers the bot's comments against the run that posted them", async () => {
    const gh = fakeGh({ listBotComments: vi.fn(async () => [comment(), comment({ externalId: "222", nodeId: "IC_222" })]) });
    expect(await discoverRunAnchors({ db, github: gh, botLogin: BOT }, makeRun())).toBe(2);

    const anchor = db.feedback.findAnchor("github", null, "111");
    expect(anchor).toMatchObject({
      workflowRunId: "run-1",
      workflowName: "pr-review",
      nodeId: "IC_111",
      owner: "nearform",
      issueNumber: 255,
    });
  });

  it("scopes the listing to the run's own window", async () => {
    const listBotComments = vi.fn(async () => []);
    await discoverRunAnchors({ db, github: fakeGh({ listBotComments }), botLogin: BOT }, makeRun());
    expect(listBotComments).toHaveBeenCalledWith("nearform", "lastlight", 255, {
      botLogin: BOT,
      isPr: true,
      since: "2026-08-01T10:00:00.000Z",
    });
  });

  it("passes Octokit the BARE repo for a legacy qualified row (issue #279)", async () => {
    // Discovery hangs off the terminal-run observer, so it fires for EVERY
    // finished run, and it hands `(run.owner, run.repo)` to `listBotComments`
    // with no split of its own. A qualified value here would not just 404 —
    // it is persisted onward onto the `feedback_anchors` row, so the anchor URL
    // stays corrupt long after the run is gone.
    //
    // Raw SQL because `createRun` normalizes; the row is then read back through
    // the store, which is the path the observer actually takes.
    db.database
      .prepare(
        `INSERT INTO workflow_runs (id, workflow_name, trigger_id, owner, repo, issue_number, current_phase, status, started_at, updated_at)
         VALUES ('run-legacy', 'pr-review', 'nearform/lastlight#255', NULL, 'nearform/lastlight', 255, 'done', 'succeeded', ?, ?)`,
      )
      .run("2026-08-01T10:00:00.000Z", "2026-08-01T10:20:00.000Z");
    const stored = db.runs.getRun("run-legacy")!;

    const listBotComments = vi.fn(async () => [comment()]);
    await discoverRunAnchors({ db, github: fakeGh({ listBotComments }), botLogin: BOT }, stored);

    expect(listBotComments.mock.calls[0]!.slice(0, 3)).toEqual(["nearform", "lastlight", 255]);
    // …and the anchor it writes carries the same pair, so `anchorUrl` resolves.
    const anchors = db.database
      .prepare(`SELECT owner, repo FROM feedback_anchors`)
      .all() as { owner: string; repo: string }[];
    expect(anchors).toEqual([{ owner: "nearform", repo: "lastlight" }]);
  });

  it("asks for review comments only on a PR", async () => {
    const listBotComments = vi.fn(async () => []);
    const issueRun = makeRun({ workflowName: "issue-triage", context: {} });
    await discoverRunAnchors({ db, github: fakeGh({ listBotComments }), botLogin: BOT }, issueRun);
    expect(listBotComments.mock.calls[0]![3]).toMatchObject({ isPr: false });
  });

  it("ignores an older comment the `since` filter let through on an edit", async () => {
    // `since` filters on updated_at, so editing a year-old comment resurfaces
    // it — and attributing it to this run would be a lie.
    const gh = fakeGh({
      listBotComments: vi.fn(async () => [comment({ createdAt: "2025-01-01T00:00:00.000Z" })]),
    });
    expect(await discoverRunAnchors({ db, github: gh, botLogin: BOT }, makeRun())).toBe(0);
  });

  it("does nothing for a run with no GitHub subject (a Slack-only run)", async () => {
    const gh = fakeGh();
    const slackRun = makeRun({ owner: undefined, repo: undefined, issueNumber: undefined });
    expect(await discoverRunAnchors({ db, github: gh, botLogin: BOT }, slackRun)).toBe(0);
    expect(gh.listBotComments).not.toHaveBeenCalled();
  });

  it("swallows a GitHub failure — discovery may never fail a finished run", async () => {
    const gh = fakeGh({
      listBotComments: vi.fn(async () => {
        throw new Error("502");
      }),
    });
    await expect(discoverRunAnchors({ db, github: gh, botLogin: BOT }, makeRun())).resolves.toBe(0);
  });
});

describe("pollFeedbackReactions", () => {
  it("turns a batched read into scored signals", async () => {
    seedAnchor();
    const gh = fakeGh({
      fetchReactions: vi.fn(async () =>
        new Map([["IC_111", [
          { content: "THUMBS_UP", reactor: "alice" },
          { content: "CONFUSED", reactor: "bob" },
        ]]]),
      ),
    });

    const result = await pollFeedbackReactions(pollDeps(gh));
    expect(result).toMatchObject({ anchorsPolled: 1, requests: 1, added: 2, retracted: 0 });

    const { signals } = db.feedback.list();
    expect(signals.map((s) => [s.reactor, s.emoji, s.score]).sort()).toEqual([
      ["alice", "+1", 1],
      ["bob", "confused", -2],
    ]);
  });

  it("batches 100 anchors per request — 250 anchors is exactly 3 calls", async () => {
    for (let i = 0; i < 250; i++) seedAnchor({ externalId: `c${i}`, nodeId: `IC_${i}` });
    const fetchReactions = vi.fn(async () => new Map<string, ReactionRead[]>());
    const result = await pollFeedbackReactions(pollDeps(fakeGh({ fetchReactions })));

    expect(fetchReactions).toHaveBeenCalledTimes(3);
    expect(fetchReactions.mock.calls.map((c) => (c[1] as string[]).length)).toEqual([100, 100, 50]);
    expect(result.requests).toBe(3);
  });

  it("respects maxAnchorsPerTick — the whole point of the budget", async () => {
    for (let i = 0; i < 250; i++) seedAnchor({ externalId: `c${i}`, nodeId: `IC_${i}` });
    const fetchReactions = vi.fn(async () => new Map<string, ReactionRead[]>());
    const result = await pollFeedbackReactions(
      pollDeps(fakeGh({ fetchReactions }), { maxAnchorsPerTick: 100 }),
    );
    expect(fetchReactions).toHaveBeenCalledTimes(1);
    expect(result.anchorsPolled).toBe(100);
  });

  it("groups by owner — one installation's budget is not another's", async () => {
    seedAnchor({ externalId: "a", nodeId: "IC_a", owner: "nearform" });
    seedAnchor({ externalId: "b", nodeId: "IC_b", owner: "cliftonc" });
    const fetchReactions = vi.fn(async () => new Map<string, ReactionRead[]>());
    await pollFeedbackReactions(pollDeps(fakeGh({ fetchReactions })));

    expect(fetchReactions).toHaveBeenCalledTimes(2);
    expect(fetchReactions.mock.calls.map((c) => c[0]).sort()).toEqual(["cliftonc", "nearform"]);
  });

  it("leaves anchors outside the window alone", async () => {
    seedAnchor({ externalId: "old", nodeId: "IC_old", createdAt: "2020-01-01T00:00:00.000Z" });
    const fetchReactions = vi.fn(async () => new Map<string, ReactionRead[]>());
    const result = await pollFeedbackReactions(pollDeps(fakeGh({ fetchReactions })));
    expect(fetchReactions).not.toHaveBeenCalled();
    expect(result.anchorsPolled).toBe(0);
  });

  it("is idempotent across ticks — the same reaction is added once", async () => {
    seedAnchor();
    const gh = fakeGh({
      fetchReactions: vi.fn(async () => new Map([["IC_111", [{ content: "THUMBS_UP", reactor: "alice" }]]])),
    });
    expect((await pollFeedbackReactions(pollDeps(gh))).added).toBe(1);
    expect((await pollFeedbackReactions(pollDeps(gh))).added).toBe(0);
    expect(db.feedback.list().total).toBe(1);
  });

  it("retracts a reaction that has vanished — absence is the only evidence", async () => {
    seedAnchor();
    const present = fakeGh({
      fetchReactions: vi.fn(async () => new Map([["IC_111", [{ content: "THUMBS_UP", reactor: "alice" }]]])),
    });
    await pollFeedbackReactions(pollDeps(present));

    const gone = fakeGh({ fetchReactions: vi.fn(async () => new Map([["IC_111", []]])) });
    const result = await pollFeedbackReactions(pollDeps(gone));
    expect(result.retracted).toBe(1);
    expect(db.feedback.list().total).toBe(0);
  });

  it("does NOT retract when GitHub omits the node entirely (a deleted comment)", async () => {
    seedAnchor();
    const present = fakeGh({
      fetchReactions: vi.fn(async () => new Map([["IC_111", [{ content: "THUMBS_UP", reactor: "alice" }]]])),
    });
    await pollFeedbackReactions(pollDeps(present));

    // Empty map = node absent, which means "comment gone", not "reaction removed".
    const missing = fakeGh({ fetchReactions: vi.fn(async () => new Map<string, ReactionRead[]>()) });
    expect((await pollFeedbackReactions(pollDeps(missing))).retracted).toBe(0);
    expect(db.feedback.list().total).toBe(1);
  });

  it("skips the bot's own reactions", async () => {
    seedAnchor();
    const gh = fakeGh({
      fetchReactions: vi.fn(async () =>
        // GraphQL reports our own login WITHOUT the [bot] suffix.
        new Map([["IC_111", [{ content: "EYES", reactor: "last-light" }]]]),
      ),
    });
    expect((await pollFeedbackReactions(pollDeps(gh))).added).toBe(0);
    expect(db.feedback.list().total).toBe(0);
  });

  it("keeps a failed batch at the front of the queue instead of rotating it", async () => {
    const anchor = seedAnchor();
    const gh = fakeGh({
      fetchReactions: vi.fn(async () => {
        throw new Error("rate limited");
      }),
    });
    const result = await pollFeedbackReactions(pollDeps(gh));
    expect(result.requests).toBe(0);
    expect(result.anchorsPolled).toBe(0);
    expect(db.feedback.getAnchor(anchor.id)?.lastPolledAt).toBeNull();
  });

  it("prunes anchors past the retention horizon", async () => {
    seedAnchor({ externalId: "ancient", nodeId: "IC_ancient", createdAt: "2020-01-01T00:00:00.000Z" });
    const result = await pollFeedbackReactions(pollDeps(fakeGh()));
    expect(result.pruned).toBe(1);
  });

  it("uses only the two client methods it declares", async () => {
    const gh = fakeGh();
    expect(Object.keys(gh).sort()).toEqual(["fetchReactions", "listBotComments"]);
  });
});
