import { describe, it, expect, vi } from "vitest";
import { GitHubClient } from "#src/engine/github/github.js";

/**
 * Unit coverage for `getChecksConclusion` — the light, settle-aware red/green
 * read the red-dependency-PR cron uses (no job-log download, unlike
 * getFailedChecks). We swap in a fake Octokit returning canned check_runs +
 * combined-status payloads and assert the derived verdict.
 */
type Run = { status: string; conclusion: string | null; app?: { slug: string } };
type Combined = { state: string; statuses: unknown[] };

function fakeOctokit(runs: Run[], combined: Combined) {
  return {
    rest: {
      checks: {
        listForRef: async () => ({ data: { check_runs: runs } }),
      },
      repos: {
        getCombinedStatusForRef: async () => ({ data: combined }),
      },
    },
  };
}

function clientWith(octokit: unknown): GitHubClient {
  const c = GitHubClient.withToken("t", "http://mock");
  (c as unknown as { staticOctokit: unknown }).staticOctokit = octokit;
  return c;
}

const run = (status: string, conclusion: string | null): Run => ({ status, conclusion });
const noStatus: Combined = { state: "pending", statuses: [] };

describe("GitHubClient.getChecksConclusion", () => {
  it("returns 'none' when there are no check runs and no status contexts", async () => {
    const c = clientWith(fakeOctokit([], noStatus));
    expect(await c.getChecksConclusion("o", "r", "sha")).toBe("none");
  });

  it("returns 'pending' while any check run is still in progress", async () => {
    const c = clientWith(
      fakeOctokit([run("completed", "failure"), run("in_progress", null)], noStatus),
    );
    expect(await c.getChecksConclusion("o", "r", "sha")).toBe("pending");
  });

  it("returns 'failing' once the suite is settled with a failure/timed_out run", async () => {
    const c = clientWith(
      fakeOctokit([run("completed", "success"), run("completed", "timed_out")], noStatus),
    );
    expect(await c.getChecksConclusion("o", "r", "sha")).toBe("failing");
  });

  it("returns 'failing' from a classic combined status even with no check runs", async () => {
    const c = clientWith(fakeOctokit([], { state: "failure", statuses: [{ context: "ci/circle" }] }));
    expect(await c.getChecksConclusion("o", "r", "sha")).toBe("failing");
  });

  it("returns 'pending' from a combined status with contexts still pending", async () => {
    const c = clientWith(fakeOctokit([], { state: "pending", statuses: [{ context: "ci/circle" }] }));
    expect(await c.getChecksConclusion("o", "r", "sha")).toBe("pending");
  });

  it("returns 'passing' when checks exist and none fail or pend", async () => {
    const c = clientWith(
      fakeOctokit([run("completed", "success")], { state: "success", statuses: [{ context: "ci/circle" }] }),
    );
    expect(await c.getChecksConclusion("o", "r", "sha")).toBe("passing");
  });
});

/**
 * **The self-gating deadlock** (07-review-triggers.md §7.2) — "the one that
 * bites in production if it regresses".
 *
 * `getChecksConclusion` aggregates EVERY check run on the head SHA, ours
 * included. Under `review.trigger: after-checks` with `review.postsCheck` on,
 * `last-light/review` sits `queued` waiting for CI — so without `excludeApp`
 * the aggregate is permanently `pending`, the settle event never fires, the
 * review never runs, the check never concludes, and a repo that made it a
 * *required* check has an unmergeable PR forever. The identical loop reaches
 * `pr.checks_passed` on a Dependabot PR whose review check is merely
 * `in_progress`, which is why the rule is uniform rather than mode-specific.
 */
