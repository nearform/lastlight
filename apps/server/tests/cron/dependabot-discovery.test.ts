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

  it("excludes a green dependency PR carrying the requires-human label", async () => {
    const gh = fakeGh(
      {
        "cliftonc/a": [
          { number: 2, title: "Bump a", draft: false, authorLogin: "dependabot[bot]" },
          {
            number: 3,
            title: "Bump b",
            draft: false,
            authorLogin: "dependabot[bot]",
            labels: [REQUIRES_HUMAN_LABEL], // already flagged → skipped, no fetch
          },
        ],
      },
      { "cliftonc/a#2": "clean", "cliftonc/a#3": "clean" },
    );

    const prs = await discoverGreenDependencyPrs(["cliftonc/a"], gh);
    expect(prs).toEqual([{ repo: "cliftonc/a", prNumber: 2, title: "Bump a" }]);
    // #3 was filtered before the per-PR mergeable fetch.
    expect(gh.getPullRequest).not.toHaveBeenCalledWith("cliftonc", "a", 3);
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
});

describe("discoverRedDependencyPrs", () => {
  function fakeGh(
    listing: Record<string, PrEntry[]>,
    conclusion: Record<string, "passing" | "failing" | "pending" | "none">,
  ): PrDiscoveryClient {
    return {
      listOpenPullRequests: vi.fn(async (owner, repo) => (listing[`${owner}/${repo}`] ?? []).map(normalize)),
      getPullRequest: vi.fn(async () => ({ mergeable_state: "unstable" })),
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
      { repo: "cliftonc/a", prNumber: 3, title: "Bump a", branch: "dependabot/npm/pkg-3" },
      { repo: "cliftonc/a", prNumber: 7, title: "Bump c", branch: "dependabot/npm/pkg-7" },
    ]);
  });

  it("excludes a red dependency PR carrying the requires-human label (no checks fetch)", async () => {
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
      { repo: "cliftonc/a", prNumber: 3, title: "Bump a", branch: "dependabot/npm/pkg-3" },
    ]);
    expect(gh.getChecksConclusion).not.toHaveBeenCalledWith("cliftonc", "a", "sha-4");
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
      { repo: "cliftonc/a", prNumber: 2, title: "Bump y", branch: "dependabot/npm/pkg-2" },
    ]);
  });
});
