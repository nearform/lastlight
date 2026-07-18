import { describe, it, expect, vi } from "vitest";
import {
  isDependencyPr,
  discoverGreenDependencyPrs,
  type PrDiscoveryClient,
} from "#src/cron/dependabot-discovery.js";

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
    listing: Record<string, Array<{ number: number; title: string; draft: boolean; authorLogin: string }>>,
    mergeState: Record<string, string>,
  ): PrDiscoveryClient {
    return {
      listOpenPullRequests: vi.fn(async (owner, repo) => listing[`${owner}/${repo}`] ?? []),
      getPullRequest: vi.fn(async (owner, repo, n) => ({
        mergeable_state: mergeState[`${owner}/${repo}#${n}`],
      })),
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

  it("isolates a repo whose PR listing throws (skips it, keeps going)", async () => {
    const gh: PrDiscoveryClient = {
      listOpenPullRequests: vi.fn(async (owner, repo) => {
        if (repo === "boom") throw new Error("403");
        return [{ number: 1, title: "Bump x", draft: false, authorLogin: "dependabot[bot]" }];
      }),
      getPullRequest: vi.fn(async () => ({ mergeable_state: "clean" })),
    };

    const prs = await discoverGreenDependencyPrs(["cliftonc/boom", "cliftonc/ok"], gh);
    expect(prs).toEqual([{ repo: "cliftonc/ok", prNumber: 1, title: "Bump x" }]);
  });

  it("caps candidates per repo", async () => {
    const many = Array.from({ length: 40 }, (_, i) => ({
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