describe("GitHubClient.getChecksSummary — excludeApp (the self-gating deadlock)", () => {
  const ours = (status: string, conclusion: string | null): Run => ({
    status,
    conclusion,
    app: { slug: "last-light" },
  });
  const theirs = (status: string, conclusion: string | null): Run => ({
    status,
    conclusion,
    app: { slug: "github-actions" },
  });

  it("does NOT report pending solely because our own review check is queued", async () => {
    const c = clientWith(fakeOctokit([theirs("completed", "success"), ours("queued", null)], noStatus));

    // Without the exclusion this is the deadlock: `pending` forever.
    expect(await c.getChecksConclusion("o", "r", "sha")).toBe("pending");
    // With it, CI has genuinely settled green and the review can fire.
    expect(await c.getChecksConclusion("o", "r", "sha", { excludeApp: "last-light" })).toBe(
      "passing",
    );
  });

  it("does NOT report pending because a review is IN PROGRESS on a green dependency PR", async () => {
    // The `pr.checks_passed` half of the same deadlock: the merge route would
    // wait on a review that is waiting on nothing.
    const c = clientWith(
      fakeOctokit([theirs("completed", "success"), ours("in_progress", null)], noStatus),
    );
    expect(await c.getChecksConclusion("o", "r", "sha", { excludeApp: "last-light" })).toBe(
      "passing",
    );
  });

  it("keeps our check out of the settled COUNT, so it can never stand in for real CI", async () => {
    // `dependencies.minSettledChecks` exists to tell "CI approved this" from
    // "nothing looked at it". A self-posted check counting toward it would let
    // the bot satisfy its own evidence bar on a repo with no CI at all.
    const c = clientWith(fakeOctokit([ours("completed", "success")], noStatus));
    const summary = await c.getChecksSummary("o", "r", "sha", { excludeApp: "last-light" });
    expect(summary).toEqual({ state: "none", settledCount: 0, pendingCount: 0 });
  });

  it("never masks a REAL failure — excluding ours cannot turn red into green", async () => {
    const c = clientWith(
      fakeOctokit([theirs("completed", "failure"), ours("completed", "success")], noStatus),
    );
    expect(await c.getChecksConclusion("o", "r", "sha", { excludeApp: "last-light" })).toBe(
      "failing",
    );
  });

  it("only excludes OUR app — another app's queued check still means pending", async () => {
    const c = clientWith(fakeOctokit([theirs("queued", null)], noStatus));
    expect(await c.getChecksConclusion("o", "r", "sha", { excludeApp: "last-light" })).toBe(
      "pending",
    );
  });

  it("leaves commit STATUSES alone — they carry no app, and we never post one", async () => {
    const c = clientWith(
      fakeOctokit([ours("queued", null)], { state: "failure", statuses: [{ context: "ci/circle" }] }),
    );
    expect(await c.getChecksConclusion("o", "r", "sha", { excludeApp: "last-light" })).toBe(
      "failing",
    );
  });
});

describe("GitHubClient.getBaseChecksState", () => {
  it("delegates to getChecksConclusion against the base ref", async () => {
    const c = clientWith(fakeOctokit([run("completed", "failure")], noStatus));
    const spy = vi.spyOn(c, "getChecksConclusion");

    // A red base branch is the whole `upstream-broken` signal: the PR isn't at
    // fault, so no amount of retrying it can help.
    expect(await c.getBaseChecksState("o", "r", "main")).toBe("failing");
    expect(spy).toHaveBeenCalledWith("o", "r", "main", {});
  });

  it("forwards `excludeApp` to the head query", async () => {
    const c = clientWith(fakeOctokit([], noStatus));
    const spy = vi.spyOn(c, "getChecksConclusion");
    await c.getBaseChecksState("o", "r", "main", { excludeApp: "last-light" });
    expect(spy).toHaveBeenCalledWith("o", "r", "main", { excludeApp: "last-light" });
  });

  it("passes a branch name straight through as the ref", async () => {
    const c = clientWith(fakeOctokit([], noStatus));
    const spy = vi.spyOn(c, "getChecksConclusion");
    expect(await c.getBaseChecksState("o", "r", "release/2.x")).toBe("none");
    expect(spy).toHaveBeenCalledWith("o", "r", "release/2.x", {});
  });
});
