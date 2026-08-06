import { describe, it, expect, vi } from "vitest";
import type { WorkflowRun } from "#src/state/workflow-run-store.js";
import {
  REVIEW_CHECK_NAME,
  bindQueuedReviewCheck,
  concludeReviewCheck,
  installReviewCheckObserver,
  openAndBindReviewCheck,
  openReviewCheck,
  postReviewCheckForSkip,
  readReviewCheck,
  recordReviewCheck,
} from "#src/engine/review-check.js";

// review-check.ts logs via the pino LoggerPort. Mock the logger so the
// suite's stderr stays free of real pino JSON from the failure-path tests
// below (createCheckRun/updateCheckRun rejections, etc).
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

/**
 * The `last-light/review` check as a PROJECTION OF RUN STATE (09 → S2).
 *
 * The bug these cover is not routing: the check used to be completed inside a
 * `.then()` chained onto an in-memory promise, so it stranded `in_progress` on
 * every deploy, every queued-then-resumed run, every TTL expiry and every
 * crash. `check-prs-awaiting-review` was the accidental repair — it re-reviewed
 * within 30 minutes and posted a superseding check — and Phase 7's own per-SHA
 * dedup breaks that repair, because a check strands most often on a review that
 * ran and posted, which is exactly the state the dedup skips. You can have the
 * dedup or the accidental repair, not both.
 */

function fakeGithub(over: Record<string, unknown> = {}) {
  return {
    createCheckRun: vi.fn().mockResolvedValue(4242),
    updateCheckRun: vi.fn().mockResolvedValue(undefined),
    getLatestBotReview: vi.fn().mockResolvedValue(null),
    ...over,
  } as any;
}

/** A minimal run-store double that actually stores scratch. */
function fakeDb() {
  const rows = new Map<string, WorkflowRun>();
  const store = {
    rows,
    runs: {
      getRun: vi.fn((id: string) => rows.get(id) ?? null),
      getByTrigger: vi.fn(
        (triggerId: string) =>
          [...rows.values()].find(
            (r) => r.triggerId === triggerId && ["queued", "running", "paused"].includes(r.status),
          ) ?? null,
      ),
      mergeScratch: vi.fn((id: string, patch: Record<string, unknown>) => {
        const run = rows.get(id);
        if (!run) return;
        const next = { ...(run.scratch ?? {}), ...patch };
        for (const [k, v] of Object.entries(patch)) if (v === null) delete next[k];
        run.scratch = next;
      }),
      addTerminalObserver: vi.fn(),
    },
  };
  return store as any;
}

function makeRun(over: Partial<WorkflowRun> = {}): WorkflowRun {
  return {
    id: "run-1",
    workflowName: "pr-review",
    triggerId: "cliftonc/lastlight#8",
    owner: "cliftonc",
    repo: "lastlight",
    issueNumber: 8,
    currentPhase: "review",
    phaseHistory: [],
    status: "running",
    context: {},
    scratch: {},
    startedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...over,
  } as WorkflowRun;
}

describe("openReviewCheck + recordReviewCheck", () => {
  // 7.4a: the lifecycle keys on "this run is a pr-review against a known PR",
  // NOT on the webhook that triggered it. The arguments below are the whole
  // contract — owner, repo, head SHA — so a comment-, cron-, Slack- or
  // CLI-triggered review posts the same check the three PR-attention webhooks
  // used to be the only ones to get.
  it("binds the check to the RUN, not to a promise, and knows nothing about the trigger", async () => {
    const github = fakeGithub();
    const ref = await openReviewCheck(
      { owner: "cliftonc", repo: "lastlight", headSha: "sha-1" },
      { github },
    );
    expect(ref).toEqual({ checkRunId: 4242, owner: "cliftonc", repo: "lastlight", headSha: "sha-1" });
    expect(github.createCheckRun).toHaveBeenCalledWith(
      "cliftonc",
      "lastlight",
      "sha-1",
      REVIEW_CHECK_NAME,
      expect.objectContaining({ output: expect.anything() }),
    );

    const db = fakeDb();
    const run = makeRun();
    db.rows.set(run.id, run);
    recordReviewCheck(db, run.id, ref!);
    expect(readReviewCheck(db.rows.get(run.id))).toEqual(ref);
  });

  it("is best-effort — a failed create loses the check, never the review", async () => {
    const github = fakeGithub({ createCheckRun: vi.fn().mockRejectedValue(new Error("403")) });
    expect(
      await openReviewCheck({ owner: "o", repo: "r", headSha: "s" }, { github }),
    ).toBeNull();
  });

  it("creates nothing without a head SHA or a client", async () => {
    expect(await openReviewCheck({ owner: "o", repo: "r", headSha: "" }, { github: fakeGithub() })).toBeNull();
    expect(await openReviewCheck({ owner: "o", repo: "r", headSha: "s" }, { github: null })).toBeNull();
  });
});

