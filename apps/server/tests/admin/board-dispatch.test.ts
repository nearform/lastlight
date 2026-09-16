/**
 * `POST /issues/:owner/:repo/:number/dispatch` — the board's one mutating
 * action on an issue card (Phase 7).
 *
 * Modelled on `pr-retry.test.ts`, and for the same reason: the property under
 * test is a SEQUENCE through the real transport — read the issue live → cross
 * the real `applyBuildDispatchGate` → advance the label, dispatch, record.
 * Faking the gate would fake the two refusals that matter most (the hold, and a
 * run already owning the issue), and faking the store would fake the run lock
 * those refusals are read from. So: a real in-memory `StateDb` and the real
 * gate, with only GitHub and the dispatch itself stubbed.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createAdminRoutes, type AdminConfig } from "#src/admin/routes.js";
import type { StateDb } from "#src/state/db.js";
import type { SessionReader } from "#src/admin/sessions.js";
import type { GitHubClient, BoardRepoItems } from "#src/engine/github/github.js";
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
      // The repo is ON the allow-list: `repos: []` is the feature's inert
      // switch, and every dispatch would otherwise refuse `not-autonomous`
      // before reaching the branch under test.
      repos: [REPO],
      stages: { build: BUILD_STAGE },
      budget: { maxConcurrentBuilds: 2, maxBuildsPerRepoPerDay: 3, dailyUsd: 25, repoDailyUsd: 10 },
    },
    ...over,
  } as unknown as LastLightConfig;
}

/**
 * The live issue read, plus the two label writes the stage advance is made of.
 * `labels` is the LIVE answer — a test moves it to make GitHub disagree with
 * whatever the board cached.
 */
