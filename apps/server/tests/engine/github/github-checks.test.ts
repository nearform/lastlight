import { describe, it, expect } from "vitest";
import { GitHubClient } from "#src/engine/github/github.js";

/**
 * Unit coverage for `getChecksConclusion` — the light, settle-aware red/green
 * read the red-dependency-PR cron uses (no job-log download, unlike
 * getFailedChecks). We swap in a fake Octokit returning canned check_runs +
 * combined-status payloads and assert the derived verdict.
 */
type Run = { status: string; conclusion: string | null };
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
  (c as unknown as { octokit: unknown }).octokit = octokit;
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
