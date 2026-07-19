import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { randomUUID } from "crypto";
import { StateDb } from "#src/state/db.js";
import { migrate } from "#src/state/migrate.js";
import { ApprovalStore } from "#src/state/approval-store.js";
import { WorkflowRunStore } from "#src/state/workflow-run-store.js";

let db: StateDb;

beforeEach(() => {
  db = new StateDb(":memory:");
});

afterEach(() => {
  db.close();
});

/** Create a fresh run and return its id. */
function makeRun(overrides: Partial<Parameters<WorkflowRunStore["createRun"]>[0]> = {}): string {
  const id = randomUUID();
  db.runs.createRun({
    id,
    workflowName: "explore",
    triggerId: `slack:${id}`,
    currentPhase: "socratic",
    status: "running",
    startedAt: new Date().toISOString(),
    ...overrides,
  });
  return id;
}

describe("pauseForApproval", () => {
  it("creates the approval, appends the marker, merges scratch, and pauses — in one step", () => {
    const runId = makeRun();
    const approvalId = randomUUID();
    db.runs.pauseForApproval(
      runId,
      {
        id: approvalId,
        workflowRunId: runId,
        gate: "post_architect",
        summary: "Plan ready",
        kind: "approve",
        artifact: "architect-plan.md",
        createdAt: new Date().toISOString(),
      },
      { phase: "waiting_approval", summary: "Waiting for approval: post_architect" },
      { socratic: { iteration: 2 } },
    );

    const run = db.runs.getRun(runId);
    expect(run!.status).toBe("paused");
    expect(run!.currentPhase).toBe("waiting_approval");
    expect(run!.phaseHistory.at(-1)!.phase).toBe("waiting_approval");
    expect(run!.scratch).toEqual({ socratic: { iteration: 2 } });

    const approval = db.approvals.getById(approvalId);
    expect(approval!.status).toBe("pending");
    expect(approval!.gate).toBe("post_architect");
    expect(approval!.artifact).toBe("architect-plan.md");
  });

  it("rolls back the phase-history append when the approval store throws (injected collaborator)", () => {
    // Build a store stack on a raw shared connection so we can inject a fake
    // ApprovalStore whose create() throws as the last txn step.
    const raw = new Database(":memory:");
    migrate(raw);
    const realApprovals = new ApprovalStore(raw);
    const seed = new WorkflowRunStore(raw, { approvals: realApprovals });
    const runId = randomUUID();
    seed.createRun({
      id: runId,
      workflowName: "build",
      triggerId: "owner/repo#1",
      currentPhase: "architect",
      status: "running",
      startedAt: new Date().toISOString(),
    });

    const throwingApprovals = {
      create() {
        throw new Error("approval insert failed");
      },
    } as unknown as ApprovalStore;
    const runs = new WorkflowRunStore(raw, { approvals: throwingApprovals });

    expect(() =>
      runs.pauseForApproval(
        runId,
        {
          id: randomUUID(),
          workflowRunId: runId,
          gate: "post_architect",
          summary: "Plan ready",
          createdAt: new Date().toISOString(),
        },
        { phase: "waiting_approval" },
      ),
    ).toThrow("approval insert failed");

    // The appendPhase that ran before the throwing collaborator must be rolled
    // back: the run is still running with empty phase history.
    const run = seed.getRun(runId);
    expect(run!.status).toBe("running");
    expect(run!.phaseHistory).toEqual([]);
    raw.close();
  });
});

describe("finishRun with a terminal marker", () => {
  it("appends the on_success phase marker and flips status in one step", () => {
    const runId = makeRun();
    db.runs.finishRun(runId, "succeeded", { terminalMarker: { phase: "done", summary: "PR #5" } });

    const run = db.runs.getRun(runId);
    expect(run!.status).toBe("succeeded");
    expect(run!.finishedAt).toBeTruthy();
    expect(run!.currentPhase).toBe("done");
    const last = run!.phaseHistory.at(-1)!;
    expect(last.phase).toBe("done");
    expect(last.summary).toBe("PR #5");
    expect(last.success).toBe(true);
  });

  it("plain finish (no marker) flips status without touching phase history", () => {
    const runId = makeRun();
    db.runs.finishRun(runId, "failed", { error: "boom" });

    const run = db.runs.getRun(runId);
    expect(run!.status).toBe("failed");
    expect(run!.phaseHistory).toEqual([]);
    expect(run!.context).toEqual({ error: "boom" });
  });
});

