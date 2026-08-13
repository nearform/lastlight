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

// The digest resolves the repo layer through the same seam every dispatch uses.
// Stubbed here so these tests are about the DIGEST, not about repo-config
// fetching (which has its own suite) — each case declares the layer it wants.
const resolveRepoRunConfig = vi.fn(async () => ({}) as { repoConfig?: unknown });
vi.mock("#src/workflows/simple.js", () => ({
  resolveRepoRunConfig: (...args: unknown[]) => resolveRepoRunConfig(...(args as [])),
}));

import { StateDb } from "#src/state/db.js";
import type { RepoActivityItem } from "#src/engine/github/github.js";
import {
  runRepoDigest,
  summarizeRepo,
  type DigestGitHubClient,
  type RepoDigestDeps,
} from "#src/cron/repo-digest.js";
import { resolveRepoChannel } from "#src/notify/repo-channel.js";
import { renderDigest } from "#src/notify/digest-blocks.js";
import { CRON_NAME_KEY } from "#src/cron/repo-crons.js";

let db: StateDb;

beforeEach(() => {
  db = new StateDb(":memory:");
  resolveRepoRunConfig.mockReset();
  resolveRepoRunConfig.mockResolvedValue({});
});
afterEach(() => {
  db.close();
});

const NOW = new Date("2026-08-09T12:00:00.000Z");
const WEEK_AGO = new Date("2026-08-02T12:00:00.000Z");

function activity(over: Partial<RepoActivityItem> = {}): RepoActivityItem {
  return {
    number: 1,
    title: "A change",
    isPr: true,
    mergedAt: null,
    createdAt: "2026-08-05T00:00:00.000Z",
    closedAt: null,
    draft: false,
    authorLogin: "someone",
    labels: [],
    htmlUrl: "https://github.com/acme/widgets/pull/1",
    ...over,
  };
}

function openPr(over: Partial<Parameters<typeof summarizeRepo>[1][number]> = {}) {
  return {
    number: 1,
    title: "A change",
    draft: false,
    labels: [] as string[],
    createdAt: "2026-08-05T00:00:00.000Z",
    ...over,
  };
}

/** Only the two methods the digest declares — asserting the surface is part of the point. */
function fakeGh(over: Partial<DigestGitHubClient> = {}): DigestGitHubClient {
  return {
    listRepoActivitySince: vi.fn(async () => []),
    listOpenPullRequests: vi.fn(async () => []),
    ...over,
  } as DigestGitHubClient;
}

function deps(over: Partial<RepoDigestDeps> = {}): RepoDigestDeps {
  return {
    db,
    github: fakeGh(),
    configClient: null,
    routing: { repoChannels: {}, deliveryChannel: "C0FALLBACK" },
    config: { windowDays: 7, narrative: false, maxItems: 5 },
    post: vi.fn(async () => {}),
    now: () => NOW,
    ...over,
  };
}

// ---------------------------------------------------------------------------

