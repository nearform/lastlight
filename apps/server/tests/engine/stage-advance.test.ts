/**
 * Stage advancement — the label mechanics of the software-factory pipeline.
 *
 * Two properties carry the safety argument and everything else here is
 * scaffolding around them:
 *
 * 1. **The ORDER.** Add the new label, then remove the old. If the add fails
 *    the remove must not be attempted, because an issue carrying neither label
 *    has silently left the pipeline with nothing to see; an issue carrying both
 *    is visible and reconcilable.
 * 2. **It never throws.** A failed label write is a lost projection, not a lost
 *    dispatch — `hasRunForTrigger` (guard 3, a DB fact) is what enforces
 *    idempotency. Removing the entry label before the run starts (guard 2) is
 *    what makes the backstop sweep's `label:ready-for-agent` query structurally
 *    unable to re-pick work already dispatched.
 *
 * The 404 case sits at the bottom and is driven against the REAL client method
 * rather than a stub, because "GitHub 404s when the label is not present" is a
 * claim about `removeLabel`, not about its callers.
 */

import { describe, it, expect, vi } from "vitest";
import { advanceStage } from "#src/engine/stage-advance.js";
import {
  STAGE_READY_FOR_AGENT,
  STAGE_AGENT_BUILDING,
  STAGE_READY_FOR_HUMAN,
  STAGE_AGENT_BLOCKED,
} from "#src/engine/stage-labels.js";
import { GitHubClient } from "#src/engine/github/github.js";

// The failure-path cases log via the pino LoggerPort; mock it so the suite's
// stderr stays free of real JSON from tests that are asserting success.
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

const OWNER = "cliftonc";
const REPO = "lastlight";
const ISSUE = 412;

/**
 * A GitHub stand-in that REMEMBERS its labels, so a sequence of advances reads
 * the way a live issue would, and records the call order the ordering rule is
 * about.
 */
function fakeGithub(
  over: { addLabels?: () => Promise<void>; removeLabel?: () => Promise<void> } = {},
) {
  const labels = new Set<string>();
  const calls: string[] = [];
  const addLabels = vi.fn(async (_o: string, _r: string, _n: number, names: string[]) => {
    calls.push("add");
    if (over.addLabels) await over.addLabels();
    for (const l of names) labels.add(l);
  });
  const removeLabel = vi.fn(async (_o: string, _r: string, _n: number, name: string) => {
    calls.push("remove");
    if (over.removeLabel) await over.removeLabel();
    labels.delete(name);
  });
  return { labels, calls, addLabels, removeLabel } as unknown as GitHubClient & {
    labels: Set<string>;
    calls: string[];
    addLabels: ReturnType<typeof vi.fn>;
    removeLabel: ReturnType<typeof vi.fn>;
  };
}

describe("advanceStage — the happy path", () => {
  it("adds the new label BEFORE removing the old one", async () => {
    const github = fakeGithub();
    github.labels.add(STAGE_READY_FOR_AGENT);

    const out = await advanceStage(
      {
        owner: OWNER,
        repo: REPO,
        issueNumber: ISSUE,
        from: STAGE_READY_FOR_AGENT,
        to: STAGE_AGENT_BUILDING,
      },
      { github },
    );

    expect(out).toEqual({ advanced: true, added: true, removed: true });
    expect(github.addLabels).toHaveBeenCalledWith(OWNER, REPO, ISSUE, [STAGE_AGENT_BUILDING]);
    expect(github.removeLabel).toHaveBeenCalledWith(OWNER, REPO, ISSUE, STAGE_READY_FOR_AGENT);

    // THE ordering property. Both orders leave the same labels behind on a
    // fully successful advance, so this assertion — not the label set — is what
    // fails if the two calls are ever swapped.
    expect(github.calls).toEqual(["add", "remove"]);
    expect(github.addLabels.mock.invocationCallOrder[0]).toBeLessThan(
      github.removeLabel.mock.invocationCallOrder[0],
    );

    expect([...github.labels]).toEqual([STAGE_AGENT_BUILDING]);
  });

  it("carries an issue through the whole pipeline one stage at a time", async () => {
    const github = fakeGithub();
    github.labels.add(STAGE_READY_FOR_AGENT);
    const at = { owner: OWNER, repo: REPO, issueNumber: ISSUE };

    await advanceStage({ ...at, from: STAGE_READY_FOR_AGENT, to: STAGE_AGENT_BUILDING }, { github });
    // Guard 2: the entry label is gone the moment the run is dispatched, so the
    // backstop sweep's `label:ready-for-agent` query cannot see this issue at
    // all while it is in flight.
    expect(github.labels.has(STAGE_READY_FOR_AGENT)).toBe(false);

    await advanceStage({ ...at, from: STAGE_AGENT_BUILDING, to: STAGE_READY_FOR_HUMAN }, { github });
    expect([...github.labels]).toEqual([STAGE_READY_FOR_HUMAN]);
  });
});

