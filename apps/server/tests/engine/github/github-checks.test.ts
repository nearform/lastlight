import { describe, it, expect, vi } from "vitest";
import { GitHubClient } from "#src/engine/github/github.js";

/**
 * Unit coverage for `getChecksConclusion` — the light, settle-aware red/green
 * read the red-dependency-PR cron uses (no job-log download, unlike
 * getFailedChecks). We swap in a fake Octokit returning canned check_runs +
 * combined-status payloads and assert the derived verdict.
 */
type Run = {
  status: string;
  conclusion: string | null;
  app?: { slug: string };
  name?: string;
  started_at?: string;
  id?: number;
};
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

/**
 * **The superseded re-run** — nearform/skillspro#1646.
 *
 * `filter: "latest"` de-dupes per check SUITE, not per check NAME, so a job
 * re-run in a fresh suite comes back ALONGSIDE the attempt it replaced. Reading
 * every run equally pinned that SHA at `failing` forever: the review deferred
 * on `after-checks`, posted its `queued` placeholder, and then no settle event
 * could ever fire because the aggregate could no longer reach a state either
 * emit branch accepted. The PR was merged six hours later with the check still
 * queued.
 */
describe("GitHubClient.getChecksSummary — superseded re-runs", () => {
  const attempt = (
    name: string,
    conclusion: string | null,
    startedAt: string,
    extra: Partial<Run> = {},
  ): Run => ({
    name,
    status: conclusion === null ? "in_progress" : "completed",
    conclusion,
    app: { slug: "github-actions" },
    started_at: startedAt,
    ...extra,
  });

  it("lets a GREEN re-run clear the failure it replaced", async () => {
    // The exact shape #1646 was stuck in.
    const c = clientWith(
      fakeOctokit(
        [
          attempt("Check linked issues", "failure", "2026-08-06T10:11:33Z"),
          attempt("Check linked issues", "success", "2026-08-06T10:23:46Z"),
          attempt("Lint and test", "success", "2026-08-06T10:11:40Z"),
        ],
        noStatus,
      ),
    );
    expect(await c.getChecksConclusion("o", "r", "sha")).toBe("passing");
  });

  it("lets a RED re-run resurrect a failure — latest wins in BOTH directions", async () => {
    // Not "prefer green": the newest attempt is the answer, whatever it says.
    // A flake re-run that fails for real must still read red.
    const c = clientWith(
      fakeOctokit(
        [
          attempt("Lint and test", "success", "2026-08-06T10:11:33Z"),
          attempt("Lint and test", "failure", "2026-08-06T10:23:46Z"),
        ],
        noStatus,
      ),
    );
    expect(await c.getChecksConclusion("o", "r", "sha")).toBe("failing");
  });

  it("reports 'pending' while the re-run of a settled check is still going", async () => {
    // The re-run is the latest attempt, so the check is back in flight — firing
    // a review or a merge off the stale result would assess a moving target.
    const c = clientWith(
      fakeOctokit(
        [
          attempt("Lint and test", "failure", "2026-08-06T10:11:33Z"),
          attempt("Lint and test", null, "2026-08-06T10:23:46Z"),
        ],
        noStatus,
      ),
    );
    expect(await c.getChecksConclusion("o", "r", "sha")).toBe("pending");
  });

  it("never lets one app's green hide ANOTHER app's red of the same name", async () => {
    // Two CI apps may both post a check called "build". They are different
    // checks, so the key is (app, name) and neither supersedes the other.
    const c = clientWith(
      fakeOctokit(
        [
          attempt("build", "failure", "2026-08-06T10:11:33Z", { app: { slug: "circleci" } }),
          attempt("build", "success", "2026-08-06T10:23:46Z", { app: { slug: "github-actions" } }),
        ],
        noStatus,
      ),
    );
    expect(await c.getChecksConclusion("o", "r", "sha")).toBe("failing");
  });

  it("falls back to the check-run id when two attempts share a start time", async () => {
    const c = clientWith(
      fakeOctokit(
        [
          attempt("Lint and test", "success", "2026-08-06T10:11:33Z", { id: 2 }),
          attempt("Lint and test", "failure", "2026-08-06T10:11:33Z", { id: 1 }),
        ],
        noStatus,
      ),
    );
    expect(await c.getChecksConclusion("o", "r", "sha")).toBe("passing");
  });

  it("counts CHECKS, not attempts, in settledCount", async () => {
    // `dependencies.minSettledChecks` asks how many distinct things looked at
    // this SHA. Four re-runs of one reviewer bot were never four opinions.
    const c = clientWith(
      fakeOctokit(
        [
          attempt("copilot-pull-request-reviewer", "success", "2026-08-06T10:11:53Z"),
          attempt("copilot-pull-request-reviewer", "success", "2026-08-06T10:25:41Z"),
          attempt("copilot-pull-request-reviewer", "success", "2026-08-06T10:36:57Z"),
          attempt("Lint and test", "success", "2026-08-06T10:11:40Z"),
        ],
        noStatus,
      ),
    );
    expect(await c.getChecksSummary("o", "r", "sha")).toEqual({
      state: "passing",
      settledCount: 2,
      pendingCount: 0,
    });
  });

  it("does NOT collapse runs that carry no name — no identity, no de-dupe", async () => {
    // Fail safe: without a name there is no claim that two runs are the same
    // check, and keeping both can only ever report the SHA redder than it is.
    const c = clientWith(
      fakeOctokit([run("completed", "success"), run("completed", "failure")], noStatus),
    );
    expect(await c.getChecksConclusion("o", "r", "sha")).toBe("failing");
  });
});