function fakeGithub(over: { labels?: string[]; isPr?: boolean; throws?: boolean } = {}) {
  const getIssue = vi.fn(async () => {
    if (over.throws) throw new Error("404 Not Found");
    return {
      number: ISSUE,
      title: "Add a retry button",
      body: "It should retry.",
      labels: (over.labels ?? [STAGE_READY_FOR_AGENT]).map((name) => ({ name })),
      ...(over.isPr ? { pull_request: { url: "https://api.github.com/pulls/1" } } : {}),
    };
  });
  const addLabels = vi.fn(async () => {});
  const removeLabel = vi.fn(async () => {});
  const postComment = vi.fn(async () => 1);
  // Only the cache-staleness case uses this; the board GET is what primes the
  // cache the dispatch route must NOT trust.
  const listOpenBoardItems = vi.fn(async (owner: string, repos: string[]) => {
    const out = new Map<string, BoardRepoItems>();
    for (const repo of repos) {
      out.set(`${owner}/${repo}`, {
        items: [
          {
            repo: `${owner}/${repo}`,
            number: ISSUE,
            isPr: false,
            title: "Add a retry button",
            url: `https://github.com/${owner}/${repo}/issues/${ISSUE}`,
            author: "maintainer",
            createdAt: "2026-09-01T00:00:00.000Z",
            updatedAt: "2026-09-01T00:00:00.000Z",
            draft: false,
            labels: [{ name: STAGE_READY_FOR_AGENT, color: "ededed" }],
          },
        ],
      });
    }
    return out;
  });
  const client = { getIssue, addLabels, removeLabel, postComment, listOpenBoardItems };
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

async function dispatch(
  app: ReturnType<typeof makeApp>["app"],
  body: Record<string, unknown> = {},
) {
  const res = await app.fetch(
    new Request(`http://localhost/issues/${OWNER}/${NAME}/${ISSUE}/dispatch`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
  return { res, json: (await res.json()) as Record<string, any> };
}

/** Every `issue.dispatch` row written so far, newest first. */
async function activityRows() {
  const { activity } = await db.activity.list();
  return activity.filter((row) => row.action === "issue.dispatch");
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

describe("POST /issues/:owner/:repo/:number/dispatch", () => {
  it("dispatches a clean issue, advances the label first, and records `ok`", async () => {
    const github = fakeGithub();
    const { app, dispatchWorkflow } = makeApp({ github });

    const { res, json } = await dispatch(app);

    expect(res.status).toBe(200);
    expect(json).toMatchObject({
      repo: REPO,
      issueNumber: ISSUE,
      stage: "build",
      workflow: "build",
      dispatched: true,
    });

    // Guard 2: the entry label came OFF before the run started. Asserted on the
    // client calls rather than on a mocked advance, because "the sweep can no
    // longer re-pick this issue" is a claim about what reached GitHub.
    expect(github.addLabels).toHaveBeenCalledWith(OWNER, NAME, ISSUE, [STAGE_AGENT_BUILDING]);
    expect(github.removeLabel).toHaveBeenCalledWith(OWNER, NAME, ISSUE, STAGE_READY_FOR_AGENT);

    expect(dispatchWorkflow).toHaveBeenCalledTimes(1);
    const [workflow, context] = dispatchWorkflow.mock.calls[0] as unknown as [
      string,
      Record<string, any>,
    ];
    expect(workflow).toBe("build");
    // `_stage` is what the terminal observer reads to move the card off
    // `agent-building`; `_autonomous` is what the concurrency ceiling counts.
    expect(context).toMatchObject({
      repo: REPO,
      issueNumber: ISSUE,
      _stage: "build",
      _autonomous: true,
      _triggerType: "api",
    });
    // The stage's HITL gates travel with the dispatch, add-only.
    expect(context._autonomyGates).toMatchObject({ post_architect: true });

    const rows = await activityRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ outcome: "ok", targetType: "issue", targetId: TRIGGER });
  });

  it("refuses a HELD issue by name, records `denied`, and dispatches nothing", async () => {
    // The hold outranks everything, including a human pressing the button —
    // the one case where "somebody asked and was not obeyed" is intentional,
    // which is why the reply names the label rather than a reason code.
    const github = fakeGithub({ labels: [STAGE_READY_FOR_AGENT, HOLD] });
    const { app, dispatchWorkflow } = makeApp({ github });

    const { res, json } = await dispatch(app);

    expect(res.status).toBe(409);
    expect(json).toMatchObject({ dispatched: false, held: HOLD });
    expect(json.reason).toContain(HOLD);
    expect(dispatchWorkflow).not.toHaveBeenCalled();
    // A held issue is not advanced: no label write of any kind.
    expect(github.addLabels).not.toHaveBeenCalled();
    expect(github.removeLabel).not.toHaveBeenCalled();

    const rows = await activityRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ outcome: "denied" });
  });

  it("refuses an unmanaged repo before reading anything", async () => {
    setRuntimeConfig(runtimeConfig({ managedRepos: ["acme/other"] }));
    const github = fakeGithub();
    const { app, dispatchWorkflow } = makeApp({ github });

    const { res, json } = await dispatch(app);

    expect(res.status).toBe(403);
    expect(json.error).toMatch(/not a managed repository/);
    expect(github.getIssue).not.toHaveBeenCalled();
    expect(dispatchWorkflow).not.toHaveBeenCalled();
  });

  it("refuses a workflow no issue route points at — the board is not a generic dispatch surface", async () => {
    // The stage names a workflow the operator's `routes.github` never points an
    // issue trigger at. Refused BEFORE the GitHub read: nothing about the issue
    // could make this dispatch acceptable.
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

    const { res, json } = await dispatch(app);

    expect(res.status).toBe(400);
    expect(json.error).toMatch(/not reachable from an issue route/);
    expect(github.getIssue).not.toHaveBeenCalled();
    expect(dispatchWorkflow).not.toHaveBeenCalled();
  });

  it("refuses a stage that is not configured at all", async () => {
    const github = fakeGithub();
    const { app, dispatchWorkflow } = makeApp({ github });

    const { res, json } = await dispatch(app, { stage: "ghost" });

    expect(res.status).toBe(400);
    expect(json.error).toMatch(/unknown stage/);
    expect(dispatchWorkflow).not.toHaveBeenCalled();
  });

  it("refuses when a run already owns the issue", async () => {
    await db.runs.createRun({
      id: "run-live",
      workflowName: "build",
      triggerId: TRIGGER,
      owner: OWNER,
      repo: NAME,
      issueNumber: ISSUE,
      currentPhase: "architect",
      status: "running",
      context: { _autonomous: true, _stage: "build" },
      startedAt: new Date().toISOString(),
    });
    const github = fakeGithub();
    const { app, dispatchWorkflow } = makeApp({ github });

    const { res, json } = await dispatch(app);

    expect(res.status).toBe(409);
    expect(json.dispatched).toBe(false);
    // `already-built` wins over `run-in-flight` in the gate's branch order —
    // both are the run lock refusing, which is the property under test.
    expect(json.reason).toMatch(/already-built|run-in-flight/);
    expect(dispatchWorkflow).not.toHaveBeenCalled();
    expect((await activityRows())[0]).toMatchObject({ outcome: "denied" });
  });

  it("decides on the LIVE issue, not the cached board snapshot", async () => {
    // The whole point of the re-read. The board is up to two minutes stale by
    // design, so a maintainer can apply the hold label and press the button
    // before the card ever redraws. Cache says clean; GitHub says held.
    const github = fakeGithub({ labels: [STAGE_READY_FOR_AGENT, HOLD] });
    const { app, dispatchWorkflow } = makeApp({ github });

    // Prime the cache through the real board route, and assert it disagrees:
    // the cached card is NOT held and its dispatch action is enabled.
    const boardRes = await app.fetch(new Request(`http://localhost/board?repos=${REPO}`));
    const board = (await boardRes.json()) as Record<string, any>;
    const cachedCard = board.columns[0].cards[0];
    expect(cachedCard.key).toBe(TRIGGER);
    expect(cachedCard.held).toBe(false);
    expect(cachedCard.actions.find((a: any) => a.id === "dispatch").enabled).toBe(true);

    // The live read wins, so the button the board just rendered as enabled is
    // refused on the hold.
    const { res, json } = await dispatch(app);

    expect(github.getIssue).toHaveBeenCalledTimes(1);
    expect(res.status).toBe(409);
    expect(json).toMatchObject({ dispatched: false, held: HOLD });
    expect(dispatchWorkflow).not.toHaveBeenCalled();
  });

  it("reports 502 rather than deciding without live facts", async () => {
    const github = fakeGithub({ throws: true });
    const { app, dispatchWorkflow } = makeApp({ github });

    const { res, json } = await dispatch(app);

    expect(res.status).toBe(502);
    expect(json.error).toMatch(/could not read/);
    expect(dispatchWorkflow).not.toHaveBeenCalled();
  });

  it("refuses a pull request reached through the issues API", async () => {
    const github = fakeGithub({ isPr: true });
    const { app, dispatchWorkflow } = makeApp({ github });

    const { res, json } = await dispatch(app);

    expect(res.status).toBe(400);
    expect(json.error).toMatch(/is a pull request/);
    expect(dispatchWorkflow).not.toHaveBeenCalled();
  });

  it("reports 503 without a GitHub client or a runner", async () => {
    const { app } = makeApp({ github: null });
    const { res, json } = await dispatch(app);
    expect(res.status).toBe(503);
    expect(json.error).toMatch(/not configured/);
  });

  it("rejects a nonsense issue number", async () => {
    const { app } = makeApp({ github: fakeGithub() });
    const res = await app.fetch(
      new Request(`http://localhost/issues/${OWNER}/${NAME}/not-a-number/dispatch`, {
        method: "POST",
      }),
    );
    expect(res.status).toBe(400);
  });
});