describe("advanceStage — the asymmetric failure modes", () => {
  it("does NOT attempt the remove when the add fails", async () => {
    // Neither label present is the one outcome worth engineering against: the
    // issue would have left the pipeline with nothing on it to see. So the old
    // label stays, and the previous stage remains a true statement about it.
    const github = fakeGithub({
      addLabels: async () => {
        throw new Error("403 from GitHub");
      },
    });
    github.labels.add(STAGE_READY_FOR_AGENT);

    const out = await advanceStage(
      {
        owner: OWNER,
        repo: REPO,
        issueNumber: ISSUE,
        from: STAGE_READY_FOR_AGENT,
        to: STAGE_AGENT_BUILDING,
      },
      { github },
    );

    expect(out).toMatchObject({ advanced: false, added: false, removed: false, reason: "add-failed" });
    expect(github.removeLabel).not.toHaveBeenCalled();
    expect(github.calls).toEqual(["add"]);
    expect([...github.labels]).toEqual([STAGE_READY_FOR_AGENT]);
  });

  it("reports added-but-not-removed when the remove fails, and does not throw", async () => {
    // Both labels on the issue: visible, reconcilable, harmless. The advance
    // itself stands, which is why `advanced` stays true.
    const github = fakeGithub({
      removeLabel: async () => {
        throw new Error("500 from GitHub");
      },
    });
    github.labels.add(STAGE_READY_FOR_AGENT);

    const out = await advanceStage(
      {
        owner: OWNER,
        repo: REPO,
        issueNumber: ISSUE,
        from: STAGE_READY_FOR_AGENT,
        to: STAGE_AGENT_BUILDING,
      },
      { github },
    );

    expect(out).toMatchObject({ advanced: true, added: true, removed: false, reason: "remove-failed" });
    expect([...github.labels].sort()).toEqual([STAGE_AGENT_BUILDING, STAGE_READY_FOR_AGENT].sort());
  });
});

describe("advanceStage — the degenerate inputs", () => {
  it("only adds when `from` is omitted — entering the pipeline", async () => {
    const github = fakeGithub();

    const out = await advanceStage(
      { owner: OWNER, repo: REPO, issueNumber: ISSUE, to: STAGE_AGENT_BUILDING },
      { github },
    );

    expect(out).toEqual({ advanced: true, added: true, removed: false });
    expect(github.addLabels).toHaveBeenCalledTimes(1);
    expect(github.removeLabel).not.toHaveBeenCalled();
  });

  it("takes nothing off when `from` and `to` are the same label", async () => {
    // A re-entrant advance onto the stage an issue is already in. Removing
    // `from` here would strip the label we just (re-)applied.
    const github = fakeGithub();
    github.labels.add(STAGE_AGENT_BUILDING);

    const out = await advanceStage(
      {
        owner: OWNER,
        repo: REPO,
        issueNumber: ISSUE,
        from: STAGE_AGENT_BUILDING,
        to: STAGE_AGENT_BUILDING,
      },
      { github },
    );

    expect(out).toEqual({ advanced: true, added: true, removed: false });
    expect(github.removeLabel).not.toHaveBeenCalled();
    expect([...github.labels]).toEqual([STAGE_AGENT_BUILDING]);
  });

  it("chat-only mode (`github: null`) makes no calls and does not throw", async () => {
    const out = await advanceStage(
      {
        owner: OWNER,
        repo: REPO,
        issueNumber: ISSUE,
        from: STAGE_READY_FOR_AGENT,
        to: STAGE_AGENT_BUILDING,
      },
      { github: null },
    );

    expect(out).toEqual({ advanced: false, added: false, removed: false, reason: "no-github" });
  });
});

/**
 * `GitHubClient.removeLabel` — driven against the real method, because the 404
 * rule is a claim about THIS code and a stub would only restate the assumption.
 */
describe("GitHubClient.removeLabel", () => {
  /**
   * A client whose `kit()` short-circuits to a stub Octokit (the same seam
   * `withToken` uses), so nothing here touches the network or the App auth.
   */
  function clientWith(removeLabel: ReturnType<typeof vi.fn>): GitHubClient {
    const client = Object.create(GitHubClient.prototype) as GitHubClient;
    const priv = client as unknown as { byInstallation: Map<string, unknown>; staticOctokit: unknown };
    priv.byInstallation = new Map();
    priv.staticOctokit = { rest: { issues: { removeLabel } } };
    return client;
  }

  function httpError(status: number): Error & { status: number } {
    return Object.assign(new Error(`HTTP ${status}`), { status });
  }

  it("swallows a 404 — removing an absent label is a no-op", async () => {
    // GitHub 404s when the label is not on the issue (and when it does not
    // exist in the repo at all). Either way the desired end state already
    // holds, so this must not surface as a failure and must not warn a caller
    // into thinking the stage did not move.
    const removeLabel = vi.fn(async () => {
      throw httpError(404);
    });
    const client = clientWith(removeLabel);

    await expect(
      client.removeLabel(OWNER, REPO, ISSUE, STAGE_READY_FOR_AGENT),
    ).resolves.toBeUndefined();
    expect(removeLabel).toHaveBeenCalledWith({
      owner: OWNER,
      repo: REPO,
      issue_number: ISSUE,
      name: STAGE_READY_FOR_AGENT,
    });
  });

  it("PROPAGATES a 500 — only the one status is swallowed", async () => {
    // A blanket catch would turn "we could not take the entry label off" into
    // silence, which is the re-dispatch loop guard 2 exists to prevent.
    const client = clientWith(
      vi.fn(async () => {
        throw httpError(500);
      }),
    );

    await expect(client.removeLabel(OWNER, REPO, ISSUE, STAGE_READY_FOR_AGENT)).rejects.toThrow(
      "HTTP 500",
    );
  });

  it("is a no-op on an empty label — no request at all", async () => {
    const removeLabel = vi.fn();
    await clientWith(removeLabel).removeLabel(OWNER, REPO, ISSUE, "");
    expect(removeLabel).not.toHaveBeenCalled();
  });
});

