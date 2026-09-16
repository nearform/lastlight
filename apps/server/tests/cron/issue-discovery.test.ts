import { describe, it, expect, vi } from "vitest";

/**
 * The stage labels come from `autonomy.stages`, never from constants in the
 * discoverer — an operator may rename any of them. Mocked here so these tests
 * pin the BEHAVIOUR against a known vocabulary rather than against whatever
 * `config/default.yaml` happens to ship.
 */
const autonomy = vi.hoisted(() => ({
  stages: {
    build: {
      enter: "ready-for-agent",
      running: "agent-building",
      on_success: "ready-for-human",
      on_failure: "agent-blocked",
      workflow: "build",
      gates: {},
      on_merge: "none" as const,
    },
  },
  repos: [] as string[],
  budget: { maxConcurrentBuilds: 2, maxBuildsPerRepoPerDay: 3, dailyUsd: 25, repoDailyUsd: 10 },
}));
vi.mock("#src/config/config.js", () => ({ getAutonomyConfig: () => autonomy }));

import {
  discoverIssuesReadyForAgent,
  type IssueDiscoveryClient,
} from "#src/cron/issue-discovery.js";

type IssueEntry = { number: number; title: string; labels: string[]; isPr?: boolean };

/**
 * A fake that behaves like the real client: the LABEL filter is server-side,
 * and pull requests are never returned (the real method drops anything carrying
 * `item.pull_request`, because `GET /repos/{o}/{r}/issues` returns PRs as
 * issues). Modelling both here is what makes "a PR is never a candidate" a
 * meaningful assertion about the pair rather than about this fake.
 */
function fakeGh(listing: Record<string, IssueEntry[]>): IssueDiscoveryClient {
  return {
    listOpenIssuesByLabel: vi.fn(async (owner: string, repo: string, label: string) =>
      (listing[`${owner}/${repo}`] ?? [])
        .filter((i) => !i.isPr)
        .filter((i) => i.labels.includes(label))
        .map((i) => ({
          number: i.number,
          title: i.title,
          labels: i.labels,
          createdAt: `2026-01-0${(i.number % 9) + 1}T00:00:00Z`,
        })),
    ),
  };
}

describe("discoverIssuesReadyForAgent", () => {
  it("offers an open issue carrying the entry label, shaped for dispatch", async () => {
    const gh = fakeGh({
      "yo61/repo": [
        { number: 7, title: "Add X", labels: ["ready-for-agent", "enhancement"] },
        { number: 8, title: "Unlabelled", labels: ["bug"] },
      ],
    });

    const out = await discoverIssuesReadyForAgent(["yo61/repo"], gh);
    expect(out).toEqual([
      {
        repo: "yo61/repo",
        issueNumber: 7,
        title: "Add X",
        labels: ["ready-for-agent", "enhancement"],
        stage: "build",
      },
    ]);
  });

  it("excludes an issue carrying BOTH the entry and running labels — the partial-advance case", async () => {
    // `advanceStage` is best-effort and never throws. If the ADD of
    // `agent-building` succeeds and the REMOVE of `ready-for-agent` fails, the
    // issue carries both — and it is actively building. Without this exclusion
    // the sweep re-picks it every twenty minutes and guard 2 has silently
    // degraded to guard 3: still safe (the gate's `hasRunForTrigger` refuses),
    // but no longer structural, and invisibly so.
    const gh = fakeGh({
      "yo61/repo": [
        { number: 3, title: "Mid-build", labels: ["ready-for-agent", "agent-building"] },
        { number: 4, title: "Genuinely queued", labels: ["ready-for-agent"] },
      ],
    });

    const out = await discoverIssuesReadyForAgent(["yo61/repo"], gh);
    expect(out.map((c) => c.issueNumber)).toEqual([4]);
  });

  it("never offers a pull request, however it is labelled", async () => {
    // A PR *is* an issue to `GET /repos/{o}/{r}/issues`, and it carries the
    // same labels. One reaching the build pipeline would set an agent to work
    // on somebody's open pull request as though it were a feature request.
    const gh = fakeGh({
      "yo61/repo": [
        { number: 11, title: "A PR", labels: ["ready-for-agent"], isPr: true },
        { number: 12, title: "An issue", labels: ["ready-for-agent"] },
      ],
    });

    const out = await discoverIssuesReadyForAgent(["yo61/repo"], gh);
    expect(out.map((c) => c.issueNumber)).toEqual([12]);
  });

  it("caps at maxPerRepo, oldest first, so the cap is stable across ticks", async () => {
    const gh = fakeGh({
      "yo61/repo": [5, 1, 9, 3, 7].map((n) => ({
        number: n,
        title: `#${n}`,
        labels: ["ready-for-agent"],
      })),
    });

    const out = await discoverIssuesReadyForAgent(["yo61/repo"], gh, { maxPerRepo: 3 });
    // Oldest first rather than whatever order GitHub returned: the same three
    // are offered on every tick until they clear, instead of a rotating slice
    // that starves the tail forever.
    expect(out.map((c) => c.issueNumber)).toEqual([1, 3, 5]);
  });

  it("holds no policy — a held or already-labelled issue is still a candidate", async () => {
    // The hold label, the autonomy allow-list, already-built, run-in-flight and
    // every budget belong to `resolveBuildTrigger` at the dispatch choke point.
    // A second implementation here is the drift the split exists to stop.
    const gh = fakeGh({
      "yo61/repo": [
        { number: 2, title: "Held", labels: ["ready-for-agent", "lastlight-ignore"] },
      ],
    });

    const out = await discoverIssuesReadyForAgent(["yo61/repo"], gh);
    expect(out.map((c) => c.issueNumber)).toEqual([2]);
  });

  it("does not sink the batch when one repo errors", async () => {
    const gh: IssueDiscoveryClient = {
      listOpenIssuesByLabel: vi.fn(async (owner: string, repo: string) => {
        if (repo === "broken") throw new Error("404 not accessible");
        return [{ number: 1, title: "ok", labels: ["ready-for-agent"], createdAt: "2026-01-01T00:00:00Z" }];
      }),
    };

    const logged: string[] = [];
    const out = await discoverIssuesReadyForAgent(["o/broken", "o/fine"], gh, {
      log: (m) => logged.push(m),
    });
    expect(out.map((c) => c.repo)).toEqual(["o/fine"]);
    expect(logged.join("\n")).toContain("o/broken");
  });

  it("skips a malformed repo name rather than querying a nonsense owner", async () => {
    const gh = fakeGh({});
    const out = await discoverIssuesReadyForAgent(["not-a-full-name"], gh);
    expect(out).toEqual([]);
    expect(gh.listOpenIssuesByLabel).not.toHaveBeenCalled();
  });

  it("reads the entry label from config rather than hardcoding it", async () => {
    const gh = fakeGh({ "yo61/repo": [{ number: 1, title: "x", labels: ["ready-for-agent"] }] });
    await discoverIssuesReadyForAgent(["yo61/repo"], gh);
    expect(gh.listOpenIssuesByLabel).toHaveBeenCalledWith(
      "yo61",
      "repo",
      "ready-for-agent",
      expect.anything(),
    );
  });
});