describe("resolveGateAndResume — approve path", () => {
  it("approves the gate and sets the run running, returning the run", () => {
    const runId = makeRun({ status: "paused" });
    const approvalId = randomUUID();
    db.approvals.create({
      id: approvalId,
      workflowRunId: runId,
      gate: "post_architect",
      summary: "Plan ready",
      createdAt: new Date().toISOString(),
    });

    const run = db.runs.resolveGateAndResume(approvalId, "bob");

    expect(run!.id).toBe(runId);
    expect(run!.status).toBe("running");
    const approval = db.approvals.getById(approvalId);
    expect(approval!.status).toBe("approved");
    expect(approval!.respondedBy).toBe("bob");
  });

  it("throws on an unknown approval id", () => {
    expect(() => db.runs.resolveGateAndResume("no-such-approval", "bob")).toThrow();
  });

  it("does not resume a stale approval that was already resolved", () => {
    const runId = makeRun({ status: "paused" });
    const approvalId = randomUUID();
    db.approvals.create({
      id: approvalId,
      workflowRunId: runId,
      gate: "post_architect",
      summary: "Plan ready",
      createdAt: new Date().toISOString(),
    });

    db.runs.resolveGateAndFail(approvalId, "carol", "plan incomplete");

    expect(() => db.runs.resolveGateAndResume(approvalId, "bob")).toThrow("not pending");
    expect(db.runs.getRun(runId)!.status).toBe("failed");
    expect(db.approvals.getById(approvalId)!.status).toBe("rejected");
  });
});

describe("resolveGateAndFail — reject path", () => {
  it("does not fail a stale approval that was already approved", () => {
    const runId = makeRun({ status: "paused" });
    const approvalId = randomUUID();
    db.approvals.create({
      id: approvalId,
      workflowRunId: runId,
      gate: "post_architect",
      summary: "Plan ready",
      createdAt: new Date().toISOString(),
    });

    db.runs.resolveGateAndResume(approvalId, "bob");

    expect(() => db.runs.resolveGateAndFail(approvalId, "carol", "too late")).toThrow("not pending");
    expect(db.runs.getRun(runId)!.status).toBe("running");
    expect(db.approvals.getById(approvalId)!.status).toBe("approved");
  });

  it("rejects the gate and fails the run", () => {
    const runId = makeRun({ status: "paused" });
    const approvalId = randomUUID();
    db.approvals.create({
      id: approvalId,
      workflowRunId: runId,
      gate: "post_architect",
      summary: "Plan ready",
      createdAt: new Date().toISOString(),
    });

    const run = db.runs.resolveGateAndFail(approvalId, "carol", "plan incomplete");

    expect(run!.id).toBe(runId);
    expect(run!.status).toBe("failed");
    const approval = db.approvals.getById(approvalId);
    expect(approval!.status).toBe("rejected");
    expect(approval!.respondedBy).toBe("carol");
    expect(approval!.response).toBe("plan incomplete");
    expect(db.runs.getRun(runId)!.context).toEqual({ error: "Rejected: plan incomplete" });
  });

  it("records a fallback error annotation when rejection has no reason", () => {
    const runId = makeRun({ status: "paused" });
    const approvalId = randomUUID();
    db.approvals.create({
      id: approvalId,
      workflowRunId: runId,
      gate: "post_architect",
      summary: "Plan ready",
      createdAt: new Date().toISOString(),
    });

    const run = db.runs.resolveGateAndFail(approvalId, "carol");

    expect(run!.status).toBe("failed");
    expect(run!.context).toEqual({ error: "Rejected: no reason given" });
  });
});