describe("GitHubClient.getCiFailureReport — superseded re-runs", () => {
  it("does not hand the fix agent a failure that has since been re-run green", async () => {
    // The report and the aggregate must agree on what "red" means, or discovery
    // fires a fix for evidence the prompt then cannot reproduce. No logs are
    // fetched at all here: nothing is failing once the stale attempt is dropped.
    const c = clientWith(
      fakeOctokit(
        [
          {
            name: "Lint and test",
            status: "completed",
            conclusion: "failure",
            app: { slug: "github-actions" },
            started_at: "2026-08-06T10:11:33Z",
          },
          {
            name: "Lint and test",
            status: "completed",
            conclusion: "success",
            app: { slug: "github-actions" },
            started_at: "2026-08-06T10:23:46Z",
          },
        ],
        noStatus,
      ),
    );
    expect(await c.getCiFailureReport("o", "r", "sha")).toEqual({
      jobs: [],
      logsAvailable: false,
    });
  });
});

/**
 * The FORK-PR lookup (nearform/lastlight#282). `check_suite` / `check_run`
 * payloads carry `pull_requests[]` only for a same-repo PR, so this is how a
 * fork PR's checks find their PR at all. Its two filters are the whole safety
 * argument — the endpoint answers a looser question than we are asking.
 */
describe("GitHubClient.listOpenPrNumbersForHeadSha", () => {
  const pr = (number: number, state: string, headSha: string) => ({
    number,
    state,
    head: { sha: headSha },
  });

  function octokitWith(prs: unknown[]) {
    return {
      rest: {
        repos: {
          listPullRequestsAssociatedWithCommit: async () => ({ data: prs }),
        },
      },
    };
  }

  it("returns the open PR this commit HEADS", async () => {
    const c = clientWith(octokitWith([pr(282, "open", "969b698")]));
    expect(await c.listOpenPrNumbersForHeadSha("o", "r", "969b698")).toEqual([282]);
  });

  it("ignores a PR that merely CONTAINS the commit", async () => {
    // The endpoint returns every associated PR. A commit sitting in the middle
    // of another PR's branch must never point a review at that PR.
    const c = clientWith(
      octokitWith([pr(282, "open", "969b698"), pr(300, "open", "deadbee")]),
    );
    expect(await c.listOpenPrNumbersForHeadSha("o", "r", "969b698")).toEqual([282]);
  });

  it("ignores a CLOSED PR with the same head", async () => {
    // A settled check on a commit that also heads a closed PR is not a reason
    // to do anything to the closed PR.
    const c = clientWith(octokitWith([pr(199, "closed", "969b698")]));
    expect(await c.listOpenPrNumbersForHeadSha("o", "r", "969b698")).toEqual([]);
  });

  it("returns nothing when the commit heads no open PR", async () => {
    const c = clientWith(octokitWith([]));
    expect(await c.listOpenPrNumbersForHeadSha("o", "r", "969b698")).toEqual([]);
  });

  it("sorts ascending, so a caller taking [0] is deterministic", async () => {
    // One commit can head two open PRs (the same branch targeted at two bases).
    // Whichever we pick must not depend on GitHub's response order.
    const c = clientWith(
      octokitWith([pr(310, "open", "969b698"), pr(282, "open", "969b698")]),
    );
    expect(await c.listOpenPrNumbersForHeadSha("o", "r", "969b698")).toEqual([282, 310]);
  });
});

