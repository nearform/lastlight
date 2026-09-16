/**
 * `GET /board` — scope resolution, the query budget, and auth.
 *
 * Run against a real in-memory `StateDb` and the real builder, for the reason
 * `pr-retry.test.ts` gives: the properties under test are properties of the
 * WHOLE path — the scope narrowing feeds the GitHub read, which feeds the
 * trigger ids, which feed the run join. Faking any of those links would fake
 * the thing being measured. Only GitHub is stubbed, and it counts its calls.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createAdminRoutes, type AdminConfig } from "#src/admin/routes.js";
import type { StateDb } from "#src/state/db.js";
import type { SessionReader } from "#src/admin/sessions.js";
import type { GitHubClient, BoardItem, BoardRepoItems } from "#src/engine/github/github.js";
import { makeTestDb } from "../helpers/state-db.js";
import { createToken } from "#src/admin/auth.js";
import { resetBoardCacheForTests } from "#src/admin/board-cache.js";
import {
  setRuntimeConfig,
  resetRuntimeConfigForTests,
  type LastLightConfig,
} from "#src/config/config.js";

const OWNER = "acme";
const SECRET = "test-secret";
const REPOS = Array.from({ length: 30 }, (_, i) => `${OWNER}/repo-${String(i).padStart(2, "0")}`);

let db: StateDb;

const STAGES = {
  build: {
    enter: "ready-for-agent",
    running: "agent-building",
    on_success: "ready-for-human",
    on_failure: "agent-blocked",
    workflow: "build",
    gates: {},
    on_merge: "none" as const,
  },
};

function runtimeConfig(over: Record<string, unknown> = {}): LastLightConfig {
  return {
    stateDir: "/tmp",
    managedRepos: REPOS,
    botName: "last-light",
    botLogin: "last-light[bot]",
    holdLabel: "lastlight-ignore",
    models: {},
    variants: {},
    disabled: { workflows: [], crons: [], prompts: [], skills: [], agentContext: [] },
    // The board's universe is the AUTONOMY allow-list, not the managed list, so
    // these have to be opted in for any scope assertion below to mean anything.
    autonomy: { repos: REPOS, stages: STAGES, budget: {} },
    ...over,
  } as unknown as LastLightConfig;
}

function boardItem(repo: string, number: number, labels: string[]): BoardItem {
  return {
    repo,
    number,
    isPr: false,
    title: `Item ${number}`,
    url: `https://github.com/${repo}/issues/${number}`,
    author: "maintainer",
    createdAt: "2026-09-01T00:00:00.000Z",
    updatedAt: "2026-09-01T00:00:00.000Z",
    draft: false,
    labels: labels.map((name) => ({ name, color: "ededed" })),
  };
}

/** One `ready-for-agent` issue per repo, plus a call counter. */
function fakeGithub(perRepo = 1) {
  const listOpenBoardItems = vi.fn(async (owner: string, repos: string[]) => {
    const out = new Map<string, BoardRepoItems>();
    for (const repo of repos) {
      const key = `${owner}/${repo}`;
      out.set(key, {
        items: Array.from({ length: perRepo }, (_, i) => boardItem(key, i + 1, ["ready-for-agent"])),
      });
    }
    return out;
  });
  return { github: { listOpenBoardItems } as unknown as GitHubClient, listOpenBoardItems };
}

function makeApp(over: Partial<AdminConfig> = {}) {
  return createAdminRoutes(db, {} as unknown as SessionReader, {} as unknown as SessionReader, {
    stateDir: "/tmp",
    sessionsDir: "/tmp/sessions",
    adminPassword: "",
    adminSecret: SECRET,
    ...over,
  } as AdminConfig);
}

