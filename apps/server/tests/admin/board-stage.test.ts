/**
 * `POST /issues/:owner/:repo/:number/stage` — the board's drag gesture.
 *
 * Modelled on `board-dispatch.test.ts`, and for the same reason: the property
 * under test is a SEQUENCE through the real transport — validate the target
 * label against the operator's own config → re-read the issue live → let the
 * hold outrank it → advance the label → record. A real in-memory `StateDb`,
 * with only GitHub stubbed.
 *
 * The two properties worth stating plainly, because they are what a later
 * change is most likely to break:
 *
 *  1. **`to` is checked against the CONFIGURED stage labels.** This route lets a
 *     browser session write a label to a managed repo, so an unchecked `to`
 *     would be "apply any label to any issue", not "move a card". The
 *     unconfigured-label case asserts NO GitHub write happened at all.
 *  2. **It writes a label and dispatches nothing.** `dispatched` is `false` on
 *     every success. Whether a build follows is the ordinary webhook chain's
 *     decision, and for an already-built issue the answer is "no", because our
 *     own label write arrives with `senderIsBot: true`.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createAdminRoutes, type AdminConfig } from "#src/admin/routes.js";
import type { StateDb } from "#src/state/db.js";
import type { SessionReader } from "#src/admin/sessions.js";
import type { GitHubClient } from "#src/engine/github/github.js";
import { makeTestDb } from "../helpers/state-db.js";
import { resetBoardCacheForTests } from "#src/admin/board-cache.js";
import { issueTriggerId } from "#src/engine/build-decisions.js";
import {
  STAGE_READY_FOR_AGENT,
  STAGE_AGENT_BUILDING,
  STAGE_READY_FOR_HUMAN,
  STAGE_AGENT_BLOCKED,
} from "#src/engine/stage-labels.js";
import { setRuntimeConfig, resetRuntimeConfigForTests, type LastLightConfig } from "#src/config/config.js";

const OWNER = "acme";
const NAME = "widget";
const REPO = `${OWNER}/${NAME}`;
const ISSUE = 412;
const TRIGGER = issueTriggerId(REPO, ISSUE);
const HOLD = "lastlight-ignore";
const SECRET = "test-secret";

let db: StateDb;

const BUILD_STAGE = {
  enter: STAGE_READY_FOR_AGENT,
  running: STAGE_AGENT_BUILDING,
  on_success: STAGE_READY_FOR_HUMAN,
  on_failure: STAGE_AGENT_BLOCKED,
  workflow: "build",
  gates: { post_architect: true },
  on_merge: "none" as const,
};

function runtimeConfig(over: Record<string, unknown> = {}): LastLightConfig {
  return {
    stateDir: "/tmp",
    managedRepos: [REPO],
    botName: "last-light",
    botLogin: "last-light[bot]",
    holdLabel: HOLD,
    models: {},
    variants: {},
    disabled: { workflows: [], crons: [], prompts: [], skills: [], agentContext: [] },
    autonomy: {
      repos: [REPO],
      stages: { build: BUILD_STAGE },
      budget: { maxConcurrentBuilds: 2, maxBuildsPerRepoPerDay: 3, dailyUsd: 25, repoDailyUsd: 10 },
    },
    ...over,
  } as unknown as LastLightConfig;
}

/**
 * The live issue read plus the two label writes a stage advance is made of.
 * `labels` is the LIVE answer; `addThrows` / `removeThrows` drive the two
 * halves of `advanceStage`'s deliberate asymmetry independently.
 */
function fakeGithub(
  over: {
    labels?: string[];
    throws?: boolean;
    addThrows?: boolean;
    removeThrows?: boolean;
    isPr?: boolean;
  } = {},
) {
  const getIssue = vi.fn(async () => {
    if (over.throws) throw new Error("404 Not Found");
    return {
      number: ISSUE,
      title: "Add a retry button",
      body: "It should retry.",
      labels: (over.labels ?? [STAGE_READY_FOR_AGENT]).map((name) => ({ name })),
      // Present ONLY on a pull request reached through the issues API.
      ...(over.isPr ? { pull_request: { url: "https://api.github.com/pulls/412" } } : {}),
    };
  });
  const addLabels = vi.fn(async () => {
    if (over.addThrows) throw new Error("422 label write failed");
  });
  const removeLabel = vi.fn(async () => {
    if (over.removeThrows) throw new Error("500 label removal failed");
  });
  const postComment = vi.fn(async () => 1);
  const client = { getIssue, addLabels, removeLabel, postComment };
  return client as unknown as GitHubClient & typeof client;
}

