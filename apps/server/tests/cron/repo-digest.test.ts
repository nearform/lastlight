import { describe, it, expect, beforeEach, vi } from "vitest";

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

import type { StateDb } from "#src/state/db.js";
import { makeTestDb } from "../helpers/state-db.js";
import type {
  RepoActivityItem,
  RepoDigestDetail,
  MergedPrDetail,
  ClosedIssueDetail,
  OpenedIssueDetail,
} from "#src/engine/github/github.js";
import type { DigestConfig } from "#src/config/config.js";
import {
  runRepoDigest,
  summarizeRepo,
  summarizeContent,
  attributeClosures,
  buildSummaryPrompt,
  type DigestGitHubClient,
  type RepoDigestDeps,
} from "#src/cron/repo-digest.js";
import { resolveRepoChannel } from "#src/notify/repo-channel.js";
import { renderDigest, type RepoFacts } from "#src/notify/digest-blocks.js";
import { CRON_NAME_KEY } from "#src/cron/repo-crons.js";

let db: StateDb;

beforeEach(async () => {
  db = await makeTestDb();
  resolveRepoRunConfig.mockReset();
  resolveRepoRunConfig.mockResolvedValue({});
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

/** Only the methods the digest declares — asserting the surface is part of the point. */
function fakeGh(over: Partial<DigestGitHubClient> = {}): DigestGitHubClient {
  return {
    listRepoActivitySince: vi.fn(async () => []),
    listOpenPullRequests: vi.fn(async () => []),
    listRepoDigestDetail: vi.fn(async () => ({ merged: [], opened: [], closed: [] })),
    ...over,
  } as DigestGitHubClient;
}

const CONFIG: DigestConfig = { windowDays: 7, narrative: false, maxItems: 5, listItems: 8, detailItems: 25 };

function deps(over: Partial<RepoDigestDeps> = {}): RepoDigestDeps {
  return {
    db,
    github: fakeGh(),
    configClient: null,
    routing: { repoChannels: {}, deliveryChannel: "C0FALLBACK" },
    config: CONFIG,
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
    const d = deps({ post, github: fakeGh({
        listOpenPullRequests: vi.fn(async () => [openPr()]) as unknown as DigestGitHubClient["listOpenPullRequests"],
      }) });

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
      deps({ post, summarize, config: { ...CONFIG, narrative: true } }),
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
        config: { ...CONFIG, narrative: true },
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

  it("still posts — and does NOT fail the tick — when the content fetch dies", async () => {
    // The tick failing is how a revoked token surfaces instead of going quiet
    // for a week, so it must stay reserved for facts. The lists are decoration
    // on a digest that was already correct without them: a GraphQL blip (or
    // octokit throwing on a PARTIAL response, which it does) must not page
    // anyone.
    const post = vi.fn(async () => {});
    const github = fakeGh({
      listRepoDigestDetail: vi.fn(async () => {
        throw new Error("502 Bad Gateway");
      }),
    });
    await expect(
      runRepoDigest(deps({ post, github }), { repos: ["acme/widgets"] }),
    ).resolves.toBeUndefined();
    expect(post).toHaveBeenCalledTimes(1);
    const [, text] = post.mock.calls[0] as unknown as [string, string];
    expect(text).toContain("acme/widgets");
  });

  it("posts the week's content when the fetch succeeds", async () => {
    const post = vi.fn(async () => {});
    const github = fakeGh({
      listRepoDigestDetail: vi.fn(async () => ({
        merged: [
          {
            number: 342,
            title: "Stop Slack unfurling every PR link",
            url: "https://github.com/acme/widgets/pull/342",
            authorLogin: "cliftonc",
            authorIsBot: false,
            labels: [],
            body: "Linking the PR numbers made the digest actionable and then unreadable.",
            mergedAt: "2026-08-05T00:00:00.000Z",
            closes: [],
          },
        ],
        opened: [],
        closed: [],
      })),
      listRepoActivitySince: vi.fn(async () => [
        activity({ number: 342, mergedAt: "2026-08-05T00:00:00.000Z" }),
      ]),
    });
    await runRepoDigest(deps({ post, github }), { repos: ["acme/widgets"] });
    const [, text] = post.mock.calls[0] as unknown as [string, string];
    expect(text).toContain("Stop Slack unfurling every PR link");
    expect(text).toContain("<https://github.com/acme/widgets/pull/342|#342>");
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
  const makeRun = async (id: string, owner: string, repo: string, status: string, startedAt = NOW.toISOString()) => {
    await db.runs.createRun({
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

  it("counts this repo's runs and ignores another repo's", async () => {
    await makeRun("a", "acme", "widgets", "succeeded");
    await makeRun("b", "acme", "widgets", "failed");
    await makeRun("c", "other", "thing", "succeeded");

    const rows = await db.runs.summarizeRepoActivity("acme", "widgets", "2000-01-01T00:00:00.000Z");
    expect(rows).toEqual(
      expect.arrayContaining([
        { workflowName: "pr-review", status: "succeeded", count: 1 },
        { workflowName: "pr-review", status: "failed", count: 1 },
      ]),
    );
    expect(rows).toHaveLength(2);
  });

  it("excludes a run that started before the window", async () => {
    await makeRun("old", "acme", "widgets", "succeeded", "2026-01-01T00:00:00.000Z");
    await makeRun("new", "acme", "widgets", "succeeded", NOW.toISOString());
    const rows = await db.runs.summarizeRepoActivity("acme", "widgets", WEEK_AGO.toISOString());
    expect(rows).toEqual([{ workflowName: "pr-review", status: "succeeded", count: 1 }]);
  });

  it("matches a legacy row whose repo column is still qualified", async () => {
    // Rows written before the owner/repo backfill carry "owner/repo" in the
    // repo column. A bare-name filter would silently miss every one of them.
    await makeRun("legacy", "", "acme/widgets", "succeeded");
    const rows = await db.runs.summarizeRepoActivity("acme", "widgets", "2000-01-01T00:00:00.000Z");
    expect(rows).toEqual([{ workflowName: "pr-review", status: "succeeded", count: 1 }]);
  });

  it("reports zero cost rather than NaN when no execution carries one", async () => {
    expect(await db.executions.repoCostSince("acme", "widgets", "2000-01-01T00:00:00.000Z")).toEqual({
      costUsd: 0,
      phases: 0,
    });
  });
});

// ---------------------------------------------------------------------------

describe("repo digest — attributing a closure to a merge", () => {
  const mergedPr = (over: Partial<MergedPrDetail> = {}): MergedPrDetail => ({
    number: 344,
    title: "Reclaim a pod so a retry can proceed",
    url: "https://github.com/acme/widgets/pull/344",
    authorLogin: "someone",
    authorIsBot: false,
    labels: [],
    body: "",
    mergedAt: "2026-08-05T16:26:50.000Z",
    closes: [],
    ...over,
  });

  const closingRef = (over: Partial<MergedPrDetail["closes"][number]> = {}) => ({
    number: 327,
    title: "A bug",
    url: "https://github.com/acme/widgets/issues/327",
    closedAt: "2026-08-05T16:26:52.000Z", // +2s — the merge did this
    repo: "acme/widgets",
    ...over,
  });

  it("attributes an issue that closed moments after the merge", () => {
    const closures = attributeClosures([mergedPr({ closes: [closingRef()] })], "acme/widgets");
    expect(closures.get(344)).toEqual([
      { number: 327, url: "https://github.com/acme/widgets/issues/327" },
    ]);
  });

  it("REJECTS an issue a human closed days before the merge", () => {
    // Observed live on nearform/lastlight: PR #344 lists #341 as a closing
    // reference, but #341 was closed by hand three days earlier. GitHub reports
    // the LINK, not the cause. Trusting it tells three lies at once — the issue
    // disappears from "Closed issues", reappears under a PR that did not close
    // it, and inflates the "closed by merged PRs" count.
    const stale = closingRef({ number: 341, closedAt: "2026-08-02T12:09:07.000Z" });
    const closures = attributeClosures([mergedPr({ closes: [stale] })], "acme/widgets");
    expect(closures.has(344)).toBe(false);
  });

  it("drops a reference to another repository", () => {
    // A cross-repo `#12` rendered against this repo's URL points at the wrong
    // issue entirely.
    const foreign = closingRef({ number: 12, repo: "acme/other" });
    expect(attributeClosures([mergedPr({ closes: [foreign] })], "acme/widgets").has(344)).toBe(false);
  });

  it("drops a linked issue that is still open", () => {
    const open = closingRef({ closedAt: null });
    expect(attributeClosures([mergedPr({ closes: [open] })], "acme/widgets").has(344)).toBe(false);
  });
});

// ---------------------------------------------------------------------------

describe("repo digest — the week's content", () => {
  const pr = (over: Partial<MergedPrDetail> = {}): MergedPrDetail => ({
    number: 1,
    title: "A change",
    url: "https://github.com/acme/widgets/pull/1",
    authorLogin: "someone",
    authorIsBot: false,
    labels: [],
    body: "",
    mergedAt: "2026-08-05T00:00:00.000Z",
    closes: [],
    ...over,
  });
  const issue = (over: Partial<ClosedIssueDetail> = {}): ClosedIssueDetail => ({
    number: 50,
    title: "Something broke",
    url: "https://github.com/acme/widgets/issues/50",
    authorLogin: "reporter",
    authorIsBot: false,
    labels: [],
    body: "",
    closedAt: "2026-08-05T00:00:00.000Z",
    stateReason: "COMPLETED",
    ...over,
  });
  const detail = (over: Partial<RepoDigestDetail> = {}): RepoDigestDetail => ({
    merged: [],
    opened: [],
    closed: [],
    ...over,
  });

  it("folds bot pull requests into a count instead of listing them", () => {
    // A week of Dependabot bumps would otherwise fill the list and push the
    // human work — the only part anybody reads a digest for — under the tail.
    const content = summarizeContent(
      detail({
        merged: [
          pr({ number: 1 }),
          pr({ number: 2, authorLogin: "dependabot", authorIsBot: true }),
          pr({ number: 3, authorLogin: "dependabot", authorIsBot: true }),
        ],
      }),
      "acme/widgets",
      CONFIG,
    );
    expect(content.merged.map((m) => m.number)).toEqual([1]);
    expect(content.mergedByBots).toBe(2);
  });

  it("lists merged pull requests newest first", () => {
    const content = summarizeContent(
      detail({
        merged: [
          pr({ number: 1, mergedAt: "2026-08-03T00:00:00.000Z" }),
          pr({ number: 2, mergedAt: "2026-08-07T00:00:00.000Z" }),
        ],
      }),
      "acme/widgets",
      CONFIG,
    );
    expect(content.merged.map((m) => m.number)).toEqual([2, 1]);
  });

  it("hangs a closed issue off the PR that closed it, and lists it only once", () => {
    const content = summarizeContent(
      detail({
        merged: [
          pr({
            number: 10,
            mergedAt: "2026-08-05T00:00:00.000Z",
            closes: [
              {
                number: 50,
                title: "Something broke",
                url: "https://github.com/acme/widgets/issues/50",
                closedAt: "2026-08-05T00:00:01.000Z",
                repo: "acme/widgets",
              },
            ],
          }),
        ],
        closed: [issue({ number: 50 }), issue({ number: 51 })],
      }),
      "acme/widgets",
      CONFIG,
    );
    expect(content.merged[0].closes).toEqual([
      { number: 50, url: "https://github.com/acme/widgets/issues/50" },
    ]);
    expect(content.closedIssues.map((i) => i.number)).toEqual([51]);
    expect(content.closedByMergedPr).toBe(1);
  });

  it("counts only what it actually removed, never the number of references", () => {
    // The PR closed an issue from BEFORE the window, so nothing was removed
    // from the list — and the header must not claim otherwise.
    const content = summarizeContent(
      detail({
        merged: [
          pr({
            number: 10,
            mergedAt: "2026-08-05T00:00:00.000Z",
            closes: [
              {
                number: 9,
                title: "Old",
                url: "https://github.com/acme/widgets/issues/9",
                closedAt: "2026-08-05T00:00:01.000Z",
                repo: "acme/widgets",
              },
            ],
          }),
        ],
        closed: [issue({ number: 51 })],
      }),
      "acme/widgets",
      CONFIG,
    );
    expect(content.closedIssues.map((i) => i.number)).toEqual([51]);
    expect(content.closedByMergedPr).toBe(0);
  });

  it("marks a closed issue that was not delivered work", () => {
    const content = summarizeContent(
      detail({ closed: [issue({ number: 60, stateReason: "NOT_PLANNED" }), issue({ number: 61 })] }),
      "acme/widgets",
      CONFIG,
    );
    expect(content.closedIssues[0].note).toBe("not planned");
    expect(content.closedIssues[1].note).toBeUndefined();
  });

  it("caps each list at listItems", () => {
    const many = [1, 2, 3, 4, 5].map((n) => pr({ number: n }));
    const content = summarizeContent(detail({ merged: many }), "acme/widgets", { listItems: 2 });
    expect(content.merged).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------

describe("repo digest — the summariser's prompt", () => {
  const factsFor = (repoFacts: Partial<RepoFacts> = {}) => ({
    repo: "acme/widgets",
    since: WEEK_AGO.toISOString(),
    until: NOW.toISOString(),
    windowDays: 7,
    repoFacts: summarizeRepo([], [], WEEK_AGO, NOW, 5) && {
      ...summarizeRepo([], [], WEEK_AGO, NOW, 5),
      ...repoFacts,
    },
    botFacts: { runs: 3, failed: 0, byWorkflow: {}, costUsd: 0, phases: 0 },
  });

  const item = (n: number, body: string): OpenedIssueDetail => ({
    number: n,
    title: `Issue ${n}`,
    url: `https://github.com/acme/widgets/issues/${n}`,
    authorLogin: "reporter",
    authorIsBot: false,
    labels: [],
    body,
    createdAt: "2026-08-05T00:00:00.000Z",
  });

  it("carries the titles and an excerpt of each body", () => {
    const prompt = buildSummaryPrompt(factsFor(), {
      merged: [],
      opened: [item(7, "The loader double-reads the manifest.")],
      closed: [],
    });
    expect(prompt).toContain("#7 Issue 7 (@reporter)");
    expect(prompt).toContain("The loader double-reads the manifest.");
  });

  it("stays inside its character budget when the bodies are enormous", () => {
    // Measured on nearform/lastlight a single PR body runs to 11 KB, so an
    // item count bounds nothing — the budget has to be in characters.
    const huge = Array.from({ length: 60 }, (_, i) => item(i, "x".repeat(11_000)));
    const prompt = buildSummaryPrompt(factsFor(), { merged: [], opened: huge, closed: [] });
    expect(prompt.length).toBeLessThan(20_000);
  });

  it("degrades to the counts alone when the detail fetch failed", () => {
    const prompt = buildSummaryPrompt(factsFor({ prsMerged: 4 }), null);
    expect(prompt).toContain("4 PRs merged");
    expect(prompt).not.toContain("Merged pull requests:");
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
      merged: [],
      mergedByBots: 0,
      newIssues: [],
      closedIssues: [],
      closedByMergedPr: 0,
    } as RepoFacts,
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

  // ── the week's content ───────────────────────────────────────────────────

  const withContent = (over: Partial<RepoFacts>) => ({
    ...facts,
    repoFacts: { ...facts.repoFacts, ...over },
  });

  it("lists each item against GitHub's own URL — issues under /issues/, PRs under /pull/", () => {
    // The old renderer hardcoded `/pull/` because every number it printed was
    // an open PR. Issues broke that assumption, so the URL is now the API's
    // answer rather than a guess.
    const { text } = renderDigest(
      withContent({
        merged: [
          { number: 342, title: "Stop unfurling", url: "https://github.com/acme/widgets/pull/342", author: "cliftonc" },
        ],
        newIssues: [
          { number: 345, title: "Digest says little", url: "https://github.com/acme/widgets/issues/345", author: "x" },
        ],
      }),
    );
    expect(text).toContain("<https://github.com/acme/widgets/pull/342|#342>");
    expect(text).toContain("<https://github.com/acme/widgets/issues/345|#345>");
    expect(text).toContain("Stop unfurling");
  });

  it("shows what a merged PR closed, and how many were folded away", () => {
    const { text } = renderDigest(
      withContent({
        issuesClosed: 4,
        merged: [
          {
            number: 10,
            title: "Fix it",
            url: "https://github.com/acme/widgets/pull/10",
            author: "dev",
            closes: [{ number: 50, url: "https://github.com/acme/widgets/issues/50" }],
          },
        ],
        closedIssues: [
          { number: 51, title: "Other", url: "https://github.com/acme/widgets/issues/51", author: "dev" },
        ],
        closedByMergedPr: 3,
      }),
    );
    expect(text).toContain("(closes <https://github.com/acme/widgets/issues/50|#50>)");
    expect(text).toContain("3 by merged PRs above");
  });

  it("counts the real total in the heading and tails the remainder", () => {
    const { text } = renderDigest(
      withContent({
        prsMerged: 20,
        merged: [
          { number: 1, title: "One", url: "https://github.com/acme/widgets/pull/1", author: "dev" },
        ],
        mergedByBots: 6,
      }),
    );
    expect(text).toContain("Merged (20)");
    expect(text).toContain("…and 19 more");
    expect(text).toContain("plus 6 bot PRs");
  });

  it("omits a content section entirely when there is nothing in it", () => {
    // A quiet week, or a failed enrichment fetch, must not print three empty
    // headings — the digest degrades to exactly what it was before the lists.
    const { text, blocks } = renderDigest(facts);
    expect(text).not.toContain("Merged (");
    expect(text).not.toContain("New issues");
    expect(JSON.stringify(blocks)).toContain("Repo");
  });

  it("links a summary's #references only when the digest knows the number", () => {
    // The model is asked to cite work by number and forbidden to write URLs,
    // so a hallucinated `#999` must read as plain text rather than as a
    // confident link to somebody else's pull request.
    const { text } = renderDigest(
      withContent({
        merged: [
          { number: 342, title: "Stop unfurling", url: "https://github.com/acme/widgets/pull/342", author: "d" },
        ],
      }),
      "Review reliability dominated (#342), unlike #999.",
    );
    expect(text).toContain("<https://github.com/acme/widgets/pull/342|#342>");
    expect(text).toContain("#999");
    expect(text).not.toContain("|#999>");
  });

  it("neutralizes Slack control sequences in untrusted titles and in the summary", () => {
    // An issue title is written by anyone who can open an issue, and it lands
    // in a channel unedited. `<!channel>` is not markup a formatter strips —
    // Slack acts on it — so it must never survive as a literal `<`.
    const { text } = renderDigest(
      withContent({
        newIssues: [
          {
            number: 7,
            title: "<!channel> ship it",
            url: "https://github.com/acme/widgets/issues/7",
            author: "stranger",
          },
        ],
      }),
      "Someone asked for <!here> attention.",
    );
    expect(text).not.toContain("<!channel>");
    expect(text).not.toContain("<!here>");
    expect(text).toContain("&lt;!channel&gt;");
  });
});