describe("resolveReplyGateAndResume — the socratic explore-reply atomic op", () => {
  it("resolves the reply gate, merges scratch, and sets the run running in one step", () => {
    const runId = makeRun({ status: "paused" });
    const approvalId = randomUUID();
    db.approvals.create({
      id: approvalId,
      workflowRunId: runId,
      gate: "socratic_1",
      summary: "What problem are we solving?",
      kind: "reply",
      createdAt: new Date().toISOString(),
    });

    const scratchPatch = { socratic: { qa: [{ question: "Q1", answer: "A1" }] } };
    const run = db.runs.resolveReplyGateAndResume(runId, approvalId, "A1", "alice", scratchPatch);

    // Returns the resumed run
    expect(run).not.toBeNull();
    expect(run!.id).toBe(runId);
    expect(run!.status).toBe("running");

    // Gate resolved with the reply text recorded
    const approval = db.approvals.getById(approvalId);
    expect(approval!.status).toBe("approved");
    expect(approval!.response).toBe("A1");
    expect(approval!.respondedBy).toBe("alice");

    // Scratch merged
    const reloaded = db.runs.getRun(runId);
    expect(reloaded!.status).toBe("running");
    expect(reloaded!.scratch).toEqual(scratchPatch);
  });

  it("double-reply concurrency guard: a second resolve throws and leaves the run paused", () => {
    const runId = makeRun({ status: "paused" });
    const approvalId = randomUUID();
    db.approvals.create({
      id: approvalId,
      workflowRunId: runId,
      gate: "socratic_1",
      summary: "Q",
      kind: "reply",
      createdAt: new Date().toISOString(),
    });

    db.runs.resolveReplyGateAndResume(runId, approvalId, "first", "alice", {});
    db.runs.setPaused(runId); // pretend it paused again on the next iteration

    // A racing second reply against the already-resolved gate must not resume.
    expect(() =>
      db.runs.resolveReplyGateAndResume(runId, approvalId, "second", "bob", {}),
    ).toThrow();
    expect(db.runs.getRun(runId)!.status).toBe("paused");
  });

  it("rolls back the gate resolution when the scratch patch is not serializable", () => {
    const runId = makeRun({ status: "paused" });
    const approvalId = randomUUID();
    db.approvals.create({
      id: approvalId,
      workflowRunId: runId,
      gate: "socratic_1",
      summary: "Q",
      kind: "reply",
      createdAt: new Date().toISOString(),
    });

    // A BigInt makes JSON.stringify throw mid-transaction (natural poison input).
    const poison = { socratic: { n: BigInt(1) } } as unknown as Record<string, unknown>;
    expect(() =>
      db.runs.resolveReplyGateAndResume(runId, approvalId, "A1", "alice", poison),
    ).toThrow();

    // Nothing applied: gate still pending, run still paused, scratch untouched.
    expect(db.approvals.getById(approvalId)!.status).toBe("pending");
    const reloaded = db.runs.getRun(runId);
    expect(reloaded!.status).toBe("paused");
    expect(reloaded!.scratch).toBeUndefined();
  });
});

describe("restartRun — retry a failed run", () => {
  it("flips failed→running, clears finished_at and context.error, bumps restart_count", () => {
    const runId = makeRun();
    // Simulate a failed run: finishRun writes status, finished_at and the
    // context.error annotation.
    db.runs.finishRun(runId, "failed", { error: "boom" });
    const failed = db.runs.getRun(runId)!;
    expect(failed.status).toBe("failed");
    expect(failed.finishedAt).toBeTruthy();
    expect(failed.context).toEqual({ error: "boom" });

    const changed = db.runs.restartRun(runId);
    expect(changed).toBe(1);

    const restarted = db.runs.getRun(runId)!;
    expect(restarted.status).toBe("running");
    expect(restarted.finishedAt).toBeFalsy();
    // The stale error annotation is gone so the row no longer reads "failed at".
    expect(restarted.context).toEqual({});
    expect(restarted.restartCount).toBe(1);
  });

  it("preserves context (taskId, branch) and scratch across the restart", () => {
    const runId = makeRun({
      context: { taskId: "acme-1-explore-abcd1234", branch: "lastlight/1-foo", owner: "acme" },
      scratch: { socratic: { qa: [{ question: "Q1", answer: "A1" }] } },
    });
    db.runs.finishRun(runId, "failed", { error: "read_context crashed" });

    expect(db.runs.restartRun(runId)).toBe(1);

    const restarted = db.runs.getRun(runId)!;
    expect(restarted.context).toEqual({
      taskId: "acme-1-explore-abcd1234",
      branch: "lastlight/1-foo",
      owner: "acme",
    });
    expect(restarted.scratch).toEqual({ socratic: { qa: [{ question: "Q1", answer: "A1" }] } });
  });

  it("is a compare-and-set: a non-failed run is not restarted (0 rows changed)", () => {
    // A running run — the concurrency guard: a second retry click after the
    // first already flipped it to running must not re-dispatch.
    const runId = makeRun({ status: "running" });
    expect(db.runs.restartRun(runId)).toBe(0);
    expect(db.runs.getRun(runId)!.status).toBe("running");

    // A succeeded run is likewise untouched.
    const doneId = makeRun({ status: "succeeded" });
    expect(db.runs.restartRun(doneId)).toBe(0);
    expect(db.runs.getRun(doneId)!.status).toBe("succeeded");
  });
});