function makeApp(over: Partial<AdminConfig> = {}) {
  const dispatchWorkflow = vi.fn(async () => ({ success: true }));
  const app = createAdminRoutes(db, {} as unknown as SessionReader, {} as unknown as SessionReader, {
    stateDir: "/tmp",
    sessionsDir: "/tmp/sessions",
    adminPassword: "",
    adminSecret: SECRET,
    dispatchWorkflow,
    ...over,
  } as AdminConfig);
  return { app, dispatchWorkflow };
}

async function move(
  app: ReturnType<typeof makeApp>["app"],
  body: Record<string, unknown>,
  issue: number | string = ISSUE,
) {
  const res = await app.fetch(
    new Request(`http://localhost/issues/${OWNER}/${NAME}/${issue}/stage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
  return { res, json: (await res.json()) as Record<string, any> };
}

/** Every `issue.stage` row written so far, newest first. */
async function activityRows() {
  const { activity } = await db.activity.list();
  return activity.filter((row) => row.action === "issue.stage");
}

beforeEach(async () => {
  db = await makeTestDb();
  resetBoardCacheForTests();
  setRuntimeConfig(runtimeConfig());
});

afterEach(() => {
  resetRuntimeConfigForTests();
  resetBoardCacheForTests();
});

describe("POST /issues/:owner/:repo/:number/stage", () => {
  it("advances the label add-first and records `ok`", async () => {
    const github = fakeGithub();
    const { app, dispatchWorkflow } = makeApp({ github });

    const { res, json } = await move(app, {
      from: STAGE_READY_FOR_AGENT,
      to: STAGE_READY_FOR_HUMAN,
    });

    expect(res.status).toBe(200);
    // This drag lands on `on_success` — a TERMINAL column. "Done" is not a
    // request to build, so the move stands and nothing dispatches. The two
    // build columns are covered in the dispatch suite below.
    expect(json).toMatchObject({ moved: true, advanced: true, removed: true, dispatched: false });
    expect(json.dispatchReason).toMatch(/terminal-column/);

    // Asserted on the client calls rather than on a mocked advance, because the
    // ordering rule is a claim about what reached GitHub and in which order.
    expect(github.addLabels).toHaveBeenCalledWith(OWNER, NAME, ISSUE, [STAGE_READY_FOR_HUMAN]);
    expect(github.removeLabel).toHaveBeenCalledWith(OWNER, NAME, ISSUE, STAGE_READY_FOR_AGENT);
    expect(github.addLabels.mock.invocationCallOrder[0]).toBeLessThan(
      github.removeLabel.mock.invocationCallOrder[0]!,
    );

    expect(dispatchWorkflow).not.toHaveBeenCalled();

    const rows = await activityRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ outcome: "ok", targetType: "issue", targetId: TRIGGER });
    expect(rows[0]!.detail).toMatchObject({
      from: STAGE_READY_FOR_AGENT,
      to: STAGE_READY_FOR_HUMAN,
      advanced: true,
      removed: true,
    });
  });

  it("refuses a label the operator never configured, and writes nothing", async () => {
    // THE security property. An unchecked `to` turns one drag gesture into
    // "write any label to any issue in any managed repo".
    const github = fakeGithub();
    const { app } = makeApp({ github });

    const { res, json } = await move(app, { from: STAGE_READY_FOR_AGENT, to: "security" });

    expect(res.status).toBe(400);
    expect(json.error).toMatch(/not a configured stage label/);
    // Refused before the GitHub read, let alone the write.
    expect(github.getIssue).not.toHaveBeenCalled();
    expect(github.addLabels).not.toHaveBeenCalled();
    expect(github.removeLabel).not.toHaveBeenCalled();
  });

  it("refuses an unconfigured `from` the same way", async () => {
    const github = fakeGithub();
    const { app } = makeApp({ github });

    const { res, json } = await move(app, { from: "security", to: STAGE_READY_FOR_HUMAN });

    expect(res.status).toBe(400);
    expect(json.error).toMatch(/not a configured stage label/);
    expect(github.removeLabel).not.toHaveBeenCalled();
  });

  it("lets the HOLD outrank the drag, names the label, and writes nothing", async () => {
    // A maintainer who applied the hold has said "stay off this subject". A
    // drag is the same request as the dispatch button in a different gesture,
    // so it gets the same refusal and the same sentence.
    const github = fakeGithub({ labels: [STAGE_READY_FOR_AGENT, HOLD] });
    const { app, dispatchWorkflow } = makeApp({ github });

    const { res, json } = await move(app, {
      from: STAGE_READY_FOR_AGENT,
      to: STAGE_READY_FOR_HUMAN,
    });

    expect(res.status).toBe(409);
    expect(json).toMatchObject({ moved: false, held: HOLD, dispatched: false });
    expect(json.reason).toContain(HOLD);
    expect(dispatchWorkflow).not.toHaveBeenCalled();
    expect(github.addLabels).not.toHaveBeenCalled();
    expect(github.removeLabel).not.toHaveBeenCalled();

    const rows = await activityRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ outcome: "denied" });
  });

  it("refuses an unmanaged repo before reading anything", async () => {
    setRuntimeConfig(runtimeConfig({ managedRepos: ["acme/other"] }));
    const github = fakeGithub();
    const { app } = makeApp({ github });

    const { res, json } = await move(app, { to: STAGE_READY_FOR_HUMAN });

    expect(res.status).toBe(403);
    expect(json.error).toMatch(/not a managed repository/);
    expect(github.getIssue).not.toHaveBeenCalled();
    expect(github.addLabels).not.toHaveBeenCalled();
  });

  it("reports 502 rather than moving a card on stale facts", async () => {
    // The board is up to two minutes stale by design. A failed live read means
    // we do not know whether the hold is on, so we do not write.
    const github = fakeGithub({ throws: true });
    const { app } = makeApp({ github });

    const { res, json } = await move(app, { to: STAGE_READY_FOR_HUMAN });

    expect(res.status).toBe(502);
    expect(json.error).toMatch(/could not read/);
    expect(github.addLabels).not.toHaveBeenCalled();
  });

  it("reports 502 on a failed ADD — and does not then attempt the remove", async () => {
    // The dangerous half of the asymmetry. Remove-after-failed-add would drop
    // the issue out of the pipeline with nothing on it to see.
    const github = fakeGithub({ addThrows: true });
    const { app } = makeApp({ github });

    const { res, json } = await move(app, {
      from: STAGE_READY_FOR_AGENT,
      to: STAGE_READY_FOR_HUMAN,
    });

    expect(res.status).toBe(502);
    expect(json.moved).toBe(false);
    expect(github.removeLabel).not.toHaveBeenCalled();

    const rows = await activityRows();
    expect(rows[0]).toMatchObject({ outcome: "error" });
  });

  it("returns 200 on a failed REMOVE — both labels is the tolerable half", async () => {
    const github = fakeGithub({ removeThrows: true });
    const { app } = makeApp({ github });

    const { res, json } = await move(app, {
      from: STAGE_READY_FOR_AGENT,
      to: STAGE_READY_FOR_HUMAN,
    });

    expect(res.status).toBe(200);
    // The advance STANDS. The issue carries both labels — visible, and a later
    // stage wins wherever the pair is read.
    expect(json).toMatchObject({ moved: true, advanced: true, removed: false });
    expect(github.addLabels).toHaveBeenCalledWith(OWNER, NAME, ISSUE, [STAGE_READY_FOR_HUMAN]);

    const rows = await activityRows();
    expect(rows[0]).toMatchObject({ outcome: "ok" });
    expect(rows[0]!.detail).toMatchObject({ advanced: true, removed: false });
  });

  it("unstages with `to: \"\"` — removes `from`, adds nothing", async () => {
    // Dragging a card off the board. `advanceStage` cannot express this (its
    // contract is built around the add), so the route removes directly.
    const github = fakeGithub();
    const { app, dispatchWorkflow } = makeApp({ github });

    const { res, json } = await move(app, { from: STAGE_READY_FOR_AGENT, to: "" });

    expect(res.status).toBe(200);
    expect(json).toMatchObject({ moved: true, advanced: false, removed: true, dispatched: false });
    // Off the board is not a request to build.
    expect(dispatchWorkflow).not.toHaveBeenCalled();
    expect(github.removeLabel).toHaveBeenCalledWith(OWNER, NAME, ISSUE, STAGE_READY_FOR_AGENT);
    expect(github.addLabels).not.toHaveBeenCalled();

    const rows = await activityRows();
    expect(rows[0]).toMatchObject({ outcome: "ok" });
    expect(rows[0]!.detail).toMatchObject({ to: "", removed: true });
  });

  it("requires `to`", async () => {
    const github = fakeGithub();
    const { app } = makeApp({ github });
    const { res } = await move(app, { from: STAGE_READY_FOR_AGENT });
    expect(res.status).toBe(400);
    expect(github.getIssue).not.toHaveBeenCalled();
  });

  it("reports 503 without a GitHub client", async () => {
    const { app } = makeApp({ github: null });
    const { res, json } = await move(app, { to: STAGE_READY_FOR_HUMAN });
    expect(res.status).toBe(503);
    expect(json.error).toMatch(/not configured/);
  });

  it("rejects a nonsense issue number", async () => {
    const { app } = makeApp({ github: fakeGithub() });
    const { res } = await move(app, { to: STAGE_READY_FOR_HUMAN }, "not-a-number");
    expect(res.status).toBe(400);
  });
});