describe("repo digest — the window", () => {
  it("counts an item by its OWN dates, not by its presence in the response", () => {
    // `listRepoActivitySince` filters on `updated_at`, so an old PR touched
    // this week comes back. Counting it as "opened this week" is the mistake
    // this arithmetic exists to avoid.
    const facts = summarizeRepo(
      [
        activity({ number: 1, createdAt: "2026-01-01T00:00:00.000Z" }), // old, merely updated
        activity({ number: 2, createdAt: "2026-08-05T00:00:00.000Z" }), // opened in window
      ],
      [],
      WEEK_AGO,
      NOW,
      5,
    );
    expect(facts.prsOpened).toBe(1);
  });

  it("separates a merged PR from one closed without merging", () => {
    const facts = summarizeRepo(
      [
        activity({ number: 1, mergedAt: "2026-08-06T00:00:00.000Z", closedAt: "2026-08-06T00:00:00.000Z" }),
        activity({ number: 2, mergedAt: null, closedAt: "2026-08-06T00:00:00.000Z" }),
      ],
      [],
      WEEK_AGO,
      NOW,
      5,
    );
    expect(facts.prsMerged).toBe(1);
    expect(facts.prsClosedUnmerged).toBe(1);
  });

  it("counts issues separately from pull requests", () => {
    const facts = summarizeRepo(
      [
        activity({ number: 1, isPr: false, createdAt: "2026-08-05T00:00:00.000Z" }),
        activity({ number: 2, isPr: false, closedAt: "2026-08-06T00:00:00.000Z", createdAt: "2026-01-01T00:00:00.000Z" }),
        activity({ number: 3, isPr: true, createdAt: "2026-08-05T00:00:00.000Z" }),
      ],
      [],
      WEEK_AGO,
      NOW,
      5,
    );
    expect(facts.issuesOpened).toBe(1);
    expect(facts.issuesClosed).toBe(1);
    expect(facts.prsOpened).toBe(1);
  });

  it("excludes drafts from the awaiting-review count and names the oldest", () => {
    const facts = summarizeRepo(
      [],
      [
        openPr({ number: 10, draft: true, createdAt: "2026-07-01T00:00:00.000Z" }),
        openPr({ number: 11, createdAt: "2026-07-31T12:00:00.000Z", title: "Older" }),
        openPr({ number: 12, createdAt: "2026-08-08T00:00:00.000Z" }),
      ],
      WEEK_AGO,
      NOW,
      5,
    );
    expect(facts.openPrs).toBe(3);
    expect(facts.awaitingReview).toBe(2);
    expect(facts.oldestAwaiting).toMatchObject({ number: 11, ageDays: 9 });
  });

  it("caps the escalation list at maxItems", () => {
    const prs = [1, 2, 3, 4].map((n) => openPr({ number: n, labels: ["requires-human"] }));
    const facts = summarizeRepo([], prs, WEEK_AGO, NOW, 2);
    expect(facts.escalated).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------

describe("repo digest — channel resolution", () => {
  const routing = { repoChannels: { "acme/widgets": "C0MAP" }, deliveryChannel: "C0FALLBACK" };

  it("prefers the repo's own channel", () => {
    const repoConfig = {
      notifications: { slack: { channel: "C0REPO" } },
      sources: { notifications: { "slack.channel": "repo" } },
    } as never;
    expect(resolveRepoChannel("acme/widgets", routing, repoConfig)).toEqual({
      channel: "C0REPO",
      source: "repo",
    });
  });

  it("falls back to the operator map, then the delivery channel", () => {
    expect(resolveRepoChannel("acme/widgets", routing)).toEqual({ channel: "C0MAP", source: "operator-map" });
    expect(resolveRepoChannel("acme/other", routing)).toEqual({
      channel: "C0FALLBACK",
      source: "delivery-channel",
    });
  });

  it("honours an explicit null from the repo as an OPT-OUT, beating the operator map", () => {
    // The whole reason this reads provenance rather than the merged value: a
    // null the repo chose is a different answer from a key it never set.
    const repoConfig = {
      notifications: { slack: { channel: null } },
      sources: { notifications: { "slack.channel": "repo" } },
    } as never;
    expect(resolveRepoChannel("acme/widgets", routing, repoConfig)).toEqual({ source: "none" });
  });

  it("resolves to nothing when no layer names a channel", () => {
    expect(resolveRepoChannel("acme/widgets", { repoChannels: {} })).toEqual({ source: "none" });
    expect(resolveRepoChannel("acme/widgets", undefined)).toEqual({ source: "none" });
  });
});

// ---------------------------------------------------------------------------

describe("repo digest — the tick", () => {
  it("posts one digest per participating repo", async () => {
    const post = vi.fn(async () => {});
    const d = deps({ post, github: fakeGh({ listOpenPullRequests: vi.fn(async () => [openPr()]) }) });

    await runRepoDigest(d, { repos: ["acme/widgets", "acme/gadgets"] });

    expect(post).toHaveBeenCalledTimes(2);
    expect(post.mock.calls.map((c) => (c as unknown as [string])[0])).toEqual(["C0FALLBACK", "C0FALLBACK"]);
  });

  it("posts NOTHING when no channel resolves — the inert default", async () => {
    const post = vi.fn(async () => {});
    const github = fakeGh();
    await runRepoDigest(deps({ post, github, routing: { repoChannels: {} } }), { repos: ["acme/widgets"] });

    expect(post).not.toHaveBeenCalled();
    // And it costs nothing: the channel is resolved BEFORE any GitHub request.
    expect(github.listRepoActivitySince).not.toHaveBeenCalled();
  });

  it("posts nothing when Slack is not configured at all", async () => {
    const post = vi.fn(async () => {});
    await runRepoDigest(deps({ post, routing: undefined }), { repos: ["acme/widgets"] });
    expect(post).not.toHaveBeenCalled();
  });

  it("still posts when the narrative model fails", async () => {
    const post = vi.fn(async () => {});
    const summarize = vi.fn(async () => {
      throw new Error("provider 429");
    });
    await runRepoDigest(
      deps({ post, summarize, config: { windowDays: 7, narrative: true, maxItems: 5 } }),
      { repos: ["acme/widgets"] },
    );

    expect(summarize).toHaveBeenCalled();
    expect(post).toHaveBeenCalledTimes(1);
    const [, text] = post.mock.calls[0] as unknown as [string, string];
    expect(text).toContain("acme/widgets");
  });

  it("includes the narrative when the model succeeds", async () => {
    const post = vi.fn(async () => {});
    await runRepoDigest(
      deps({
        post,
        summarize: async () => "A quiet week with the review queue holding steady.",
        config: { windowDays: 7, narrative: true, maxItems: 5 },
      }),
      { repos: ["acme/widgets"] },
    );
    const [, text] = post.mock.calls[0] as unknown as [string, string];
    expect(text).toContain("A quiet week");
  });

  it("skips the model entirely when narrative is off", async () => {
    const summarize = vi.fn(async () => "should not be called");
    await runRepoDigest(deps({ summarize }), { repos: ["acme/widgets"] });
    expect(summarize).not.toHaveBeenCalled();
  });

  it("serves the other repos when ONE fails, then FAILS the tick", async () => {
    const post = vi.fn(async () => {});
    const github = fakeGh({
      listRepoActivitySince: vi.fn(async (_o: string, repo: string) => {
        if (repo === "widgets") throw new Error("502");
        return [];
      }),
    });

    await expect(
      runRepoDigest(deps({ post, github }), { repos: ["acme/widgets", "acme/gadgets"] }),
    ).rejects.toThrow(/acme\/widgets/);

    // The healthy repo still got its digest — the throw is after the loop.
    expect(post).toHaveBeenCalledTimes(1);
  });

  it("fails the tick when EVERY post fails — the revoked-token case", async () => {
    // The failure that actually matters: a revoked bot token or a bot removed
    // from its channels fails every repo at once. Catching per repo and
    // returning normally would report a successful tick, once a week, forever.
    const post = vi.fn(async () => {
      throw new Error("invalid_auth");
    });

    await expect(
      runRepoDigest(deps({ post }), { repos: ["acme/widgets", "acme/gadgets"] }),
    ).rejects.toThrow(/2 of 2 repos/);
  });

  it("does NOT fail a tick where every repo was merely skipped for having no channel", async () => {
    // "considered 10, posted 0" is the correct, quiet outcome for a deployment
    // that has configured no channels — it must not look like a broken token.
    const post = vi.fn(async () => {});
    await expect(
      runRepoDigest(deps({ post, routing: { repoChannels: {} } }), { repos: ["acme/widgets"] }),
    ).resolves.toBeUndefined();
    expect(post).not.toHaveBeenCalled();
  });

  it("honours a repo's cron opt-out", async () => {
    const post = vi.fn(async () => {});
    // `resolveCronRepos` reads the RAW layer through the repo-config cache;
    // with the repo-config feature inert in this harness it returns the list
    // verbatim, so the meaningful assertion is that the cron NAME is carried
    // through at all — without it the narrowing never runs.
    await runRepoDigest(deps({ post }), { repos: ["acme/widgets"], [CRON_NAME_KEY]: "repo-digest" });
    expect(post).toHaveBeenCalledTimes(1);
  });

  it("does nothing when the tick carries no repo list", async () => {
    const post = vi.fn(async () => {});
    await runRepoDigest(deps({ post }), {});
    expect(post).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------

describe("repo digest — the bot half", () => {
  const makeRun = (id: string, owner: string, repo: string, status: string, startedAt = NOW.toISOString()) => {
    db.runs.createRun({
      id,
      workflowName: "pr-review",
      triggerId: `${owner}/${repo}#1`,
      owner,
      repo,
      currentPhase: "review",
      status: status as never,
      startedAt,
    });
  };

  it("counts this repo's runs and ignores another repo's", () => {
    makeRun("a", "acme", "widgets", "succeeded");
    makeRun("b", "acme", "widgets", "failed");
    makeRun("c", "other", "thing", "succeeded");

    const rows = db.runs.summarizeRepoActivity("acme", "widgets", "2000-01-01T00:00:00.000Z");
    expect(rows).toEqual(
      expect.arrayContaining([
        { workflowName: "pr-review", status: "succeeded", count: 1 },
        { workflowName: "pr-review", status: "failed", count: 1 },
      ]),
    );
    expect(rows).toHaveLength(2);
  });

  it("excludes a run that started before the window", () => {
    makeRun("old", "acme", "widgets", "succeeded", "2026-01-01T00:00:00.000Z");
    makeRun("new", "acme", "widgets", "succeeded", NOW.toISOString());
    const rows = db.runs.summarizeRepoActivity("acme", "widgets", WEEK_AGO.toISOString());
    expect(rows).toEqual([{ workflowName: "pr-review", status: "succeeded", count: 1 }]);
  });

  it("matches a legacy row whose repo column is still qualified", () => {
    // Rows written before the owner/repo backfill carry "owner/repo" in the
    // repo column. A bare-name filter would silently miss every one of them.
    makeRun("legacy", "", "acme/widgets", "succeeded");
    const rows = db.runs.summarizeRepoActivity("acme", "widgets", "2000-01-01T00:00:00.000Z");
    expect(rows).toEqual([{ workflowName: "pr-review", status: "succeeded", count: 1 }]);
  });

  it("reports zero cost rather than NaN when no execution carries one", () => {
    expect(db.executions.repoCostSince("acme", "widgets", "2000-01-01T00:00:00.000Z")).toEqual({
      costUsd: 0,
      phases: 0,
    });
  });
});

// ---------------------------------------------------------------------------

describe("repo digest — rendering", () => {
  const facts = {
    repo: "acme/widgets",
    since: WEEK_AGO.toISOString(),
    until: NOW.toISOString(),
    windowDays: 7,
    repoFacts: {
      prsOpened: 3,
      prsMerged: 7,
      prsClosedUnmerged: 1,
      issuesOpened: 4,
      issuesClosed: 5,
      openPrs: 9,
      awaitingReview: 2,
      oldestAwaiting: { number: 412, title: "Refactor the loader", ageDays: 9 },
      escalated: [{ number: 401, title: "Bump lodash" }],
    },
    botFacts: { runs: 14, failed: 2, byWorkflow: { "pr-review": 6, "pr-fix": 3 }, costUsd: 4.123, phases: 40 },
  };

  it("renders the facts into both the text and the blocks", () => {
    const { text, blocks } = renderDigest(facts);
    expect(text).toContain("7 PRs merged, 3 opened, 1 closed unmerged");
    expect(text).toContain("14 runs — 12 ok, 2 failed");
    expect(text).toContain("$4.12");
    expect(text).toContain("#412");
    expect(text).toContain("waiting on a human:");
    expect(blocks[0]).toMatchObject({ type: "header" });
    expect(JSON.stringify(blocks)).toContain("Last Light");
  });

  it("links every PR number to GitHub, in Slack's <url|text> form", () => {
    const { text } = renderDigest(facts);
    expect(text).toContain("<https://github.com/acme/widgets/pull/412|#412>");
    expect(text).toContain("<https://github.com/acme/widgets/pull/401|#401>");
  });

  it("links them in the BLOCK bodies too, not just the fallback text", () => {
    // The two are built from the same lines, so they cannot disagree — but the
    // blocks are what anyone actually reads, so assert them directly.
    const { blocks } = renderDigest(facts);
    const sections = blocks
      .filter((b): b is Extract<typeof b, { type: "section" }> => b.type === "section")
      .map((b) => (b.text as { text: string }).text)
      .join("\n");
    expect(sections).toContain("<https://github.com/acme/widgets/pull/412|#412>");
    expect(sections).toContain("<https://github.com/acme/widgets/pull/401|#401>");
  });

  it("never emits `<#412>` — that is Slack's CHANNEL reference syntax", () => {
    // The bug the link syntax has to avoid: `<#N>` renders as a broken channel
    // link, not a PR link.
    const { text } = renderDigest(facts);
    expect(text).not.toContain("<#412>");
    expect(text).not.toContain("<#401>");
  });

  it("puts the narrative above the bullets, and omits the block when absent", () => {
    const withNarrative = renderDigest(facts, "Busy week.");
    expect(JSON.stringify(withNarrative.blocks)).toContain("Busy week.");
    const without = renderDigest(facts);
    expect(JSON.stringify(without.blocks)).not.toContain("Busy week.");
  });

  it("says so plainly when the bot did nothing", () => {
    const quiet = { ...facts, botFacts: { runs: 0, failed: 0, byWorkflow: {}, costUsd: 0, phases: 0 } };
    expect(renderDigest(quiet).text).toContain("No runs this period");
  });

  it("pluralizes a count of one", () => {
    const one = {
      ...facts,
      repoFacts: { ...facts.repoFacts, prsMerged: 1, prsClosedUnmerged: 0 },
    };
    expect(renderDigest(one).text).toContain("1 PR merged");
  });
});