describe("hasRunForTrigger", () => {
  it("returns true for a build run regardless of status", () => {
    makeRun({ workflowName: "build", triggerId: "acme/widgets#14", status: "succeeded" });
    expect(db.runs.hasRunForTrigger("acme/widgets#14", "build")).toBe(true);
  });

  it("returns true for a running build (mid-flight)", () => {
    makeRun({ workflowName: "build", triggerId: "acme/widgets#15", status: "running" });
    expect(db.runs.hasRunForTrigger("acme/widgets#15", "build")).toBe(true);
  });

  it("returns false when no run exists for the trigger", () => {
    expect(db.runs.hasRunForTrigger("acme/widgets#99", "build")).toBe(false);
  });

  it("returns false for a different workflow name on the same trigger", () => {
    makeRun({ workflowName: "issue-triage", triggerId: "acme/widgets#16", status: "succeeded" });
    expect(db.runs.hasRunForTrigger("acme/widgets#16", "build")).toBe(false);
  });
});

// ── New methods for #172 concurrency cap ──────────────────────────────────

describe("countRunning", () => {
  it("counts only running runs, excludes queued and paused", () => {
    makeRun({ status: "running" });
    makeRun({ status: "running" });
    makeRun({ status: "queued" });
    makeRun({ status: "paused" });
    makeRun({ status: "succeeded" });
    expect(db.runs.countRunning()).toBe(2);
  });

  it("returns 0 when no running runs", () => {
    makeRun({ status: "queued" });
    expect(db.runs.countRunning()).toBe(0);
  });
});

describe("listQueued", () => {
  it("returns queued runs ordered by started_at ascending (FIFO)", () => {
    const id1 = makeRun({ status: "queued", startedAt: "2024-01-01T00:00:00.000Z" });
    const id2 = makeRun({ status: "queued", startedAt: "2024-01-01T00:01:00.000Z" });
    const id3 = makeRun({ status: "queued", startedAt: "2024-01-01T00:02:00.000Z" });
    makeRun({ status: "running" }); // not queued — excluded
    const queued = db.runs.listQueued();
    expect(queued.map((r) => r.id)).toEqual([id1, id2, id3]);
  });

  it("returns empty array when no queued runs", () => {
    makeRun({ status: "running" });
    expect(db.runs.listQueued()).toHaveLength(0);
  });
});

describe("admitRun", () => {
  it("returns 1 and sets status to running when run is queued", () => {
    const id = makeRun({ status: "queued" });
    const changes = db.runs.admitRun(id);
    expect(changes).toBe(1);
    expect(db.runs.getRun(id)!.status).toBe("running");
  });

  it("returns 0 (CAS) when run is already running — prevents double-admit", () => {
    const id = makeRun({ status: "queued" });
    db.runs.admitRun(id); // first admit wins
    const changes = db.runs.admitRun(id); // second is a no-op
    expect(changes).toBe(0);
    expect(db.runs.getRun(id)!.status).toBe("running");
  });

  it("returns 0 when run does not exist", () => {
    expect(db.runs.admitRun("nonexistent-id")).toBe(0);
  });

  it("does not touch started_at or restart_count", () => {
    const startedAt = "2024-01-01T00:00:00.000Z";
    const id = makeRun({ status: "queued", startedAt });
    db.runs.admitRun(id);
    const run = db.runs.getRun(id)!;
    expect(run.startedAt).toBe(startedAt);
    expect(run.restartCount ?? 0).toBe(0);
  });
});

describe("expireQueued", () => {
  it("transitions queued → cancelled and records the reason", () => {
    const id = makeRun({ status: "queued" });
    const changes = db.runs.expireQueued(id, "dropped from queue after waiting too long");
    expect(changes).toBe(1);
    const run = db.runs.getRun(id)!;
    expect(run.status).toBe("cancelled");
    expect(run.context?.error).toBe("dropped from queue after waiting too long");
    expect(run.finishedAt).toBeTruthy();
  });

  it("returns 0 when run is not queued (CAS guard)", () => {
    const id = makeRun({ status: "running" });
    expect(db.runs.expireQueued(id, "reason")).toBe(0);
    expect(db.runs.getRun(id)!.status).toBe("running");
  });

  it("returns 0 when run does not exist", () => {
    expect(db.runs.expireQueued("no-such-id", "reason")).toBe(0);
  });
});

describe("getByTrigger includes queued", () => {
  it("returns a queued run for the trigger", () => {
    const id = makeRun({ status: "queued", triggerId: "acme/repo#42" });
    const run = db.runs.getByTrigger("acme/repo#42");
    expect(run).not.toBeNull();
    expect(run!.id).toBe(id);
    expect(run!.status).toBe("queued");
  });

  it("returns running run over older queued run", () => {
    makeRun({ status: "queued", triggerId: "acme/repo#43", startedAt: "2024-01-01T00:00:00.000Z" });
    const runId = makeRun({ status: "running", triggerId: "acme/repo#43", startedAt: "2024-01-01T00:01:00.000Z" });
    const run = db.runs.getByTrigger("acme/repo#43");
    expect(run!.id).toBe(runId);
  });
});