// ── The dispatch half ───────────────────────────────────────────────────────

/**
 * A drag onto a stage's `enter` or `running` column is the same instruction as
 * the Dispatch button, made with a different gesture, so it crosses the same
 * gate with the same standing (`route: "api"`, `senderIsBot: false`).
 *
 * The property most worth guarding is the one in "never writes the entry
 * label": the entry column is gated BEFORE any label is written, because our
 * own `enter` write is the only one that echoes back as a dispatchable webhook,
 * and writing-then-dispatching races that echo to a second run on one branch.
 */
describe("POST /issues/:owner/:repo/:number/stage — dispatch", () => {
  /** A finished build for this issue — what makes `alreadyBuilt` true. */
  async function seedRun(status: "running" | "succeeded", id = `run-${status}`) {
    await db.runs.createRun({
      id,
      workflowName: "build",
      triggerId: TRIGGER,
      owner: OWNER,
      repo: NAME,
      issueNumber: ISSUE,
      currentPhase: "architect",
      status,
      context: { _autonomous: true, _stage: "build" },
      startedAt: new Date().toISOString(),
    });
  }

  it("dispatches when a card lands on the RUNNING column", async () => {
    // The gesture that was broken: `stageForLabel` matches only `enter`, so
    // this label reached no router branch, and the sweep excludes the running
    // label by design — the card was stranded with nothing building.
    const github = fakeGithub();
    const { app, dispatchWorkflow } = makeApp({ github });

    const { res, json } = await move(app, {
      from: STAGE_READY_FOR_AGENT,
      to: STAGE_AGENT_BUILDING,
    });

    expect(res.status).toBe(200);
    expect(json).toMatchObject({ moved: true, dispatched: true, stage: "build" });

    expect(dispatchWorkflow).toHaveBeenCalledTimes(1);
    const [workflow, context] = dispatchWorkflow.mock.calls[0] as unknown as [
      string,
      Record<string, unknown>,
    ];
    expect(workflow).toBe("build");
    // `_stage` is what `stage-observer.ts` reads to move the label at the end;
    // drop it and every board-started build strands on `agent-building`.
    expect(context).toMatchObject({
      _stage: "build",
      _autonomous: true,
      _triggerType: "api",
      repo: REPO,
      issueNumber: ISSUE,
    });
  });

  it("dispatches an entry drop and NEVER writes the entry label — the race fix", async () => {
    // This assertion IS the fix. An `enter` write echoes back through
    // `issues.labeled` and, inside the window before the run row exists,
    // dispatches a second time onto the same branch. Gating first means guard 2
    // advances the issue to `running` and the entry label is never written.
    const github = fakeGithub({ labels: [STAGE_AGENT_BLOCKED] });
    const { app, dispatchWorkflow } = makeApp({ github });

    const { res, json } = await move(app, {
      from: STAGE_AGENT_BLOCKED,
      to: STAGE_READY_FOR_AGENT,
    });

    expect(res.status).toBe(200);
    expect(json).toMatchObject({
      moved: true,
      dispatched: true,
      stage: "build",
      // Where the card ACTUALLY landed, so the SPA does not spring it back.
      landedLabel: STAGE_AGENT_BUILDING,
    });
    expect(dispatchWorkflow).toHaveBeenCalledTimes(1);

    const added = github.addLabels.mock.calls.map((c) => c[3]);
    expect(added).toContainEqual([STAGE_AGENT_BUILDING]);
    expect(added).not.toContainEqual([STAGE_READY_FOR_AGENT]);
    // And the label the card was dragged off is gone.
    expect(github.removeLabel).toHaveBeenCalledWith(OWNER, NAME, ISSUE, STAGE_AGENT_BLOCKED);
  });

  it("re-dragging an ALREADY-BUILT issue dispatches — the behaviour reversal", async () => {
    // Today this is the silent case: our label write arrives with
    // `senderIsBot: true` and the loop guard skips it, so a guardrails failure
    // sitting on `agent-blocked` could never be restarted by dragging. A human
    // is not a machine loop, and the gate has always said so.
    await seedRun("succeeded");
    const github = fakeGithub({ labels: [STAGE_AGENT_BLOCKED] });
    const { app, dispatchWorkflow } = makeApp({ github });

    const { json } = await move(app, {
      from: STAGE_AGENT_BLOCKED,
      to: STAGE_READY_FOR_AGENT,
    });

    expect(json).toMatchObject({ moved: true, dispatched: true });
    expect(json.dispatchReason).toMatch(/^retry:/);
    expect(dispatchWorkflow).toHaveBeenCalledTimes(1);
  });

  it("moves the card but refuses the build while a run is in flight", async () => {
    // A 200, not a 409: the MOVE succeeded. Nothing is wrong with the issue —
    // the work simply cannot start while another run owns the branch.
    await seedRun("running");
    const github = fakeGithub();
    const { app, dispatchWorkflow } = makeApp({ github });

    const { res, json } = await move(app, {
      from: STAGE_READY_FOR_AGENT,
      to: STAGE_AGENT_BUILDING,
    });

    expect(res.status).toBe(200);
    expect(json).toMatchObject({ moved: true, dispatched: false });
    expect(json.dispatchReason).toMatch(/run-in-flight/);
    expect(dispatchWorkflow).not.toHaveBeenCalled();
  });

  it("never dispatches from the on_failure column", async () => {
    // Also the budget-exhausted comment's de-dup key: a dispatch here would
    // fight the one thing standing between one comment and one every 20 min.
    const github = fakeGithub();
    const { app, dispatchWorkflow } = makeApp({ github });

    const { json } = await move(app, {
      from: STAGE_READY_FOR_AGENT,
      to: STAGE_AGENT_BLOCKED,
    });

    expect(json).toMatchObject({ moved: true, dispatched: false });
    expect(json.dispatchReason).toMatch(/terminal-column/);
    expect(dispatchWorkflow).not.toHaveBeenCalled();
  });

  it("moves a pull request card but never builds it", async () => {
    // The pipeline builds ISSUES. A PR reached through the issues API would
    // cross a gate keyed on issue facts and build a branch nobody asked for.
    const github = fakeGithub({ isPr: true });
    const { app, dispatchWorkflow } = makeApp({ github });

    const { res, json } = await move(app, {
      from: STAGE_READY_FOR_AGENT,
      to: STAGE_AGENT_BUILDING,
    });

    expect(res.status).toBe(200);
    expect(json).toMatchObject({ moved: true, dispatched: false });
    expect(json.dispatchReason).toMatch(/not-an-issue/);
    expect(dispatchWorkflow).not.toHaveBeenCalled();
  });

  it("does not dispatch a drop that changes no label", async () => {
    // The client has a same-column no-op, but it is computed from a snapshot up
    // to two minutes stale. This one reads the live labels, and it is what
    // stops a gesture with no confirm step from being drop-spam that bills.
    const github = fakeGithub({ labels: [STAGE_AGENT_BUILDING] });
    const { app, dispatchWorkflow } = makeApp({ github });

    const { json } = await move(app, {
      from: STAGE_READY_FOR_AGENT,
      to: STAGE_AGENT_BUILDING,
    });

    expect(json.dispatched).toBe(false);
    expect(json.dispatchReason).toMatch(/already-in-stage/);
    expect(dispatchWorkflow).not.toHaveBeenCalled();
  });

  it("does not dispatch a workflow no issue route points at", async () => {
    // The drag must not become a hole around the check the button honours.
    setRuntimeConfig(
      runtimeConfig({
        autonomy: {
          repos: [REPO],
          stages: { build: { ...BUILD_STAGE, workflow: "exfiltrate" } },
          budget: { maxConcurrentBuilds: 2, maxBuildsPerRepoPerDay: 3, dailyUsd: 25, repoDailyUsd: 10 },
        },
      }),
    );
    const github = fakeGithub();
    const { app, dispatchWorkflow } = makeApp({ github });

    const { json } = await move(app, {
      from: STAGE_READY_FOR_AGENT,
      to: STAGE_AGENT_BUILDING,
    });

    expect(json).toMatchObject({ moved: true, dispatched: false });
    expect(json.dispatchReason).toMatch(/unroutable-workflow/);
    expect(dispatchWorkflow).not.toHaveBeenCalled();
  });

  it("fails CLOSED when two stages claim the same label", async () => {
    // A spend decision taken on an undecidable config is the wrong direction to
    // guess in — the same reason the gate refuses an unknown stage.
    setRuntimeConfig(
      runtimeConfig({
        autonomy: {
          repos: [REPO],
          stages: {
            build: BUILD_STAGE,
            review: { ...BUILD_STAGE, enter: STAGE_AGENT_BUILDING },
          },
          budget: { maxConcurrentBuilds: 2, maxBuildsPerRepoPerDay: 3, dailyUsd: 25, repoDailyUsd: 10 },
        },
      }),
    );
    const github = fakeGithub();
    const { app, dispatchWorkflow } = makeApp({ github });

    const { json } = await move(app, {
      from: STAGE_READY_FOR_AGENT,
      to: STAGE_AGENT_BUILDING,
    });

    // The MOVE still stands — the label is configured, so writing it is legal.
    expect(json).toMatchObject({ moved: true, dispatched: false });
    expect(json.dispatchReason).toMatch(/ambiguous-stage/);
    expect(dispatchWorkflow).not.toHaveBeenCalled();
  });

  it("records the dispatch outcome on the activity row", async () => {
    // A `retry:` re-spend has to be greppable afterwards, and distinguishable
    // from a first run.
    const github = fakeGithub();
    const { app } = makeApp({ github });

    await move(app, { from: STAGE_READY_FOR_AGENT, to: STAGE_AGENT_BUILDING });

    const rows = await activityRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.detail).toMatchObject({ dispatched: true });
    expect(String((rows[0]!.detail as Record<string, unknown>).dispatchReason)).toMatch(/\S/);
  });

  it("does not dispatch when no runner is wired", async () => {
    // A 200: the move succeeded. Only the build could not be started.
    const github = fakeGithub();
    const { app } = makeApp({ github, dispatchWorkflow: undefined });

    const { res, json } = await move(app, {
      from: STAGE_READY_FOR_AGENT,
      to: STAGE_AGENT_BUILDING,
    });

    expect(res.status).toBe(200);
    expect(json).toMatchObject({ moved: true, dispatched: false });
    expect(json.dispatchReason).toMatch(/dispatch-not-configured/);
  });
});