async function board(app: ReturnType<typeof makeApp>, query = "", init: RequestInit = {}) {
  const res = await app.fetch(new Request(`http://localhost/board${query}`, init));
  return { res, json: (await res.json()) as Record<string, any> };
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

describe("GET /board scope", () => {
  it("honours an explicit ?repos=, intersected with the managed list", async () => {
    const { github, listOpenBoardItems } = fakeGithub();
    const app = makeApp({ github });

    const { json } = await board(app, `?repos=${REPOS[0]},${REPOS[1]},evil/unmanaged`);

    expect(json.scope.repos).toEqual([REPOS[0], REPOS[1]]);
    expect(json.scope.truncated).toBe(false);
    // The unmanaged repo never reached GitHub.
    expect(listOpenBoardItems.mock.calls[0]![1]).toEqual(["repo-00", "repo-01"]);
  });

  it("reports the full allow-list as `scope.eligible`, whatever the current scope", async () => {
    // The dashboard's scope picker is built from this, not from `GET /repos`.
    // Fed from that larger "what does this deployment manage" answer, the
    // dropdown offered repos with no pipeline: picking one gave an empty board
    // and no reason why. So `eligible` has to be the ALLOW-LIST, independent of
    // how narrowly the caller has scoped the board right now.
    setRuntimeConfig(
      runtimeConfig({ autonomy: { repos: [REPOS[0], REPOS[1]], stages: STAGES, budget: {} } }),
    );
    const { github } = fakeGithub();
    const app = makeApp({ github });

    const { json } = await board(app, `?repos=${REPOS[0]}`);

    expect(json.scope.repos).toEqual([REPOS[0]]);
    expect(json.scope.eligible).toEqual([REPOS[0], REPOS[1]]);
  });

  it("excludes a MANAGED repo that is not on the autonomy allow-list", async () => {
    // The board is a view of ONE pipeline. A managed repo outside
    // `autonomy.repos` has no stage labels anybody writes and no `build` the
    // dispatch gate would admit — every card action on it answers
    // `409 not-autonomous` — so rendering it would show columns and menus for
    // work that structurally cannot run.
    setRuntimeConfig(runtimeConfig({ autonomy: { repos: [REPOS[0]], stages: STAGES, budget: {} } }));
    const { github, listOpenBoardItems } = fakeGithub();
    const app = makeApp({ github });

    const { json } = await board(app, `?repos=${REPOS[0]},${REPOS[1]}`);

    expect(json.scope.repos).toEqual([REPOS[0]]);
    // …and the excluded one never cost a GitHub read, which is half the point.
    expect(listOpenBoardItems.mock.calls[0]![1]).toEqual(["repo-00"]);
  });

  it("serves an empty board — and touches GitHub not at all — when nothing is opted in", async () => {
    // `autonomy.repos: []` is the SHIPPED default, so this is what a fresh
    // install sees. It must read as un-opted-in rather than as broken.
    setRuntimeConfig(runtimeConfig({ autonomy: { repos: [], stages: STAGES, budget: {} } }));
    const { github, listOpenBoardItems } = fakeGithub();
    const app = makeApp({ github });

    const { json } = await board(app);

    expect(json.scope.repos).toEqual([]);
    expect(json.scope.reason).toContain("no repos are on the autonomy allow-list");
    // Stages ARE configured, so the columns still stand — an empty board with
    // its stages visible says "nothing opted in", where no columns would say
    // "nothing configured", which is a different problem.
    expect(json.configured).toBe(true);
    expect(json.columns.length).toBeGreaterThan(0);
    expect(listOpenBoardItems).not.toHaveBeenCalled();
  });

  it("orders the allow-list by activity — and still shows a repo that has never run", async () => {
    // The allow-list IS the board's universe; activity only ORDERS it. Scoping
    // to "repos with runs" would hide a repo opted into `autonomy.repos` this
    // morning on the one day somebody most wants to watch it start.
    for (const [i, repo] of [REPOS[5], REPOS[6]].entries()) {
      await db.runs.createRun({
        id: `run-${i}`,
        workflowName: "build",
        triggerId: `${repo}#1`,
        owner: OWNER,
        repo: repo!.split("/")[1],
        issueNumber: 1,
        currentPhase: "architect",
        status: "running",
        startedAt: new Date(2026, 0, 1 + i).toISOString(),
      });
    }
    const { github } = fakeGithub();
    const app = makeApp({ github });

    const { json } = await board(app);

    // Newest-first: repo-06's run is a day later than repo-05's.
    expect(json.scope.repos[0]).toBe(REPOS[6]);
    expect(json.scope.repos[1]).toBe(REPOS[5]);
    // …and the rest of the allow-list follows, runs or no runs.
    expect(json.scope.repos).toContain(REPOS[0]);
    expect(json.scope.reason).toContain("autonomy allow-list");
  });

  it("TRUNCATES past MAX_BOARD_REPOS rather than refusing — and says how many", async () => {
    const { github, listOpenBoardItems } = fakeGithub();
    const app = makeApp({ github });

    const { res, json } = await board(app, `?repos=${REPOS.join(",")}`);

    expect(res.status).toBe(200);
    expect(json.scope.repos).toHaveLength(20);
    expect(json.scope.truncated).toBe(true);
    expect(json.scope.reason).toContain("showing 20 of 30");
    // Twenty repos, ten per document: two requests, not twenty.
    expect(listOpenBoardItems).toHaveBeenCalledTimes(1);
    expect(listOpenBoardItems.mock.calls[0]![1]).toHaveLength(20);
  });
});

describe("GET /board projection", () => {
  it("joins runs and approvals in a fixed number of queries, whatever the card count", async () => {
    const { github } = fakeGithub(25);
    const app = makeApp({ github });
    const latestForTriggers = vi.spyOn(db.runs, "latestForTriggers");
    const listPending = vi.spyOn(db.approvals, "listPending");
    const getRun = vi.spyOn(db.runs, "getRun");
    const failureReasons = vi.spyOn(db.executions, "failureReasonsForRuns");
    const inFlight = vi.spyOn(db.executions, "inFlightPhasesForRuns");

    const { json } = await board(app, `?repos=${REPOS[0]},${REPOS[1]}`);

    expect(json.columns[0].count).toBe(50);
    // The no-N+1 property, stated as a count: ONE run query, ONE approval
    // query, and never a per-card read.
    expect(latestForTriggers).toHaveBeenCalledTimes(1);
    expect(latestForTriggers.mock.calls[0]![0]).toHaveLength(50);
    expect(listPending).toHaveBeenCalledTimes(1);
    expect(getRun).not.toHaveBeenCalled();
    // The FOURTH query is conditional: nothing here failed, so the ledger is
    // not read at all. A board with no failures must pay nothing for the
    // feature existing.
    expect(failureReasons).not.toHaveBeenCalled();
    // The fifth is conditional on the same terms: no card here has a live run.
    expect(inFlight).not.toHaveBeenCalled();
  });

  it("reads the ledger for the LIVE cards, and shows the phase actually running", async () => {
    // `current_phase` says `architect` because that is the last phase that
    // COMPLETED. The card must not repeat that while the executor is running.
    await db.runs.createRun({
      id: "run-live",
      workflowName: "build",
      triggerId: `${REPOS[0]}#1`,
      owner: OWNER,
      repo: "repo-00",
      issueNumber: 1,
      currentPhase: "architect",
      status: "running",
      startedAt: "2026-09-02T00:00:00.000Z",
    });
    const { github } = fakeGithub();
    const app = makeApp({ github });
    const inFlight = vi
      .spyOn(db.executions, "inFlightPhasesForRuns")
      .mockResolvedValue(new Map([["run-live", "build:executor"]]));

    const { json } = await board(app, `?repos=${REPOS[0]}`);

    expect(inFlight).toHaveBeenCalledTimes(1);
    expect(inFlight.mock.calls[0]![0]).toEqual(["run-live"]);
    const card = json.columns[0].cards[0];
    expect(card.run.phase).toBe("executor");
    expect(card.run.currentPhase).toBe("architect");
  });

  it("reads the ledger ONCE for the failed cards, and renders the reason", async () => {
    // `workflow_runs` has no error column, so a FAILED band's explanation comes
    // from the ledger row of the phase that stopped it. The join is by RUN id,
    // not trigger id — the one place on this route where that distinction bites.
    await db.runs.createRun({
      id: "run-bad",
      workflowName: "build",
      triggerId: `${REPOS[0]}#1`,
      owner: OWNER,
      repo: "repo-00",
      issueNumber: 1,
      currentPhase: "guardrails_gate",
      status: "failed",
      startedAt: "2026-09-02T00:00:00.000Z",
    });
    const { github } = fakeGithub();
    const app = makeApp({ github });
    const failureReasons = vi
      .spyOn(db.executions, "failureReasonsForRuns")
      .mockResolvedValue(
        new Map([
          ["run-bad", { phase: "build:guardrails_gate", error: "Guardrails check: BLOCKED" }],
        ]),
      );

    const { json } = await board(app, `?repos=${REPOS[0]}`);

    expect(failureReasons).toHaveBeenCalledTimes(1);
    expect(failureReasons.mock.calls[0]![0]).toEqual(["run-bad"]);
    const card = json.columns[0].cards[0];
    expect(card.run).toMatchObject({ id: "run-bad", status: "failed" });
    // The workflow prefix is stripped — the card already says which workflow.
    expect(card.run.failure).toEqual({
      phase: "guardrails_gate",
      reason: "Guardrails check: BLOCKED",
    });
  });

  it("joins a card to its run by the `owner/repo#N` trigger id", async () => {
    await db.runs.createRun({
      id: "run-live",
      workflowName: "build",
      triggerId: `${REPOS[0]}#1`,
      owner: OWNER,
      repo: "repo-00",
      issueNumber: 1,
      currentPhase: "architect",
      status: "paused",
      startedAt: "2026-09-02T00:00:00.000Z",
    });
    await db.approvals.create({
      id: "appr-1",
      workflowRunId: "run-live",
      gate: "post_architect",
      summary: "Plan ready",
      createdAt: "2026-09-02T01:00:00.000Z",
    });
    const { github } = fakeGithub();
    const app = makeApp({ github });

    const { json } = await board(app, `?repos=${REPOS[0]}`);

    const card = json.columns[0].cards[0];
    expect(card.key).toBe(`${REPOS[0]}#1`);
    expect(card.run).toMatchObject({ id: "run-live", status: "paused" });
    expect(card.approval).toMatchObject({ gate: "post_architect" });
    expect(json.columns[0].awaitingHumanCount).toBe(1);
  });

  it("reports configured:false and spends NOTHING at GitHub with no stages", async () => {
    setRuntimeConfig(runtimeConfig({ autonomy: { repos: [], stages: {}, budget: {} } }));
    const { github, listOpenBoardItems } = fakeGithub();
    const app = makeApp({ github });

    const { json } = await board(app, `?repos=${REPOS[0]}`);

    expect(json.configured).toBe(false);
    expect(json.columns).toEqual([]);
    expect(listOpenBoardItems).not.toHaveBeenCalled();
  });

  it("surfaces a per-repo failure as `degraded` and still serves its neighbours", async () => {
    const listOpenBoardItems = vi.fn(async (owner: string, repos: string[]) => {
      const out = new Map<string, BoardRepoItems>();
      for (const repo of repos) {
        const key = `${owner}/${repo}`;
        out.set(
          key,
          repo === "repo-01"
            ? { items: [], error: "404 Not Found" }
            : { items: [boardItem(key, 1, ["ready-for-agent"])] },
        );
      }
      return out;
    });
    const app = makeApp({ github: { listOpenBoardItems } as unknown as GitHubClient });

    const { json } = await board(app, `?repos=${REPOS[0]},${REPOS[1]}`);

    expect(json.columns[0].count).toBe(1);
    expect(json.degraded).toEqual([
      expect.objectContaining({ repo: REPOS[1], error: "404 Not Found" }),
    ]);
  });

  it("omits the unstaged bucket unless asked", async () => {
    const listOpenBoardItems = vi.fn(async (owner: string, repos: string[]) =>
      new Map<string, BoardRepoItems>(
        repos.map((repo) => [`${owner}/${repo}`, { items: [boardItem(`${owner}/${repo}`, 9, ["bug"])] }]),
      ),
    );
    const app = makeApp({ github: { listOpenBoardItems } as unknown as GitHubClient });

    const plain = await board(app, `?repos=${REPOS[0]}`);
    expect(plain.json.unstaged).toBeUndefined();

    const asked = await board(app, `?repos=${REPOS[0]}&unstaged=1`);
    expect(asked.json.unstaged).toMatchObject({ count: 1 });
  });
});

describe("GET /board auth", () => {
  it("is gated like its neighbours", async () => {
    const { github } = fakeGithub();
    const app = makeApp({ github, adminPassword: "hunter2" });

    const denied = await board(app, `?repos=${REPOS[0]}`);
    expect(denied.res.status).toBe(401);

    const token = createToken(SECRET);
    const allowed = await board(app, `?repos=${REPOS[0]}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(allowed.res.status).toBe(200);
  });
});
