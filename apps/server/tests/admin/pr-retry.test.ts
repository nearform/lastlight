/**
 * `POST /prs/:owner/:repo/:number/retry` — the third retry surface
 * (03-retry-intervention.md, locked decision 11).
 *
 * These run against a real in-memory `StateDb` and the real gate, for the same
 * reason `tests/engine/pr-escalation.test.ts` does: the property under test is a
 * SEQUENCE through the actual transport — resolve the snapshot WITH the
 * intervention → `applyPrDispatchGate` → record or dispatch → read it back on
 * the next call. Faking the store would fake exactly the link that carries the
 * behaviour, and faking the gate would fake the two refusals that matter most
 * (the hold, and a run already owning the PR).
 *
 * Only two things are stubbed: GitHub (a hand-rolled client that remembers its
 * labels, so a second call sees what the first left behind) and the dispatch
 * itself (recorded, never run).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createAdminRoutes, type AdminConfig } from "#src/admin/routes.js";
import { StateDb } from "#src/state/db.js";
import type { SessionReader } from "#src/admin/sessions.js";
import type { GitHubClient } from "#src/engine/github/github.js";
import { createToken } from "#src/admin/auth.js";
import { prTriggerId, type PrState } from "#src/engine/pr-state.js";
import { HOLD_LABEL, REQUIRES_HUMAN_LABEL } from "#src/cron/dependabot-discovery.js";
import { setRuntimeConfig, resetRuntimeConfigForTests, type LastLightConfig } from "#src/config/config.js";

const OWNER = "acme";
const NAME = "widget";
const REPO = `${OWNER}/${NAME}`;
const PR = 190;
const TRIGGER = prTriggerId(REPO, PR);
const HEAD = "aaaa111bbbb222";
const BOT = "last-light[bot]";
const SECRET = "test-secret";

let db: StateDb;

/**
 * The reads `resolvePrState` makes, answered from a mutable fixture so a test
 * can move the head, add a label, or break the base branch. `labels` is a live
 * Set: the route's second call reads whatever the first left on it.
 */
function fakeGithub(over: Partial<{ headSha: string; baseChecks: string; prThrows: boolean }> = {}) {
  const labels = new Set<string>();
  const headSha = over.headSha ?? HEAD;
  const client = {
    labels,
    getPullRequest: vi.fn(async () => {
      if (over.prThrows) throw new Error("404 Not Found");
      return {
        number: PR,
        title: "Bump lodash from 4.17.20 to 4.17.21",
        body: "",
        draft: false,
        head: { sha: headSha, ref: "dependabot/npm/lodash-4.17.21", repo: { full_name: REPO } },
        base: { ref: "main", repo: { full_name: REPO } },
        labels: [...labels].map((name) => ({ name })),
      };
    }),
    getChecksSummary: vi.fn(async () => ({ state: "failing", settledCount: 3 })),
    getBaseChecksState: vi.fn(async () => over.baseChecks ?? "passing"),
    getLatestBotReview: vi.fn(async () => null),
    getBotReviewHistory: vi.fn(async () => ({ atHead: null, latest: null })),
    getChangedPathsBetween: vi.fn(async () => null),
    getCommitAuthorName: vi.fn(async () => "dependabot[bot]"),
    getCiFailureReport: vi.fn(async () => null),
    addLabels: vi.fn(async (_o: string, _r: string, _n: number, names: string[]) => {
      for (const l of names) labels.add(l);
    }),
    postComment: vi.fn(async () => 1),
  };
  return client as unknown as GitHubClient & typeof client;
}

function runtimeConfig(over: Record<string, unknown> = {}): LastLightConfig {
  return {
    stateDir: "/tmp",
    managedRepos: [REPO],
    botName: "last-light",
    botLogin: BOT,
    models: {},
    variants: {},
    disabled: { workflows: [], crons: [], prompts: [], skills: [], agentContext: [] },
    ...over,
  } as unknown as LastLightConfig;
}