// ── Clearing a stale verdict ────────────────────────────────────────────────

/**
 * `alsoRemove` exists for the case that actually happens: an issue fails, is
 * re-run, and succeeds — and carries BOTH terminal labels afterwards, because
 * this advance removes `enter` and the terminal observer removes `running`, so
 * nothing on either path ever clears the older verdict.
 *
 * It is opportunistic by contract, and the tests below pin that: it runs only
 * after the add succeeded, it never reports itself as `removed`, and a failure
 * to tidy is not a failure to advance.
 */
describe("advanceStage — alsoRemove", () => {
  it("clears a stale terminal label once the new one is on", async () => {
    const github = fakeGithub();
    github.labels.add(STAGE_READY_FOR_AGENT);
    github.labels.add(STAGE_AGENT_BLOCKED);

    const result = await advanceStage(
      {
        owner: OWNER,
        repo: REPO,
        issueNumber: ISSUE,
        from: STAGE_READY_FOR_AGENT,
        to: STAGE_AGENT_BUILDING,
        alsoRemove: [STAGE_READY_FOR_HUMAN, STAGE_AGENT_BLOCKED],
      },
      { github },
    );

    expect(result).toMatchObject({ advanced: true, added: true, removed: true });
    expect([...github.labels]).toEqual([STAGE_AGENT_BUILDING]);
  });

  it("never runs when the ADD failed — the ordering rule covers it too", async () => {
    const github = fakeGithub({
      addLabels: async () => {
        throw new Error("422 label write failed");
      },
    });
    github.labels.add(STAGE_AGENT_BLOCKED);

    const result = await advanceStage(
      {
        owner: OWNER,
        repo: REPO,
        issueNumber: ISSUE,
        from: STAGE_READY_FOR_AGENT,
        to: STAGE_AGENT_BUILDING,
        alsoRemove: [STAGE_AGENT_BLOCKED],
      },
      { github },
    );

    expect(result).toMatchObject({ advanced: false, added: false, reason: "add-failed" });
    // The stale label stands: we never got the issue into the new stage, so
    // tidying the old verdict would be removing the only thing still true.
    expect(github.labels.has(STAGE_AGENT_BLOCKED)).toBe(true);
  });

  it("skips `to` and `from`, so a caller may pass the whole stage", async () => {
    const github = fakeGithub();
    github.labels.add(STAGE_READY_FOR_AGENT);

    await advanceStage(
      {
        owner: OWNER,
        repo: REPO,
        issueNumber: ISSUE,
        from: STAGE_READY_FOR_AGENT,
        to: STAGE_AGENT_BUILDING,
        alsoRemove: [STAGE_AGENT_BUILDING, STAGE_READY_FOR_AGENT, STAGE_AGENT_BLOCKED],
      },
      { github },
    );

    // `to` was never removed, and `from` was removed exactly once.
    expect(github.labels.has(STAGE_AGENT_BUILDING)).toBe(true);
    const removedNames = github.removeLabel.mock.calls.map((c: unknown[]) => c[3]);
    expect(removedNames.filter((n: unknown) => n === STAGE_READY_FOR_AGENT)).toHaveLength(1);
    expect(removedNames).not.toContain(STAGE_AGENT_BUILDING);
  });

  it("still advances when the tidy-up fails — untidy is not unsafe", async () => {
    let calls = 0;
    const github = fakeGithub({
      removeLabel: async () => {
        calls += 1;
        // The `from` removal succeeds; the stale one blows up.
        if (calls > 1) throw new Error("500 label removal failed");
      },
    });
    github.labels.add(STAGE_READY_FOR_AGENT);

    const result = await advanceStage(
      {
        owner: OWNER,
        repo: REPO,
        issueNumber: ISSUE,
        from: STAGE_READY_FOR_AGENT,
        to: STAGE_AGENT_BUILDING,
        alsoRemove: [STAGE_AGENT_BLOCKED],
      },
      { github },
    );

    expect(result).toMatchObject({ advanced: true, added: true, removed: true });
  });
});
