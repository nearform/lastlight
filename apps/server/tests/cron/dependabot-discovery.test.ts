import { describe, it, expect, vi } from "vitest";
import {
  isDependencyPr,
  discoverGreenDependencyPrs,
  discoverRedDependencyPrs,
  REQUIRES_HUMAN_LABEL,
  type PrDiscoveryClient,
} from "#src/cron/dependabot-discovery.js";

/** A test PR entry — labels/headRef/headSha default so cases stay terse. */
type PrEntry = {
  number: number;
  title: string;
  draft: boolean;
  authorLogin: string;
  labels?: string[];
  headRef?: string;
  headSha?: string;
};

/** Normalize a terse test entry into the full light record the client returns. */
function normalize(p: PrEntry) {
  return {
    number: p.number,
    title: p.title,
    draft: p.draft,
    authorLogin: p.authorLogin,
    labels: p.labels ?? [],
    headRef: p.headRef ?? `dependabot/npm/pkg-${p.number}`,
    headSha: p.headSha ?? `sha-${p.number}`,
  };
}

describe("isDependencyPr", () => {
  it("keeps dependabot / renovate bot PRs", () => {
    expect(isDependencyPr({ authorLogin: "dependabot[bot]", title: "Bump x", draft: false })).toBe(true);
    expect(isDependencyPr({ authorLogin: "renovate[bot]", title: "Update x", draft: false })).toBe(true);
    // login match is case-insensitive
    expect(isDependencyPr({ authorLogin: "Dependabot[bot]", title: "whatever", draft: false })).toBe(true);
  });

  it("keeps a proxied bot by dependency-style title", () => {
    expect(isDependencyPr({ authorLogin: "ci-bot", title: "chore(deps): bump lodash", draft: false })).toBe(true);
    expect(isDependencyPr({ authorLogin: "ci-bot", title: "build(deps-dev): bump vite", draft: false })).toBe(true);
    expect(isDependencyPr({ authorLogin: "ci-bot", title: "Update axios requirement to ^1.7", draft: false })).toBe(true);
  });

  it("rejects human PRs and drafts", () => {
    expect(isDependencyPr({ authorLogin: "alice", title: "Add feature", draft: false })).toBe(false);
    expect(isDependencyPr({ authorLogin: "dependabot[bot]", title: "Bump x", draft: true })).toBe(false);
  });
});