describe("openAndBindReviewCheck + bindQueuedReviewCheck — creation and persistence are one step", () => {
  it("records the ref in the same call that creates it", async () => {
    const db = fakeDb();
    const run = makeRun();
    db.rows.set(run.id, run);
    const github = fakeGithub();

    const ref = await openAndBindReviewCheck(
      db,
      run.id,
      { owner: "cliftonc", repo: "lastlight", headSha: "sha-1", detailsUrl: "https://x/runs/run-1" },
      { github },
    );

    expect(ref).toMatchObject({ checkRunId: 4242 });
    expect(readReviewCheck(db.rows.get(run.id))).toEqual(ref);
    expect(github.updateCheckRun).toHaveBeenCalledWith(
      "cliftonc",
      "lastlight",
      4242,
      expect.objectContaining({ detailsUrl: "https://x/runs/run-1" }),
    );
  });

  it("binds a QUEUED run's check — the path that used to strand one on every capped review", async () => {
    // `runSimpleWorkflow` returns `{ queued: true }` BEFORE it invokes
    // `onRunStart`, and admission promotes the run through `resumeSimpleRun`,
    // which takes no callbacks at all. So the check was created at dispatch,
    // never written to `scratch.reviewCheck`, never seen by the terminal
    // observer and never concluded — and the 30-minute sweep cannot repair it,
    // because a `queued` run counts as active for its trigger, so the sweep
    // resolves `run-in-flight` → placement `none` and posts nothing.
    const db = fakeDb();
    const queued = makeRun({ id: "run-q", status: "queued", scratch: {} });
    db.rows.set(queued.id, queued);
    const github = fakeGithub();

    const ref = await bindQueuedReviewCheck(
      db,
      {
        triggerId: "cliftonc/lastlight#8",
        workflowName: "pr-review",
        owner: "cliftonc",
        repo: "lastlight",
        headSha: "sha-1",
        detailsUrl: (id) => `https://x/runs/${id}`,
      },
      { github },
    );

    expect(ref).toMatchObject({ checkRunId: 4242, headSha: "sha-1" });
    expect(readReviewCheck(db.rows.get("run-q"))).toEqual(ref);

    // ...and it is therefore CONCLUDED when the queued run reaches a terminal
    // status — the TTL expiry (`expireQueued`) notifies the same observer.
    const observers: Array<(r: WorkflowRun, s: any) => void> = [];
    db.runs.addTerminalObserver.mockImplementation((fn: any) => observers.push(fn));
    installReviewCheckObserver(db, { github });
    observers[0](db.rows.get("run-q")!, "cancelled");
    await new Promise((r) => setTimeout(r, 0));
    expect(github.updateCheckRun).toHaveBeenCalledWith(
      "cliftonc",
      "lastlight",
      4242,
      expect.objectContaining({ status: "completed", conclusion: "cancelled" }),
    );
  });

  it("creates nothing when the queued row already owns a check, or is not ours", async () => {
    const db = fakeDb();
    const existing = { checkRunId: 7, owner: "cliftonc", repo: "lastlight", headSha: "sha-0" };
    db.rows.set("run-q", makeRun({ id: "run-q", status: "queued", scratch: { reviewCheck: existing } }));
    db.rows.set(
      "run-other",
      makeRun({ id: "run-other", status: "queued", triggerId: "cliftonc/lastlight#9", workflowName: "pr-fix" }),
    );
    const github = fakeGithub();
    const args = { owner: "cliftonc", repo: "lastlight", headSha: "sha-1" };

    // A duplicate trigger on an already-queued run: a second check would orphan
    // the first rather than supersede it.
    expect(
      await bindQueuedReviewCheck(
        db,
        { ...args, triggerId: "cliftonc/lastlight#8", workflowName: "pr-review" },
        { github },
      ),
    ).toBeNull();
    // A queued run of a DIFFERENT workflow does not get a review check.
    expect(
      await bindQueuedReviewCheck(
        db,
        { ...args, triggerId: "cliftonc/lastlight#9", workflowName: "pr-review" },
        { github },
      ),
    ).toBeNull();
    // No row at all (the run started immediately, or the dispatch failed).
    expect(
      await bindQueuedReviewCheck(
        db,
        { ...args, triggerId: "cliftonc/lastlight#404", workflowName: "pr-review" },
        { github },
      ),
    ).toBeNull();
    expect(github.createCheckRun).not.toHaveBeenCalled();
    expect(readReviewCheck(db.rows.get("run-q"))).toEqual(existing);
  });
});