/** The route under test, plus the dispatch spy every assertion reads. */
function makeApp(over: Partial<AdminConfig> = {}) {
  const dispatchWorkflow = vi.fn(async () => ({ success: true }));
  const app = createAdminRoutes(db, {} as unknown as SessionReader, {} as unknown as SessionReader, {
    stateDir: "/tmp",
    sessionsDir: "/tmp/sessions",
    // Auth OFF by default so the body of these tests doesn't mint a token; the
    // auth test below turns it on explicitly, which is the case that matters.
    adminPassword: "",
    adminSecret: SECRET,
    dispatchWorkflow,
    ...over,
  } as AdminConfig);
  return { app, dispatchWorkflow };
}

/** Every run row on this PR, newest first — the ledger the next dispatch folds from. */
function rowsForPr() {
  return db.runs.listRecent(50).filter((r) => r.triggerId === TRIGGER);
}

async function retry(
  app: ReturnType<typeof makeApp>["app"],
  body: Record<string, unknown> = {},
  init: RequestInit = {},
) {
  const res = await app.fetch(
    new Request(`http://localhost/prs/${OWNER}/${NAME}/${PR}/retry`, {
      method: "POST",
      headers: { "content-type": "application/json", ...(init.headers ?? {}) },
      body: JSON.stringify(body),
    }),
  );
  return { res, json: (await res.json()) as Record<string, any> };
}

/**
 * The state an escalated PR is left in: three attempts spent, then a run row
 * carrying `escalatedAtSha` — which is what makes the budget gate refuse, and
 * therefore what a retry has to move.
 */
function recordEscalation(workflowName = "dependabot-ci-fix"): void {
  const spent: PrState = {
    repo: REPO,
    prNumber: PR,
    headSha: HEAD,
    headAuthor: "dependabot[bot]",
    headIsOurs: false,
    headRef: "dependabot/npm/lodash-4.17.21",
    baseRef: "main",
    isDraft: false,
    isFork: false,
    headRepoFullName: REPO,
    labels: [REQUIRES_HUMAN_LABEL],
    title: "Bump lodash from 4.17.20 to 4.17.21",
    body: "",
    checksState: "failing",
    settledCheckCount: 3,
    baseChecksState: "passing",
    botReviewAtHead: null,
    ciReport: null,
    attempt: 4,
    flakyDeferrals: 0,
    escalatedAtSha: HEAD,
    intervention: null,
    forkNoticedAtSha: null,
    priorAttempts: ["attempt 3: class=reproducible cause=stale lockfile"],
    notes: [],
    priorDiagnosisClass: null,
    cumulativeCostUsd: 5.4,
    costBaselineUsd: 0,
    assessedHeadShaByWorkflow: {},
    runInFlight: null,
    readErrors: [],
  };
  db.runs.createRun({
    id: "run-escalated",
    workflowName,
    triggerId: TRIGGER,
    owner: OWNER,
    repo: NAME,
    issueNumber: PR,
    currentPhase: "escalated",
    status: "succeeded",
    context: { prState: spent },
    startedAt: "2020-01-01T00:00:01.000Z",
  });
}

beforeEach(() => {
  db = new StateDb(":memory:");
  setRuntimeConfig(runtimeConfig());
});

afterEach(() => resetRuntimeConfigForTests());