describe("discoverGreenDependencyPrs", () => {
  function fakeGh(
    listing: Record<string, PrEntry[]>,
    mergeState: Record<string, string>,
  ): PrDiscoveryClient {
    return {
      listOpenPullRequests: vi.fn(async (owner, repo) => (listing[`${owner}/${repo}`] ?? []).map(normalize)),
      getPullRequest: vi.fn(async (owner, repo, n) => ({
        mergeable_state: mergeState[`${owner}/${repo}#${n}`],
      })),
      getChecksConclusion: vi.fn(async () => "passing" as const),
    };
  }

  it("returns only green (clean) dependency PRs, oldest first, shaped for dispatch", async () => {
    const gh = fakeGh(
      {
        "cliftonc/a": [
          { number: 5, title: "Bump b", draft: false, authorLogin: "dependabot[bot]" },
          { number: 2, title: "Bump a", draft: false, authorLogin: "dependabot[bot]" }, // green, older
          { number: 9, title: "Add feature", draft: false, authorLogin: "alice" }, // not a dep PR
          { number: 7, title: "Bump c", draft: false, authorLogin: "dependabot[bot]" }, // red
        ],
      },
      {
        "cliftonc/a#2": "clean",
        "cliftonc/a#5": "clean",
        "cliftonc/a#7": "unstable", // failing checks → skipped
      },
    );

    const prs = await discoverGreenDependencyPrs(["cliftonc/a"], gh);

    expect(prs).toEqual([
      { repo: "cliftonc/a", prNumber: 2, title: "Bump a" },
      { repo: "cliftonc/a", prNumber: 5, title: "Bump b" },
    ]);
  });

  it("still surfaces a requires-human PR — the label is policy, decided at dispatch", async () => {
    // 09 → S1: the state is "we escalated at head SHA X", not the label, and a
    // discoverer that filtered on it made the label a one-way door no code path
    // could ever reopen. The escalation guard now runs once, at
    // `dispatchWorkflow`, for the cron and the webhook alike.
    const gh = fakeGh(
      {
        "cliftonc/a": [
          { number: 2, title: "Bump a", draft: false, authorLogin: "dependabot[bot]" },
          {
            number: 3,
            title: "Bump b",
            draft: false,
            authorLogin: "dependabot[bot]",
            labels: [REQUIRES_HUMAN_LABEL],
          },
        ],
      },
      { "cliftonc/a#2": "clean", "cliftonc/a#3": "clean" },
    );

    const prs = await discoverGreenDependencyPrs(["cliftonc/a"], gh);
    expect(prs).toEqual([
      { repo: "cliftonc/a", prNumber: 2, title: "Bump a" },
      { repo: "cliftonc/a", prNumber: 3, title: "Bump b" },
    ]);
  });

  it("does not call green a `clean` PR whose checks are red, when requireSettledChecks is on", async () => {
    // `mergeable_state: clean` is GitHub's MERGEABILITY verdict. On a repo with
    // no *required* status checks it is true for a PR whose CI is failing —
    // the exact hazard the merge prompt documents ("this has happened").
    const gh = fakeGh(
      { "cliftonc/a": [{ number: 2, title: "Bump a", draft: false, authorLogin: "dependabot[bot]" }] },
      { "cliftonc/a#2": "clean" },
    );
    gh.getChecksConclusion = vi.fn(async () => "failing" as const);

    expect(await discoverGreenDependencyPrs(["cliftonc/a"], gh, { requireSettledChecks: true })).toEqual([]);
    // ...and asks the checks about the exact commit it listed.
    expect(gh.getChecksConclusion).toHaveBeenCalledWith("cliftonc", "a", "sha-2", {
      // Uniform rule: our own review check never counts toward a TRIGGER-side
      // settle computation, or a queued review strands the sweep (07 §7.2).
      excludeApp: undefined,
    });
  });

  it("keeps today's behaviour when requireSettledChecks is off — no extra call", async () => {
    const gh = fakeGh(
      { "cliftonc/a": [{ number: 2, title: "Bump a", draft: false, authorLogin: "dependabot[bot]" }] },
      { "cliftonc/a#2": "clean" },
    );
    gh.getChecksConclusion = vi.fn(async () => "failing" as const);

    expect(await discoverGreenDependencyPrs(["cliftonc/a"], gh)).toEqual([
      { repo: "cliftonc/a", prNumber: 2, title: "Bump a" },
    ]);
    expect(gh.getChecksConclusion).not.toHaveBeenCalled();
  });

  it("fails CLOSED on a checks read error — a wrongly-green PR costs a merged red PR", async () => {
    const gh = fakeGh(
      { "cliftonc/a": [{ number: 2, title: "Bump a", draft: false, authorLogin: "dependabot[bot]" }] },
      { "cliftonc/a#2": "clean" },
    );
    gh.getChecksConclusion = vi.fn(async () => {
      throw new Error("502");
    });

    expect(await discoverGreenDependencyPrs(["cliftonc/a"], gh, { requireSettledChecks: true })).toEqual([]);
  });

  it("isolates a repo whose PR listing throws (skips it, keeps going)", async () => {
    const gh: PrDiscoveryClient = {
      listOpenPullRequests: vi.fn(async (owner, repo) => {
        if (repo === "boom") throw new Error("403");
        return [normalize({ number: 1, title: "Bump x", draft: false, authorLogin: "dependabot[bot]" })];
      }),
      getPullRequest: vi.fn(async () => ({ mergeable_state: "clean" })),
      getChecksConclusion: vi.fn(async () => "passing" as const),
    };

    const prs = await discoverGreenDependencyPrs(["cliftonc/boom", "cliftonc/ok"], gh);
    expect(prs).toEqual([{ repo: "cliftonc/ok", prNumber: 1, title: "Bump x" }]);
  });

  it("caps candidates per repo", async () => {
    const many: PrEntry[] = Array.from({ length: 40 }, (_, i) => ({
      number: i + 1,
      title: `Bump ${i}`,
      draft: false,
      authorLogin: "dependabot[bot]",
    }));
    const gh = fakeGh({ "cliftonc/a": many }, Object.fromEntries(many.map((p) => [`cliftonc/a#${p.number}`, "clean"])));

    const prs = await discoverGreenDependencyPrs(["cliftonc/a"], gh, { maxPerRepo: 10 });
    expect(prs).toHaveLength(10);
    expect(prs[0].prNumber).toBe(1); // oldest first
  });

  it("skips malformed repo names", async () => {
    const gh = fakeGh({}, {});
    const prs = await discoverGreenDependencyPrs(["not-a-full-name"], gh);
    expect(prs).toEqual([]);
    expect(gh.listOpenPullRequests).not.toHaveBeenCalled();
  });

  /**
   * A client whose per-PR `getPullRequest` returns a SEQUENCE of mergeable_states
   * (one per call), staying on the last once exhausted — models GitHub's lazy
   * recompute: first read `unknown`, a later read settles. `sleep`/short delays
   * (below) run the poll loop instantly.
   */
  function sequencedGh(
    listing: Record<string, PrEntry[]>,
    sequences: Record<string, string[]>,
  ): PrDiscoveryClient {
    const calls: Record<string, number> = {};
    return {
      listOpenPullRequests: vi.fn(async (owner, repo) => (listing[`${owner}/${repo}`] ?? []).map(normalize)),
      getPullRequest: vi.fn(async (owner, repo, n) => {
        const key = `${owner}/${repo}#${n}`;
        const seq = sequences[key] ?? ["clean"];
        const i = Math.min(calls[key] ?? 0, seq.length - 1);
        calls[key] = (calls[key] ?? 0) + 1;
        return { mergeable_state: seq[i] };
      }),
      getChecksConclusion: vi.fn(async () => "passing" as const),
    };
  }

  // No-op sleep + zero delays: three extra reads allowed, no real wait.
  const fastPoll = { sleep: async () => {}, mergeablePollDelaysMs: [0, 0, 0] };

  it("re-polls a cold `unknown` and enqueues once it settles to clean", async () => {
    const gh = sequencedGh(
      { "cliftonc/a": [{ number: 2, title: "Bump a", draft: false, authorLogin: "dependabot[bot]" }] },
      { "cliftonc/a#2": ["unknown", "unknown", "clean"] }, // settles on the 3rd read
    );

    const prs = await discoverGreenDependencyPrs(["cliftonc/a"], gh, fastPoll);

    expect(prs).toEqual([{ repo: "cliftonc/a", prNumber: 2, title: "Bump a" }]);
    expect(gh.getPullRequest).toHaveBeenCalledTimes(3); // initial + 2 retries, then settled
  });

  it("gives up on a PR that stays `unknown` through the whole backoff (not enqueued)", async () => {
    const gh = sequencedGh(
      { "cliftonc/a": [{ number: 2, title: "Bump a", draft: false, authorLogin: "dependabot[bot]" }] },
      { "cliftonc/a#2": ["unknown"] }, // never settles
    );

    const prs = await discoverGreenDependencyPrs(["cliftonc/a"], gh, fastPoll);

    expect(prs).toEqual([]);
    // Bounded: initial read + one per delay (3), then gives up — no runaway loop.
    expect(gh.getPullRequest).toHaveBeenCalledTimes(4);
  });
});