describe("concludeReviewCheck — the terminal transition", () => {
  async function conclude(
    status: "succeeded" | "failed" | "cancelled",
    github: any,
    scratch: Record<string, unknown> = {
      reviewCheck: { checkRunId: 4242, owner: "cliftonc", repo: "lastlight", headSha: "sha-1" },
    },
  ) {
    const db = fakeDb();
    const run = makeRun({ scratch, status });
    db.rows.set(run.id, run);
    await concludeReviewCheck(db, run, status, { github, botLogin: "last-light[bot]" });
    return { db, run };
  }

  it("reads the conclusion from the review we actually POSTED, not from the exit code", async () => {
    const github = fakeGithub({
      getLatestBotReview: vi.fn().mockResolvedValue({ state: "APPROVED", body: "lgtm" }),
    });
    await conclude("succeeded", github);
    expect(github.updateCheckRun).toHaveBeenCalledWith(
      "cliftonc",
      "lastlight",
      4242,
      expect.objectContaining({ status: "completed", conclusion: "success" }),
    );
    // Pinned to the SHA the check was created against — a rebase mid-review
    // produces a NEW head with its own check, it does not retro-judge this one.
    expect(github.getLatestBotReview).toHaveBeenCalledWith(
      "cliftonc",
      "lastlight",
      8,
      "sha-1",
      "last-light[bot]",
    );
  });

  it("maps CHANGES_REQUESTED to a failing check", async () => {
    const github = fakeGithub({
      getLatestBotReview: vi.fn().mockResolvedValue({ state: "CHANGES_REQUESTED", body: "no" }),
    });
    await conclude("succeeded", github);
    expect(github.updateCheckRun.mock.calls[0][3].conclusion).toBe("failure");
  });

  it("a run that succeeded but posted nothing is NEUTRAL, not an approval", async () => {
    // A `succeeded` run that legitimately skipped (already reviewed, nothing to
    // say) must not claim a verdict it never gave — and `neutral` passes branch
    // protection, so it never blocks a merge either.
    const github = fakeGithub();
    await conclude("succeeded", github);
    expect(github.updateCheckRun.mock.calls[0][3].conclusion).toBe("neutral");
  });

  it("CONCLUDES ON FAILURE — the deploy/crash case that used to strand it forever", async () => {
    const github = fakeGithub();
    await conclude("failed", github);
    const update = github.updateCheckRun.mock.calls[0][3];
    expect(update.status).toBe("completed");
    expect(update.conclusion).toBe("neutral");
    expect(update.output.title).toMatch(/didn't complete/);
  });

  it("CONCLUDES ON CANCEL — the queued-run TTL expiry and the admin cancel", async () => {
    const github = fakeGithub();
    await conclude("cancelled", github);
    expect(github.updateCheckRun.mock.calls[0][3]).toMatchObject({
      status: "completed",
      conclusion: "cancelled",
    });
    // No review lookup: a cancelled run posted nothing by definition.
    expect(github.getLatestBotReview).not.toHaveBeenCalled();
  });

  it("clears the ref BEFORE the network call, so a second terminal notice is a no-op", async () => {
    const github = fakeGithub();
    const { db, run } = await conclude("succeeded", github);
    expect(readReviewCheck(db.rows.get(run.id))).toBeNull();
    await concludeReviewCheck(db, db.rows.get(run.id), "failed", { github });
    expect(github.updateCheckRun).toHaveBeenCalledTimes(1);
  });

  it("does nothing for a run that owns no check — which is almost every run", async () => {
    const github = fakeGithub();
    await conclude("succeeded", github, {});
    expect(github.updateCheckRun).not.toHaveBeenCalled();
  });

  it("survives a broken review lookup rather than leaving the check open", async () => {
    const github = fakeGithub({
      getLatestBotReview: vi.fn().mockRejectedValue(new Error("502")),
    });
    await conclude("succeeded", github);
    expect(github.updateCheckRun).toHaveBeenCalled();
  });
});

describe("installReviewCheckObserver", () => {
  it("hangs the projection on the store's terminal transition, once", () => {
    const db = fakeDb();
    installReviewCheckObserver(db, { github: fakeGithub() });
    expect(db.runs.addTerminalObserver).toHaveBeenCalledTimes(1);
    // A run with no check short-circuits before any I/O — this is what keeps the
    // hook free for the ~all runs that are not reviews.
    const observer = db.runs.addTerminalObserver.mock.calls[0][0];
    expect(() => observer(makeRun(), "succeeded")).not.toThrow();
  });
});

describe("postReviewCheckForSkip — the deferred placeholder", () => {
  const args = {
    workflowName: "pr-review",
    postsCheck: true,
    route: "attention" as const,
    owner: "cliftonc",
    repo: "lastlight",
    headSha: "sha-1",
  };

  it("posts a `queued` check when after-checks is waiting for CI", async () => {
    const github = fakeGithub();
    await postReviewCheckForSkip({ ...args, placement: "queued" }, { github });
    expect(github.createCheckRun.mock.calls[0][4]).toMatchObject({ status: "queued" });
  });

  it("posts a `neutral` check under on-request — passing, so it never blocks a merge", async () => {
    const github = fakeGithub();
    await postReviewCheckForSkip(
      { ...args, placement: "neutral" },
      { github, botMention: "@nearform-lastlight" },
    );
    const opts = github.createCheckRun.mock.calls[0][4];
    expect(opts).toMatchObject({ status: "completed", conclusion: "neutral" });
    expect(opts.output.summary).toContain("@nearform-lastlight review");
  });

  it("posts NOTHING for a plain skip — a run that never dispatches creates no check", async () => {
    const github = fakeGithub();
    await postReviewCheckForSkip({ ...args, placement: "none" }, { github });
    expect(github.createCheckRun).not.toHaveBeenCalled();
  });

  it("posts NOTHING off a PR-attention event — the 30-minute sweep is not a new head SHA", async () => {
    const github = fakeGithub();
    for (const route of ["sweep", "checks-settled"] as const) {
      await postReviewCheckForSkip({ ...args, route, placement: "queued" }, { github });
    }
    expect(github.createCheckRun).not.toHaveBeenCalled();
  });

  it("respects review.postsCheck and the workflow name", async () => {
    const github = fakeGithub();
    await postReviewCheckForSkip({ ...args, postsCheck: false, placement: "queued" }, { github });
    await postReviewCheckForSkip({ ...args, workflowName: "pr-fix", placement: "queued" }, { github });
    expect(github.createCheckRun).not.toHaveBeenCalled();
  });

  /**
   * `carried-over` — the generated-only skip (issue #271).
   *
   * Every OTHER review skip either already has a check on this head
   * (`already-reviewed`) or must not have one (draft, hold, lock). This one
   * leaves a brand-new head SHA with none, and on a deployment whose branch
   * protection requires `last-light/review` a missing check is an unmergeable
   * PR. So it restates the review that still stands instead of staying silent.
   */
  describe("carried-over — the review that still stands", () => {
    const carried = (state: string) => ({
      ...args,
      placement: "carried-over" as const,
      carriedOver: { sha: "0ld5ha0000000", state },
    });

    it("mirrors the prior verdict rather than fixing a conclusion", async () => {
      for (const [state, conclusion] of [
        ["APPROVED", "success"],
        // The one that matters: carrying a CHANGES_REQUESTED forward as
        // `success` would clear the merge gate the review deliberately closed.
        ["CHANGES_REQUESTED", "failure"],
        ["COMMENTED", "neutral"],
      ] as const) {
        const github = fakeGithub();
        await postReviewCheckForSkip(carried(state), { github, botMention: "@bot" });
        const opts = github.createCheckRun.mock.calls[0][4];
        expect(opts, state).toMatchObject({ status: "completed", conclusion });
        expect(opts.output.summary).toContain("0ld5ha0");
        // The escape hatch is named on the check itself.
        expect(opts.output.summary).toContain("@bot review");
      }
    });

    it("is exempt from the attention-only route limit", async () => {
      // Under the packaged `after-checks` trigger the decision is taken on the
      // `checks-settled` route. Limiting it to attention would leave the
      // required check missing on exactly the heads this exists to cover.
      for (const route of ["attention", "checks-settled", "sweep"] as const) {
        const github = fakeGithub();
        await postReviewCheckForSkip({ ...carried("APPROVED"), route }, { github });
        expect(github.createCheckRun, route).toHaveBeenCalledTimes(1);
      }
    });

    it("posts nothing without the prior review to restate", async () => {
      const github = fakeGithub();
      await postReviewCheckForSkip({ ...args, placement: "carried-over" }, { github });
      expect(github.createCheckRun).not.toHaveBeenCalled();
    });

    it("still respects review.postsCheck", async () => {
      const github = fakeGithub();
      await postReviewCheckForSkip({ ...carried("APPROVED"), postsCheck: false }, { github });
      expect(github.createCheckRun).not.toHaveBeenCalled();
    });
  });
});