describe("POST /prs/:owner/:repo/:number/retry", () => {
  it("records the ask as an `api` intervention and re-dispatches the stuck workflow", async () => {
    recordEscalation();
    const github = fakeGithub();
    const { app, dispatchWorkflow } = makeApp({ github });

    const { res, json } = await retry(app);

    expect(res.status).toBe(200);
    expect(json).toMatchObject({
      repo: REPO,
      prNumber: PR,
      // "Go again" means the workflow that actually got stuck — read off the
      // PR's own history, not guessed from the PR's author.
      workflow: "dependabot-ci-fix",
      dispatched: true,
      retry: { via: "api", atSha: HEAD },
    });
    // Auth is off in this app, so there is no session login to attribute to.
    expect(json.retry.by).toBe("admin");

    // The dispatched run carries the ARMED snapshot — which is where the record
    // lives when a retry results in a run, so no standalone row is written.
    expect(dispatchWorkflow).toHaveBeenCalledTimes(1);
    const [workflow, context] = dispatchWorkflow.mock.calls[0] as unknown as [string, Record<string, any>];
    expect(workflow).toBe("dependabot-ci-fix");
    const state = context._prState as PrState;
    expect(state.intervention).toMatchObject({ via: "api", atSha: HEAD });
    // The whole point: the budgets moved, not just the guard.
    expect(state.attempt).toBe(1);
    expect(state.escalatedAtSha).toBeNull();
    expect(state.cumulativeCostUsd).toBe(0);
    // …and the journal survived, because nothing about the code changed.
    expect(state.priorAttempts.length).toBeGreaterThan(0);

    // Not re-escalated: no second `requires-human`, no second comment.
    expect(github.postComment).not.toHaveBeenCalled();
  });

  it("attributes the retry to the authenticated session", async () => {
    recordEscalation();
    const github = fakeGithub();
    const { app } = makeApp({ github, adminPassword: "pw" });

    const { res, json } = await retry(app, {}, {
      headers: { Authorization: `Bearer ${createToken(SECRET, "github", "alice")}` },
    });

    expect(res.status).toBe(200);
    expect(json.retry).toMatchObject({ via: "api", by: "alice" });
  });

  it("carries the free-text reason through as the record's `note`", async () => {
    recordEscalation();
    const github = fakeGithub();
    const { app, dispatchWorkflow } = makeApp({ github });

    const { json } = await retry(app, { reason: "arm64 runner was flaky" });

    expect(json.retry.note).toBe("arm64 runner was flaky");
    const [, context] = dispatchWorkflow.mock.calls[0] as unknown as [string, Record<string, any>];
    expect((context._prState as PrState).intervention?.note).toBe("arm64 runner was flaky");
  });

  it("sanitizes the reason rather than trusting it — a marker token is refused", async () => {
    // The note is replayed into a later prompt (the journal's seam line, and a
    // `PrNote`), so it may never carry a token the marker parser reads.
    recordEscalation();
    const github = fakeGithub();
    const { app } = makeApp({ github });

    const { json } = await retry(app, { reason: "class=flaky please skip" });

    expect(json.retry.note).toBeUndefined();
  });

  it("is idempotent at the same head — a second ask earns no second record", async () => {
    // The first retry dispatches, which (in production and here) leaves a live
    // run owning the PR. The second ask therefore loses the run lock, and the
    // lock deliberately records NOTHING: a row written under a live run would
    // displace that run's own snapshot as the history the next dispatch folds
    // from. One record per head, not one per ask.
    recordEscalation();
    const github = fakeGithub();
    // Model the dispatch honestly: a real one creates a running row, and that
    // row is what the second ask loses the lock to.
    const dispatchWorkflow = vi.fn(async (workflowName: string) => {
      db.runs.createRun({
        id: "run-retry",
        workflowName,
        triggerId: TRIGGER,
        owner: OWNER,
        repo: NAME,
        issueNumber: PR,
        currentPhase: "diagnose",
        status: "running",
        context: {},
        startedAt: new Date().toISOString(),
      });
      return { success: true };
    });
    const { app } = makeApp({ github, dispatchWorkflow });

    const first = await retry(app);
    expect(first.json.dispatched).toBe(true);

    const second = await retry(app);
    expect(second.res.status).toBe(409);
    expect(second.json).toMatchObject({ dispatched: false, recorded: false });
    expect(second.json.reason).toMatch(/run-in-flight/);

    expect(dispatchWorkflow).toHaveBeenCalledTimes(1);
    // Exactly one retry row across both asks — the escalation, the dispatched
    // run, and nothing else.
    expect(rowsForPr().filter((r) => r.currentPhase === "retry-requested")).toHaveLength(0);
  });

  it("records — but does not dispatch — when the gate skips for an unrelated reason", async () => {
    // `upstream-broken`: the base branch is red at the exact moment somebody
    // asks. The ask is real and the dispatch is not going to happen, so the
    // standalone row is what stops it evaporating.
    recordEscalation();
    const github = fakeGithub({ baseChecks: "failing" });
    const { app, dispatchWorkflow } = makeApp({ github });

    const { res, json } = await retry(app, { reason: "base is fixed on my machine" });

    expect(res.status).toBe(200);
    expect(json).toMatchObject({ dispatched: false, recorded: true });
    expect(json.reason).toMatch(/^upstream-broken:/);
    expect(dispatchWorkflow).not.toHaveBeenCalled();

    const row = rowsForPr().find((r) => r.currentPhase === "retry-requested");
    expect(row).toBeDefined();
    expect((row!.context as any).prState.intervention).toMatchObject({
      via: "api",
      by: "admin",
      note: "base is fixed on my machine",
    });
  });

  it("refuses on a held PR, and re-arms nothing", async () => {
    // Locked decision 4 — the hold beats an explicit ask outright, and is the
    // one case where "a maintainer asked and was not obeyed" is intentional,
    // which is why the reply is not optional.
    recordEscalation();
    const github = fakeGithub();
    github.labels.add(HOLD_LABEL);
    const { app, dispatchWorkflow } = makeApp({ github });

    const { res, json } = await retry(app);

    expect(res.status).toBe(409);
    expect(json).toMatchObject({ dispatched: false, recorded: false, held: HOLD_LABEL });
    expect(json.reason).toContain(HOLD_LABEL);
    expect(json.retry).toBeUndefined();
    expect(dispatchWorkflow).not.toHaveBeenCalled();
    // Nothing persisted — the next event must find the PR exactly as held as it
    // was before the ask.
    expect(rowsForPr().map((r) => r.currentPhase)).toEqual(["escalated"]);
  });

  it("refuses when the PR could not be read", async () => {
    recordEscalation();
    const github = fakeGithub({ prThrows: true });
    const { app, dispatchWorkflow } = makeApp({ github });

    const { res, json } = await retry(app);

    expect(res.status).toBe(409);
    expect(json).toMatchObject({ dispatched: false, recorded: false });
    expect(json.reason).toMatch(/^read-degraded:/);
    expect(dispatchWorkflow).not.toHaveBeenCalled();
  });

  it("refuses an unmanaged repo before reading anything", async () => {
    setRuntimeConfig(runtimeConfig({ managedRepos: ["acme/other"] }));
    const github = fakeGithub();
    const { app, dispatchWorkflow } = makeApp({ github });

    const { res, json } = await retry(app);

    expect(res.status).toBe(403);
    expect(json.error).toMatch(/not a managed repository/);
    expect(github.getPullRequest).not.toHaveBeenCalled();
    expect(dispatchWorkflow).not.toHaveBeenCalled();
  });

  it("refuses an unauthenticated caller", async () => {
    recordEscalation();
    const github = fakeGithub();
    const { app, dispatchWorkflow } = makeApp({ github, adminPassword: "pw" });

    const { res } = await retry(app);

    expect(res.status).toBe(401);
    expect(github.getPullRequest).not.toHaveBeenCalled();
    expect(dispatchWorkflow).not.toHaveBeenCalled();
  });

  it("reports 503 rather than acting on a snapshot made of defaults", async () => {
    recordEscalation();
    const { app } = makeApp({ github: null });
    const { res, json } = await retry(app);
    expect(res.status).toBe(503);
    expect(json.error).toMatch(/not configured/);
  });

  it("rejects a nonsense pull-request number", async () => {
    const { app } = makeApp({ github: fakeGithub() });
    const res = await app.fetch(
      new Request(`http://localhost/prs/${OWNER}/${NAME}/not-a-number/retry`, { method: "POST" }),
    );
    expect(res.status).toBe(400);
  });

  it("falls back to the configured pr_fix route for a PR we have never fixed", async () => {
    const github = fakeGithub();
    const { app, dispatchWorkflow } = makeApp({ github });

    const { json } = await retry(app);

    expect(json.workflow).toBe("pr-fix");
    expect(dispatchWorkflow).toHaveBeenCalledTimes(1);
  });
});