describe("discoverRedDependencyPrs", () => {
  function fakeGh(
    listing: Record<string, PrEntry[]>,
    conclusion: Record<string, "passing" | "failing" | "pending" | "none">,
    mergeState: Record<string, string> = {},
  ): PrDiscoveryClient {
    return {
      listOpenPullRequests: vi.fn(async (owner, repo) => (listing[`${owner}/${repo}`] ?? []).map(normalize)),
      // Default `unstable` (mergeable, non-required check red) so tests that only
      // exercise the checks conclusion aren't swept in by mergeable_state.
      getPullRequest: vi.fn(async (owner, repo, n) => ({
        mergeable_state: mergeState[`${owner}/${repo}#${n}`] ?? "unstable",
      })),
      // Keyed by the head SHA we queried (`sha-<n>` per normalize()).
      getChecksConclusion: vi.fn(async (_o, _r, ref) => conclusion[ref] ?? "none"),
    };
  }

  it("returns only settled-failing dependency PRs, oldest first, carrying the head branch", async () => {
    const gh = fakeGh(
      {
        "cliftonc/a": [
          { number: 7, title: "Bump c", draft: false, authorLogin: "dependabot[bot]" }, // failing
          { number: 3, title: "Bump a", draft: false, authorLogin: "dependabot[bot]" }, // failing, older
          { number: 5, title: "Bump b", draft: false, authorLogin: "dependabot[bot]" }, // pending
          { number: 6, title: "Bump d", draft: false, authorLogin: "dependabot[bot]" }, // passing
          { number: 8, title: "Bump e", draft: false, authorLogin: "dependabot[bot]" }, // none
          { number: 9, title: "Add feature", draft: false, authorLogin: "alice" }, // not a dep PR
        ],
      },
      {
        "sha-7": "failing",
        "sha-3": "failing",
        "sha-5": "pending",
        "sha-6": "passing",
        "sha-8": "none",
      },
    );

    const prs = await discoverRedDependencyPrs(["cliftonc/a"], gh);

    expect(prs).toEqual([
      { repo: "cliftonc/a", prNumber: 3, title: "Bump a", branch: "dependabot/npm/pkg-3", reason: "checks-failing" },
      { repo: "cliftonc/a", prNumber: 7, title: "Bump c", branch: "dependabot/npm/pkg-7", reason: "checks-failing" },
    ]);
  });

  it("picks up green-CI PRs whose mergeable_state is behind / dirty / blocked, with the reason", async () => {
    const gh = fakeGh(
      {
        "cliftonc/a": [
          { number: 2, title: "Bump a", draft: false, authorLogin: "renovate[bot]" }, // behind
          { number: 4, title: "Bump b", draft: false, authorLogin: "renovate[bot]" }, // dirty
          { number: 6, title: "Bump c", draft: false, authorLogin: "renovate[bot]" }, // blocked
          { number: 8, title: "Bump d", draft: false, authorLogin: "renovate[bot]" }, // clean → green sweep's
          { number: 9, title: "Bump e", draft: false, authorLogin: "renovate[bot]" }, // stays unknown → skip
        ],
      },
      // All checks green — mergeable_state is the only signal here.
      { "sha-2": "passing", "sha-4": "passing", "sha-6": "passing", "sha-8": "passing", "sha-9": "passing" },
      {
        "cliftonc/a#2": "behind",
        "cliftonc/a#4": "dirty",
        "cliftonc/a#6": "blocked",
        "cliftonc/a#8": "clean",
        "cliftonc/a#9": "unknown", // never settles — re-polled, then skipped
      },
    );

    // #9 is `unknown` throughout, so it exercises the re-poll — run it instantly.
    const prs = await discoverRedDependencyPrs(["cliftonc/a"], gh, {
      sleep: async () => {},
      mergeablePollDelaysMs: [0, 0, 0],
    });

    expect(prs).toEqual([
      { repo: "cliftonc/a", prNumber: 2, title: "Bump a", branch: "dependabot/npm/pkg-2", reason: "behind" },
      { repo: "cliftonc/a", prNumber: 4, title: "Bump b", branch: "dependabot/npm/pkg-4", reason: "dirty" },
      { repo: "cliftonc/a", prNumber: 6, title: "Bump c", branch: "dependabot/npm/pkg-6", reason: "blocked" },
    ]);
  });

  it("prefers checks-failing over a blocking mergeable_state in the reason", async () => {
    const gh = fakeGh(
      { "cliftonc/a": [{ number: 3, title: "Bump a", draft: false, authorLogin: "dependabot[bot]" }] },
      { "sha-3": "failing" },
      { "cliftonc/a#3": "dirty" }, // both red CI and a conflict — CI wins the reason
    );

    const prs = await discoverRedDependencyPrs(["cliftonc/a"], gh);
    expect(prs).toEqual([
      { repo: "cliftonc/a", prNumber: 3, title: "Bump a", branch: "dependabot/npm/pkg-3", reason: "checks-failing" },
    ]);
  });

  it("still surfaces a requires-human red PR — the escalation guard runs at dispatch", async () => {
    const gh = fakeGh(
      {
        "cliftonc/a": [
          { number: 3, title: "Bump a", draft: false, authorLogin: "dependabot[bot]" },
          {
            number: 4,
            title: "Bump b",
            draft: false,
            authorLogin: "dependabot[bot]",
            labels: [REQUIRES_HUMAN_LABEL],
          },
        ],
      },
      { "sha-3": "failing", "sha-4": "failing" },
    );

    const prs = await discoverRedDependencyPrs(["cliftonc/a"], gh);
    expect(prs).toEqual([
      { repo: "cliftonc/a", prNumber: 3, title: "Bump a", branch: "dependabot/npm/pkg-3", reason: "checks-failing" },
      { repo: "cliftonc/a", prNumber: 4, title: "Bump b", branch: "dependabot/npm/pkg-4", reason: "checks-failing" },
    ]);
  });

  it("re-polls a cold `unknown` and routes it once it settles to dirty", async () => {
    const calls: Record<string, number> = {};
    const gh: PrDiscoveryClient = {
      listOpenPullRequests: vi.fn(async () => [
        normalize({ number: 3, title: "Bump a", draft: false, authorLogin: "dependabot[bot]" }),
      ]),
      // Checks are green here, so mergeable_state is the only red signal — and it
      // reads `unknown` cold before settling to `dirty` on the second read.
      getPullRequest: vi.fn(async (_o, _r, n) => {
        const seq = ["unknown", "dirty"];
        const i = Math.min(calls[n] ?? 0, seq.length - 1);
        calls[n] = (calls[n] ?? 0) + 1;
        return { mergeable_state: seq[i] };
      }),
      getChecksConclusion: vi.fn(async () => "passing" as const),
    };

    const prs = await discoverRedDependencyPrs(["cliftonc/a"], gh, {
      sleep: async () => {},
      mergeablePollDelaysMs: [0, 0, 0],
    });

    expect(prs).toEqual([
      { repo: "cliftonc/a", prNumber: 3, title: "Bump a", branch: "dependabot/npm/pkg-3", reason: "dirty" },
    ]);
  });

  it("does not re-read mergeable_state when checks are already settled-failing", async () => {
    const gh = fakeGh(
      { "cliftonc/a": [{ number: 3, title: "Bump a", draft: false, authorLogin: "dependabot[bot]" }] },
      { "sha-3": "failing" },
      { "cliftonc/a#3": "unknown" },
    );

    const prs = await discoverRedDependencyPrs(["cliftonc/a"], gh);

    expect(prs).toEqual([
      { repo: "cliftonc/a", prNumber: 3, title: "Bump a", branch: "dependabot/npm/pkg-3", reason: "checks-failing" },
    ]);
    // Failing CI is reason enough — the mergeable poll is skipped entirely.
    expect(gh.getPullRequest).not.toHaveBeenCalled();
  });

  it("isolates a candidate whose checks fetch throws (skips it, keeps going)", async () => {
    const gh: PrDiscoveryClient = {
      listOpenPullRequests: vi.fn(async () => [
        normalize({ number: 1, title: "Bump x", draft: false, authorLogin: "dependabot[bot]" }),
        normalize({ number: 2, title: "Bump y", draft: false, authorLogin: "dependabot[bot]" }),
      ]),
      getPullRequest: vi.fn(async () => ({ mergeable_state: "unstable" })),
      getChecksConclusion: vi.fn(async (_o, _r, ref) => {
        if (ref === "sha-1") throw new Error("boom");
        return "failing" as const;
      }),
    };

    const prs = await discoverRedDependencyPrs(["cliftonc/a"], gh);
    expect(prs).toEqual([
      { repo: "cliftonc/a", prNumber: 2, title: "Bump y", branch: "dependabot/npm/pkg-2", reason: "checks-failing" },
    ]);
  });
});