/**
 * **The missing `Commit statuses: read` grant** (issue #277).
 *
 * The two legs of `getChecksSummary` need two different App permissions, and
 * `Checks: read` does not imply `Commit statuses: read`. Under `Promise.all` a
 * 403 on the status leg rejected the whole call, throwing away the check-runs
 * result the App WAS permitted to read — so an App missing only `statuses` lost
 * its entire CI signal. Nothing surfaced it: no scoped-token profile requests
 * `statuses`, so the token mints cleanly and the 403 lands at call time, while
 * the run still records `success = true`.
 *
 * The status half is additive, so it degrades to "no status contexts". The
 * check-runs half is not, so it still throws.
 */
describe("GitHubClient.getChecksSummary — App without `Commit statuses: read`", () => {
  const forbidden = () => Object.assign(new Error("Resource not accessible by integration"), {
    status: 403,
  });

  /** Check runs readable, combined status 403 — the exact production shape. */
  function octokitWithoutStatuses(runs: Run[], err: () => Error = forbidden) {
    return {
      rest: {
        checks: { listForRef: async () => ({ data: { check_runs: runs } }) },
        repos: {
          getCombinedStatusForRef: async () => {
            throw err();
          },
        },
      },
    };
  }

  it("still reports the check runs' verdict when the status leg 403s", async () => {
    // Under Promise.all this threw, and the caller logged "read failed" and
    // fell back to a value that could not gate anything.
    const c = clientWith(octokitWithoutStatuses([run("completed", "failure")]));
    expect(await c.getChecksConclusion("o-403-failing", "r", "sha")).toBe("failing");
  });

  it("counts only the check runs toward settledCount", async () => {
    const c = clientWith(
      octokitWithoutStatuses([run("completed", "success"), run("completed", "success")]),
    );
    expect(await c.getChecksSummary("o-403-passing", "r", "sha")).toEqual({
      state: "passing",
      settledCount: 2,
      pendingCount: 0,
    });
  });

  it("reports 'none' rather than inventing a green from the unreadable statuses", async () => {
    // The degraded status leg must read as "no contexts", never as a passing
    // one — `dependencies.minSettledChecks` exists to tell "CI approved this"
    // from "nothing looked at it".
    const c = clientWith(octokitWithoutStatuses([]));
    expect(await c.getChecksSummary("o-403-none", "r", "sha")).toEqual({
      state: "none",
      settledCount: 0,
      pendingCount: 0,
    });
  });

  it("degrades the same way for a transient status failure, not just a 403", async () => {
    const c = clientWith(
      octokitWithoutStatuses([run("completed", "success")], () =>
        Object.assign(new Error("bad gateway"), { status: 502 }),
      ),
    );
    expect(await c.getChecksConclusion("o-502", "r", "sha")).toBe("passing");
  });

  it("still throws when the CHECK RUNS leg fails — that half is load-bearing", async () => {
    const c = clientWith({
      rest: {
        checks: {
          listForRef: async () => {
            throw forbidden();
          },
        },
        repos: { getCombinedStatusForRef: async () => ({ data: noStatus }) },
      },
    });
    await expect(c.getChecksSummary("o-checks-403", "r", "sha")).rejects.toThrow(
      "Resource not accessible by integration",
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