describe("listActive includes queued", () => {
  it("includes queued, running, and paused runs", () => {
    const q = makeRun({ status: "queued" });
    const r = makeRun({ status: "running" });
    const p = makeRun({ status: "paused" });
    makeRun({ status: "succeeded" });
    makeRun({ status: "failed" });
    const active = db.runs.listActive();
    const ids = active.map((x) => x.id);
    expect(ids).toContain(q);
    expect(ids).toContain(r);
    expect(ids).toContain(p);
    expect(active).toHaveLength(3);
  });
});

describe("repo-scoped queries", () => {
  it("list({ repo }) returns only that repo's runs, with the post-filter total", () => {
    makeRun({ repo: "acme/api" });
    makeRun({ repo: "acme/api" });
    makeRun({ repo: "acme/web" });
    makeRun({ repo: undefined }); // repo-less run must not leak in

    const { runs, total } = db.runs.list({ repo: "acme/api" });
    expect(total).toBe(2);
    expect(runs).toHaveLength(2);
    expect(runs.every((r) => r.repo === "acme/api")).toBe(true);

    // The filter composes with pagination.
    const page = db.runs.list({ repo: "acme/api", limit: 1 });
    expect(page.total).toBe(2);
    expect(page.runs).toHaveLength(1);
  });

  it("distinctRepos() groups by repo with run counts, newest activity first", () => {
    makeRun({ repo: "acme/web", startedAt: "2026-01-01T00:00:00.000Z" });
    makeRun({ repo: "acme/api", startedAt: "2026-02-01T00:00:00.000Z" });
    makeRun({ repo: "acme/api", startedAt: "2026-03-01T00:00:00.000Z" });
    makeRun({ repo: undefined }); // excluded — no repo

    const repos = db.runs.distinctRepos();
    expect(repos.map((r) => r.repo)).toEqual(["acme/api", "acme/web"]);
    const api = repos.find((r) => r.repo === "acme/api")!;
    expect(api.runCount).toBe(2);
    expect(api.lastRunAt).toBe("2026-03-01T00:00:00.000Z");
  });

  it("distinctRepos() qualifies a bare repo with its owner column", () => {
    // The real create path stores repo BARE + owner separately; distinctRepos
    // must recompose `owner/repo` so it aligns with managedRepos / artifact
    // slugs in the /repos union (no bare-vs-qualified duplicate rows).
    makeRun({ owner: "nearform", repo: "drizzle-cube-help", startedAt: "2026-04-01T00:00:00.000Z" });
    const repos = db.runs.distinctRepos();
    expect(repos.map((r) => r.repo)).toContain("nearform/drizzle-cube-help");
  });

  it("owner round-trips through create → list, and the list filter accepts owner/repo", () => {
    makeRun({ owner: "nearform", repo: "lastlight-flue", issueNumber: 2 });
    makeRun({ owner: "other", repo: "lastlight-flue" }); // same bare repo, different owner

    // owner surfaces on the list payload (which omits `context`).
    const all = db.runs.list();
    const flue = all.runs.find((r) => r.owner === "nearform" && r.repo === "lastlight-flue");
    expect(flue).toBeTruthy();

    // A qualified filter matches only the right owner; a bare filter matches both.
    expect(db.runs.list({ repo: "nearform/lastlight-flue" }).total).toBe(1);
    expect(db.runs.list({ repo: "lastlight-flue" }).total).toBe(2);
  });
});

describe("migrate() owner backfill", () => {
  it("backfills owner from context.owner for pre-migration rows", () => {
    // Simulate an old DB: a row whose owner lives only in the context JSON.
    const raw = new Database(":memory:");
    migrate(raw);
    raw.exec(`ALTER TABLE workflow_runs DROP COLUMN owner`);
    raw
      .prepare(
        `INSERT INTO workflow_runs (id, workflow_name, trigger_id, repo, current_phase, status, context, started_at, updated_at)
         VALUES ('r1', 'build', 'nearform/lastlight#1', 'lastlight', 'phase_0', 'succeeded', ?, '2026-01-01', '2026-01-01')`,
      )
      .run(JSON.stringify({ owner: "nearform" }));

    // Re-running migrate() adds the column and backfills from context.owner.
    migrate(raw);
    const row = raw.prepare(`SELECT owner FROM workflow_runs WHERE id = 'r1'`).get() as {
      owner: string | null;
    };
    expect(row.owner).toBe("nearform");
    raw.close();
  });
});
