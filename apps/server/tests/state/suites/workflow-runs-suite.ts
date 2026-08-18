/**
 * `WorkflowRunStore` — CRUD, the queue lifecycle, the repo-scoped reads, the
 * five named atomic ops and the terminal-transition observer.
 *
 * Bodies moved verbatim from the pre-Phase-3 `tests/state/db.test.ts` and
 * `tests/state/workflow-run-store.test.ts`. The one test those files held that
 * is genuinely sqlite-only — the boot compat step's `owner` backfill, which
 * drives `applyLegacySqliteCompat` over a raw libsql handle — lives in
 * `tests/state/repo-normalization.test.ts` instead.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { randomUUID } from "crypto";
import { sql } from "drizzle-orm";
import type { StateDb } from "#src/state/db.js";
import { makeOpSerializer } from "#src/state/client.js";
import { run as runSql } from "#src/state/dialect.js";
import type { ApprovalStore } from "#src/state/approval-store.js";
import { WorkflowRunStore } from "#src/state/workflow-run-store.js";
import type { MakeDb, SuiteOpts } from "../store-suite.js";

export function runWorkflowRunsSuite(makeDb: MakeDb, _opts: SuiteOpts): void {
  describe("WorkflowRunStore", () => {
    let db: StateDb;

    beforeEach(async () => {
      db = await makeDb();
    });

    /** Create a fresh run and return its id. */
    async function makeRun(
      overrides: Partial<Parameters<WorkflowRunStore["createRun"]>[0]> = {},
    ): Promise<string> {
      const id = randomUUID();
      await db.runs.createRun({
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

    describe("workflow_runs CRUD", () => {
      it("creates a workflow run and retrieves it by ID", async () => {
        const id = randomUUID();
        const now = new Date().toISOString();
        await db.runs.createRun({
          id,
          workflowName: "build",
          triggerId: "owner/repo#1",
          repo: "repo",
          issueNumber: 1,
          currentPhase: "phase_0",
          status: "running",
          context: { branch: "lastlight/1-test" },
          startedAt: now,
          finishedAt: undefined,
        });

        const run = await db.runs.getRun(id);
        expect(run).not.toBeNull();
        expect(run!.id).toBe(id);
        expect(run!.workflowName).toBe("build");
        expect(run!.triggerId).toBe("owner/repo#1");
        expect(run!.repo).toBe("repo");
        expect(run!.issueNumber).toBe(1);
        expect(run!.currentPhase).toBe("phase_0");
        expect(run!.status).toBe("running");
        expect(run!.phaseHistory).toEqual([]);
        expect(run!.context).toEqual({ branch: "lastlight/1-test" });
      });

      it("returns null for a non-existent ID", async () => {
        expect(await db.runs.getRun("no-such-id")).toBeNull();
      });

      it("updates phase and appends to phase_history", async () => {
        const id = randomUUID();
        const now = new Date().toISOString();
        await db.runs.createRun({
          id,
          workflowName: "build",
          triggerId: "owner/repo#2",
          currentPhase: "phase_0",
          status: "running",
          startedAt: now,
        });

        const entry = { phase: "guardrails", timestamp: new Date().toISOString(), success: true, summary: "READY" };
        await db.runs.appendPhase(id, "guardrails", entry);

        const run = await db.runs.getRun(id);
        expect(run!.currentPhase).toBe("guardrails");
        expect(run!.phaseHistory).toHaveLength(1);
        expect(run!.phaseHistory[0]).toEqual(entry);
      });

      it("appends multiple phase history entries", async () => {
        const id = randomUUID();
        const now = new Date().toISOString();
        await db.runs.createRun({
          id,
          workflowName: "build",
          triggerId: "owner/repo#3",
          currentPhase: "phase_0",
          status: "running",
          startedAt: now,
        });

        await db.runs.appendPhase(id, "guardrails", { phase: "guardrails", timestamp: now, success: true });
        await db.runs.appendPhase(id, "architect", { phase: "architect", timestamp: now, success: true });
        await db.runs.appendPhase(id, "executor", { phase: "executor", timestamp: now, success: true });

        const run = await db.runs.getRun(id);
        expect(run!.currentPhase).toBe("executor");
        expect(run!.phaseHistory).toHaveLength(3);
        expect(run!.phaseHistory.map((e) => e.phase)).toEqual(["guardrails", "architect", "executor"]);
      });

      it("finishes a workflow run with succeeded status", async () => {
        const id = randomUUID();
        const now = new Date().toISOString();
        await db.runs.createRun({
          id,
          workflowName: "build",
          triggerId: "owner/repo#4",
          currentPhase: "executor",
          status: "running",
          startedAt: now,
        });

        await db.runs.finishRun(id, "succeeded");
        const run = await db.runs.getRun(id);
        expect(run!.status).toBe("succeeded");
        expect(run!.finishedAt).toBeTruthy();
      });

      it("finishes a workflow run with failed status", async () => {
        const id = randomUUID();
        const now = new Date().toISOString();
        await db.runs.createRun({
          id,
          workflowName: "build",
          triggerId: "owner/repo#5",
          currentPhase: "architect",
          status: "running",
          startedAt: now,
        });

        await db.runs.finishRun(id, "failed", { error: "some error" });
        const run = await db.runs.getRun(id);
        expect(run!.status).toBe("failed");
        expect(run!.finishedAt).toBeTruthy();
      });
    });

    describe("node_statuses store removed (issue #94)", () => {
      it("no longer exposes updateNodeStatus and getWorkflowRun has no nodeStatuses", async () => {
        const id = randomUUID();
        await db.runs.createRun({
          id,
          workflowName: "build",
          triggerId: "owner/repo#77",
          currentPhase: "phase_0",
          status: "running",
          startedAt: new Date().toISOString(),
        });
        expect((db as unknown as Record<string, unknown>).updateNodeStatus).toBeUndefined();
        const run = await db.runs.getRun(id);
        expect(run).not.toBeNull();
        expect((run as unknown as Record<string, unknown>).nodeStatuses).toBeUndefined();
      });
    });

    describe("getWorkflowRunByTrigger", () => {
      it("returns the active run for a trigger", async () => {
        const id = randomUUID();
        const now = new Date().toISOString();
        await db.runs.createRun({
          id,
          workflowName: "build",
          triggerId: "owner/repo#10",
          currentPhase: "executor",
          status: "running",
          startedAt: now,
        });

        const run = await db.runs.getByTrigger("owner/repo#10");
        expect(run).not.toBeNull();
        expect(run!.id).toBe(id);
      });

      it("ignores failed or succeeded runs", async () => {
        const id = randomUUID();
        const now = new Date().toISOString();
        await db.runs.createRun({
          id,
          workflowName: "build",
          triggerId: "owner/repo#11",
          currentPhase: "executor",
          status: "running",
          startedAt: now,
        });
        await db.runs.finishRun(id, "failed");

        expect(await db.runs.getByTrigger("owner/repo#11")).toBeNull();
      });

      it("returns null when no run exists for trigger", async () => {
        expect(await db.runs.getByTrigger("owner/repo#999")).toBeNull();
      });

      it("returns the most recent active run when multiple exist", async () => {
        const id1 = randomUUID();
        const id2 = randomUUID();

        await db.runs.createRun({
          id: id1,
          workflowName: "build",
          triggerId: "owner/repo#12",
          currentPhase: "guardrails",
          status: "running",
          startedAt: new Date(Date.now() - 1000).toISOString(),
        });
        await db.runs.createRun({
          id: id2,
          workflowName: "build",
          triggerId: "owner/repo#12",
          currentPhase: "architect",
          status: "running",
          startedAt: new Date().toISOString(),
        });

        const run = await db.runs.getByTrigger("owner/repo#12");
        expect(run!.id).toBe(id2);
      });
    });

    describe("activeWorkflowRuns", () => {
      it("returns only running and paused runs", async () => {
        const now = new Date().toISOString();

        const runningId = randomUUID();
        await db.runs.createRun({ id: runningId, workflowName: "build", triggerId: "t1", currentPhase: "guardrails", status: "running", startedAt: now });

        const failedId = randomUUID();
        await db.runs.createRun({ id: failedId, workflowName: "build", triggerId: "t2", currentPhase: "executor", status: "running", startedAt: now });
        await db.runs.finishRun(failedId, "failed");

        const active = await db.runs.listActive();
        expect(active.map((r) => r.id)).toContain(runningId);
        expect(active.map((r) => r.id)).not.toContain(failedId);
      });
    });

    describe("recentWorkflowRuns", () => {
      it("respects limit and orders by started_at DESC", async () => {
        const now = Date.now();
        for (let i = 0; i < 5; i++) {
          await db.runs.createRun({
            id: randomUUID(),
            workflowName: "build",
            triggerId: `t${i}`,
            currentPhase: "phase_0",
            status: "running",
            startedAt: new Date(now + i * 1000).toISOString(),
          });
        }

        const runs = await db.runs.listRecent(3);
        expect(runs).toHaveLength(3);
        // Most recent first
        expect(runs[0]!.startedAt >= runs[1]!.startedAt).toBe(true);
        expect(runs[1]!.startedAt >= runs[2]!.startedAt).toBe(true);
      });
    });

    describe("cancelWorkflowRun", () => {
      it("sets status to cancelled", async () => {
        const id = randomUUID();
        const now = new Date().toISOString();
        await db.runs.createRun({ id, workflowName: "build", triggerId: "t-cancel", currentPhase: "executor", status: "running", startedAt: now });
        await db.runs.cancelRun(id);

        const run = await db.runs.getRun(id);
        expect(run!.status).toBe("cancelled");
        expect(run!.finishedAt).toBeTruthy();
      });
    });

    describe("pauseWorkflowRun", () => {
      it("sets status to paused", async () => {
        const id = randomUUID();
        await db.runs.createRun({ id, workflowName: "build", triggerId: "t-pause", currentPhase: "architect", status: "running", startedAt: new Date().toISOString() });
        await db.runs.setPaused(id);

        const run = await db.runs.getRun(id);
        expect(run!.status).toBe("paused");
      });
    });

    describe("context JSON round-trip", () => {
      it("stores and retrieves complex context objects", async () => {
        const id = randomUUID();
        const context = { branch: "lastlight/42-my-feature", taskId: "repo-42", models: { architect: "claude-opus-4-6" } };
        await db.runs.createRun({
          id,
          workflowName: "build",
          triggerId: "owner/repo#42",
          currentPhase: "phase_0",
          status: "running",
          context,
          startedAt: new Date().toISOString(),
        });

        const run = await db.runs.getRun(id);
        expect(run!.context).toEqual(context);
      });

      it("handles runs without context", async () => {
        const id = randomUUID();
        await db.runs.createRun({
          id,
          workflowName: "build",
          triggerId: "owner/repo#43",
          currentPhase: "phase_0",
          status: "running",
          startedAt: new Date().toISOString(),
        });

        const run = await db.runs.getRun(id);
        expect(run!.context).toBeUndefined();
      });
    });

    describe("actor logging (issue #205)", () => {
      it("persists triggered_by / trigger_actor_type and surfaces them on read", async () => {
        const id = await makeRun({ triggeredBy: "octocat", triggerActorType: "github" });
        const run = await db.runs.getRun(id);
        expect(run?.triggeredBy).toBe("octocat");
        expect(run?.triggerActorType).toBe("github");
      });

      it("surfaces the actor on the paginated list() rows too", async () => {
        await makeRun({ triggeredBy: "alice", triggerActorType: "cli" });
        const { runs } = await db.runs.list();
        expect(runs[0]?.triggeredBy).toBe("alice");
        expect(runs[0]?.triggerActorType).toBe("cli");
      });

      it("leaves the actor undefined when not supplied (additive, back-compat)", async () => {
        const run = await db.runs.getRun(await makeRun());
        expect(run?.triggeredBy).toBeUndefined();
        expect(run?.triggerActorType).toBeUndefined();
      });
    });

    describe("pauseForApproval", () => {
      it("creates the approval, appends the marker, merges scratch, and pauses — in one step", async () => {
        const runId = await makeRun();
        const approvalId = randomUUID();
        await db.runs.pauseForApproval(
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

        const run = await db.runs.getRun(runId);
        expect(run!.status).toBe("paused");
        expect(run!.currentPhase).toBe("waiting_approval");
        expect(run!.phaseHistory.at(-1)!.phase).toBe("waiting_approval");
        expect(run!.scratch).toEqual({ socratic: { iteration: 2 } });

        const approval = await db.approvals.getById(approvalId);
        expect(approval!.status).toBe("pending");
        expect(approval!.gate).toBe("post_architect");
        expect(approval!.artifact).toBe("architect-plan.md");
      });

      it("rolls back the phase-history append when the approval store throws (injected collaborator)", async () => {
        // Build a second store over the SAME client so we can inject a fake
        // ApprovalStore whose create() throws as the last txn step. The throw
        // rejects the async transaction callback, which is what makes Drizzle roll
        // the whole thing back.
        const runId = await makeRun({
          workflowName: "build",
          triggerId: "owner/repo#1",
          currentPhase: "architect",
          status: "running",
        });

        const throwingApprovals = {
          create() {
            throw new Error("approval insert failed");
          },
        } as unknown as ApprovalStore;
        const runs = new WorkflowRunStore(db.client, {
          approvals: throwingApprovals,
          serialize: makeOpSerializer(),
        });

        await expect(
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
        ).rejects.toThrow("approval insert failed");

        // The appendPhase that ran before the throwing collaborator must be rolled
        // back: the run is still running with empty phase history.
        const run = await db.runs.getRun(runId);
        expect(run!.status).toBe("running");
        expect(run!.phaseHistory).toEqual([]);
      });
    });

    describe("finishRun with a terminal marker", () => {
      it("appends the on_success phase marker and flips status in one step", async () => {
        const runId = await makeRun();
        await db.runs.finishRun(runId, "succeeded", {
          terminalMarker: { phase: "done", summary: "PR #5" },
        });

        const run = await db.runs.getRun(runId);
        expect(run!.status).toBe("succeeded");
        expect(run!.finishedAt).toBeTruthy();
        expect(run!.currentPhase).toBe("done");
        const last = run!.phaseHistory.at(-1)!;
        expect(last.phase).toBe("done");
        expect(last.summary).toBe("PR #5");
        expect(last.success).toBe(true);
      });

      it("plain finish (no marker) flips status without touching phase history", async () => {
        const runId = await makeRun();
        await db.runs.finishRun(runId, "failed", { error: "boom" });

        const run = await db.runs.getRun(runId);
        expect(run!.status).toBe("failed");
        expect(run!.phaseHistory).toEqual([]);
        expect(run!.context).toEqual({ error: "boom" });
      });
    });

    describe("resolveGateAndResume — approve path", () => {
      it("approves the gate and sets the run running, returning the run", async () => {
        const runId = await makeRun({ status: "paused" });
        const approvalId = randomUUID();
        await db.approvals.create({
          id: approvalId,
          workflowRunId: runId,
          gate: "post_architect",
          summary: "Plan ready",
          createdAt: new Date().toISOString(),
        });

        const run = await db.runs.resolveGateAndResume(approvalId, "bob");

        expect(run!.id).toBe(runId);
        expect(run!.status).toBe("running");
        const approval = await db.approvals.getById(approvalId);
        expect(approval!.status).toBe("approved");
        expect(approval!.respondedBy).toBe("bob");
      });

      it("throws on an unknown approval id", async () => {
        await expect(db.runs.resolveGateAndResume("no-such-approval", "bob")).rejects.toThrow();
      });

      it("does not resume a stale approval that was already resolved", async () => {
        const runId = await makeRun({ status: "paused" });
        const approvalId = randomUUID();
        await db.approvals.create({
          id: approvalId,
          workflowRunId: runId,
          gate: "post_architect",
          summary: "Plan ready",
          createdAt: new Date().toISOString(),
        });

        await db.runs.resolveGateAndFail(approvalId, "carol", "plan incomplete");

        await expect(db.runs.resolveGateAndResume(approvalId, "bob")).rejects.toThrow("not pending");
        expect((await db.runs.getRun(runId))!.status).toBe("failed");
        expect((await db.approvals.getById(approvalId))!.status).toBe("rejected");
      });
    });

    describe("resolveGateAndFail — reject path", () => {
      it("does not fail a stale approval that was already approved", async () => {
        const runId = await makeRun({ status: "paused" });
        const approvalId = randomUUID();
        await db.approvals.create({
          id: approvalId,
          workflowRunId: runId,
          gate: "post_architect",
          summary: "Plan ready",
          createdAt: new Date().toISOString(),
        });

        await db.runs.resolveGateAndResume(approvalId, "bob");

        await expect(db.runs.resolveGateAndFail(approvalId, "carol", "too late")).rejects.toThrow(
          "not pending",
        );
        expect((await db.runs.getRun(runId))!.status).toBe("running");
        expect((await db.approvals.getById(approvalId))!.status).toBe("approved");
      });

      it("rejects the gate and fails the run", async () => {
        const runId = await makeRun({ status: "paused" });
        const approvalId = randomUUID();
        await db.approvals.create({
          id: approvalId,
          workflowRunId: runId,
          gate: "post_architect",
          summary: "Plan ready",
          createdAt: new Date().toISOString(),
        });

        const run = await db.runs.resolveGateAndFail(approvalId, "carol", "plan incomplete");

        expect(run!.id).toBe(runId);
        expect(run!.status).toBe("failed");
        const approval = await db.approvals.getById(approvalId);
        expect(approval!.status).toBe("rejected");
        expect(approval!.respondedBy).toBe("carol");
        expect(approval!.response).toBe("plan incomplete");
        expect((await db.runs.getRun(runId))!.context).toEqual({ error: "Rejected: plan incomplete" });
      });

      it("records a fallback error annotation when rejection has no reason", async () => {
        const runId = await makeRun({ status: "paused" });
        const approvalId = randomUUID();
        await db.approvals.create({
          id: approvalId,
          workflowRunId: runId,
          gate: "post_architect",
          summary: "Plan ready",
          createdAt: new Date().toISOString(),
        });

        const run = await db.runs.resolveGateAndFail(approvalId, "carol");

        expect(run!.status).toBe("failed");
        expect(run!.context).toEqual({ error: "Rejected: no reason given" });
      });
    });

    describe("resolveReplyGateAndResume — the socratic explore-reply atomic op", () => {
      it("resolves the reply gate, merges scratch, and sets the run running in one step", async () => {
        const runId = await makeRun({ status: "paused" });
        const approvalId = randomUUID();
        await db.approvals.create({
          id: approvalId,
          workflowRunId: runId,
          gate: "socratic_1",
          summary: "What problem are we solving?",
          kind: "reply",
          createdAt: new Date().toISOString(),
        });

        const scratchPatch = { socratic: { qa: [{ question: "Q1", answer: "A1" }] } };
        const run = await db.runs.resolveReplyGateAndResume(
          runId,
          approvalId,
          "A1",
          "alice",
          scratchPatch,
        );

        // Returns the resumed run
        expect(run).not.toBeNull();
        expect(run!.id).toBe(runId);
        expect(run!.status).toBe("running");

        // Gate resolved with the reply text recorded
        const approval = await db.approvals.getById(approvalId);
        expect(approval!.status).toBe("approved");
        expect(approval!.response).toBe("A1");
        expect(approval!.respondedBy).toBe("alice");

        // Scratch merged
        const reloaded = await db.runs.getRun(runId);
        expect(reloaded!.status).toBe("running");
        expect(reloaded!.scratch).toEqual(scratchPatch);
      });

      it("double-reply concurrency guard: a second resolve throws and leaves the run paused", async () => {
        const runId = await makeRun({ status: "paused" });
        const approvalId = randomUUID();
        await db.approvals.create({
          id: approvalId,
          workflowRunId: runId,
          gate: "socratic_1",
          summary: "Q",
          kind: "reply",
          createdAt: new Date().toISOString(),
        });

        await db.runs.resolveReplyGateAndResume(runId, approvalId, "first", "alice", {});
        await db.runs.setPaused(runId); // pretend it paused again on the next iteration

        // A racing second reply against the already-resolved gate must not resume.
        await expect(
          db.runs.resolveReplyGateAndResume(runId, approvalId, "second", "bob", {}),
        ).rejects.toThrow();
        expect((await db.runs.getRun(runId))!.status).toBe("paused");
      });

      it("rolls back the gate resolution when the scratch patch is not serializable", async () => {
        const runId = await makeRun({ status: "paused" });
        const approvalId = randomUUID();
        await db.approvals.create({
          id: approvalId,
          workflowRunId: runId,
          gate: "socratic_1",
          summary: "Q",
          kind: "reply",
          createdAt: new Date().toISOString(),
        });

        // A BigInt makes JSON.stringify throw mid-transaction (natural poison input).
        const poison = { socratic: { n: BigInt(1) } } as unknown as Record<string, unknown>;
        await expect(
          db.runs.resolveReplyGateAndResume(runId, approvalId, "A1", "alice", poison),
        ).rejects.toThrow();

        // Nothing applied: gate still pending, run still paused, scratch untouched.
        expect((await db.approvals.getById(approvalId))!.status).toBe("pending");
        const reloaded = await db.runs.getRun(runId);
        expect(reloaded!.status).toBe("paused");
        expect(reloaded!.scratch).toBeUndefined();
      });
    });

    describe("restartRun — retry a failed run", () => {
      it("flips failed→running, clears finished_at and context.error, bumps restart_count", async () => {
        const runId = await makeRun();
        // Simulate a failed run: finishRun writes status, finished_at and the
        // context.error annotation.
        await db.runs.finishRun(runId, "failed", { error: "boom" });
        const failed = (await db.runs.getRun(runId))!;
        expect(failed.status).toBe("failed");
        expect(failed.finishedAt).toBeTruthy();
        expect(failed.context).toEqual({ error: "boom" });

        const changed = await db.runs.restartRun(runId);
        expect(changed).toBe(1);

        const restarted = (await db.runs.getRun(runId))!;
        expect(restarted.status).toBe("running");
        expect(restarted.finishedAt).toBeFalsy();
        // The stale error annotation is gone so the row no longer reads "failed at".
        expect(restarted.context).toEqual({});
        expect(restarted.restartCount).toBe(1);
      });

      it("preserves context (taskId, branch) and scratch across the restart", async () => {
        const runId = await makeRun({
          context: { taskId: "acme-1-explore-abcd1234", branch: "lastlight/1-foo", owner: "acme" },
          scratch: { socratic: { qa: [{ question: "Q1", answer: "A1" }] } },
        });
        await db.runs.finishRun(runId, "failed", { error: "read_context crashed" });

        expect(await db.runs.restartRun(runId)).toBe(1);

        const restarted = (await db.runs.getRun(runId))!;
        expect(restarted.context).toEqual({
          taskId: "acme-1-explore-abcd1234",
          branch: "lastlight/1-foo",
          owner: "acme",
        });
        expect(restarted.scratch).toEqual({ socratic: { qa: [{ question: "Q1", answer: "A1" }] } });
      });

      it("is a compare-and-set: a non-retryable run is not restarted (0 rows changed)", async () => {
        // A running run — the concurrency guard: a second retry click after the
        // first already flipped it to running must not re-dispatch.
        const runId = await makeRun({ status: "running" });
        expect(await db.runs.restartRun(runId)).toBe(0);
        expect((await db.runs.getRun(runId))!.status).toBe("running");

        // A succeeded run is likewise untouched.
        const doneId = await makeRun({ status: "succeeded" });
        expect(await db.runs.restartRun(doneId)).toBe(0);
        expect((await db.runs.getRun(doneId))!.status).toBe("succeeded");
      });

      it("retries a queue-dropped 'cancelled' run and clears the drop reason", async () => {
        // A run TTL-expired from the queue after a server death is `cancelled` with
        // a `context.error` drop reason. It must be retryable (the reported bug).
        const runId = await makeRun({ status: "queued" });
        expect(await db.runs.expireQueued(runId, "dropped from queue after waiting too long")).toBe(1);
        const cancelled = (await db.runs.getRun(runId))!;
        expect(cancelled.status).toBe("cancelled");
        expect(cancelled.context).toEqual({ error: "dropped from queue after waiting too long" });

        expect(await db.runs.restartRun(runId)).toBe(1);
        const restarted = (await db.runs.getRun(runId))!;
        expect(restarted.status).toBe("running");
        expect(restarted.finishedAt).toBeFalsy();
        expect(restarted.context).toEqual({});
        expect(restarted.restartCount).toBe(1);
      });
    });

    describe("requeue — refresh a queued orphan's clock on boot", () => {
      it("bumps started_at on a queued run so admission can promote it", async () => {
        const stale = new Date(Date.now() - 60_000).toISOString();
        const runId = await makeRun({ status: "queued", startedAt: stale });
        expect(await db.runs.requeue(runId)).toBe(1);
        const r = (await db.runs.getRun(runId))!;
        expect(r.status).toBe("queued");
        expect(Date.parse(r.startedAt)).toBeGreaterThan(Date.parse(stale));
      });

      it("is a CAS on status='queued' — a running run is untouched (0 rows)", async () => {
        const runId = await makeRun({ status: "running" });
        expect(await db.runs.requeue(runId)).toBe(0);
        expect((await db.runs.getRun(runId))!.status).toBe("running");
      });
    });

    describe("requeueRunning — backpressure requeue on quota rejection", () => {
      it("requeueRunning flips a running run back to queued and re-stamps the clock", async () => {
        const id = "run-bp-1";
        await db.runs.createRun({
          id, workflowName: "build", triggerId: "t1", owner: "o", repo: "r",
          issueNumber: 1, currentPhase: "phase_0", status: "running",
          startedAt: new Date(Date.now() - 3_600_000).toISOString(), // 1h ago
        } as any);

        const before = (await db.runs.getRun(id))!;
        const changed = await db.runs.requeueRunning(id);

        expect(changed).toBe(1);
        const after = (await db.runs.getRun(id))!;
        expect(after.status).toBe("queued");
        expect(Date.parse(after.startedAt)).toBeGreaterThan(Date.parse(before.startedAt));
      });

      it("requeueRunning is a no-op on a non-running run (CAS guard)", async () => {
        const id = "run-bp-2";
        await db.runs.createRun({
          id, workflowName: "build", triggerId: "t2", owner: "o", repo: "r",
          issueNumber: 2, currentPhase: "phase_0", status: "queued",
          startedAt: new Date().toISOString(),
        } as any);
        expect(await db.runs.requeueRunning(id)).toBe(0);
        expect((await db.runs.getRun(id))!.status).toBe("queued");
      });
    });

    describe("latestSucceededForTrigger", () => {
      it("returns the newest SUCCEEDED run for the workflow+trigger, ignoring others", async () => {
        const trigger = "acme/widgets#190";
        // A failed run for the same trigger must not win.
        await makeRun({ workflowName: "dependabot-pr-merge", triggerId: trigger, status: "failed", context: { headSha: "shaFailed" } });
        // An older succeeded run.
        await makeRun({
          workflowName: "dependabot-pr-merge",
          triggerId: trigger,
          status: "succeeded",
          context: { headSha: "shaOld" },
          startedAt: new Date(Date.now() - 10_000).toISOString(),
        });
        // The newest succeeded run.
        await makeRun({
          workflowName: "dependabot-pr-merge",
          triggerId: trigger,
          status: "succeeded",
          context: { headSha: "shaNew" },
          startedAt: new Date().toISOString(),
        });

        const latest = await db.runs.latestSucceededForTrigger("dependabot-pr-merge", trigger);
        expect((latest?.context as Record<string, unknown>)?.headSha).toBe("shaNew");
      });

      it("returns null for a different workflow or trigger", async () => {
        const trigger = "acme/widgets#190";
        await makeRun({ workflowName: "dependabot-pr-merge", triggerId: trigger, status: "succeeded", context: { headSha: "sha1" } });
        expect(
          await db.runs.latestSucceededForTrigger("dependabot-pr-merge", "acme/widgets#999"),
        ).toBeNull();
        expect(await db.runs.latestSucceededForTrigger("pr-review", trigger)).toBeNull();
      });
    });

    describe("hasRunForTrigger", () => {
      it("returns true for a build run regardless of status", async () => {
        await makeRun({ workflowName: "build", triggerId: "acme/widgets#14", status: "succeeded" });
        expect(await db.runs.hasRunForTrigger("acme/widgets#14", "build")).toBe(true);
      });

      it("returns true for a running build (mid-flight)", async () => {
        await makeRun({ workflowName: "build", triggerId: "acme/widgets#15", status: "running" });
        expect(await db.runs.hasRunForTrigger("acme/widgets#15", "build")).toBe(true);
      });

      it("returns false when no run exists for the trigger", async () => {
        expect(await db.runs.hasRunForTrigger("acme/widgets#99", "build")).toBe(false);
      });

      it("returns false for a different workflow name on the same trigger", async () => {
        await makeRun({ workflowName: "issue-triage", triggerId: "acme/widgets#16", status: "succeeded" });
        expect(await db.runs.hasRunForTrigger("acme/widgets#16", "build")).toBe(false);
      });
    });

    // ── New methods for #172 concurrency cap ──────────────────────────────────

    describe("countRunning", () => {
      it("counts only running runs, excludes queued and paused", async () => {
        await makeRun({ status: "running" });
        await makeRun({ status: "running" });
        await makeRun({ status: "queued" });
        await makeRun({ status: "paused" });
        await makeRun({ status: "succeeded" });
        expect(await db.runs.countRunning()).toBe(2);
      });

      it("returns 0 when no running runs", async () => {
        await makeRun({ status: "queued" });
        expect(await db.runs.countRunning()).toBe(0);
      });
    });

    describe("listQueued", () => {
      it("returns queued runs ordered by started_at ascending (FIFO)", async () => {
        const id1 = await makeRun({ status: "queued", startedAt: "2024-01-01T00:00:00.000Z" });
        const id2 = await makeRun({ status: "queued", startedAt: "2024-01-01T00:01:00.000Z" });
        const id3 = await makeRun({ status: "queued", startedAt: "2024-01-01T00:02:00.000Z" });
        await makeRun({ status: "running" }); // not queued — excluded
        const queued = await db.runs.listQueued();
        expect(queued.map((r) => r.id)).toEqual([id1, id2, id3]);
      });

      it("returns empty array when no queued runs", async () => {
        await makeRun({ status: "running" });
        expect(await db.runs.listQueued()).toHaveLength(0);
      });
    });

    describe("admitRun", () => {
      it("returns 1 and sets status to running when run is queued", async () => {
        const id = await makeRun({ status: "queued" });
        const changes = await db.runs.admitRun(id);
        expect(changes).toBe(1);
        expect((await db.runs.getRun(id))!.status).toBe("running");
      });

      it("returns 0 (CAS) when run is already running — prevents double-admit", async () => {
        const id = await makeRun({ status: "queued" });
        await db.runs.admitRun(id); // first admit wins
        const changes = await db.runs.admitRun(id); // second is a no-op
        expect(changes).toBe(0);
        expect((await db.runs.getRun(id))!.status).toBe("running");
      });

      it("returns 0 when run does not exist", async () => {
        expect(await db.runs.admitRun("nonexistent-id")).toBe(0);
      });

      it("does not touch started_at or restart_count", async () => {
        const startedAt = "2024-01-01T00:00:00.000Z";
        const id = await makeRun({ status: "queued", startedAt });
        await db.runs.admitRun(id);
        const run = (await db.runs.getRun(id))!;
        expect(run.startedAt).toBe(startedAt);
        expect(run.restartCount ?? 0).toBe(0);
      });
    });

    describe("expireQueued", () => {
      it("transitions queued → cancelled and records the reason", async () => {
        const id = await makeRun({ status: "queued" });
        const changes = await db.runs.expireQueued(id, "dropped from queue after waiting too long");
        expect(changes).toBe(1);
        const run = (await db.runs.getRun(id))!;
        expect(run.status).toBe("cancelled");
        expect(run.context?.error).toBe("dropped from queue after waiting too long");
        expect(run.finishedAt).toBeTruthy();
      });

      it("returns 0 when run is not queued (CAS guard)", async () => {
        const id = await makeRun({ status: "running" });
        expect(await db.runs.expireQueued(id, "reason")).toBe(0);
        expect((await db.runs.getRun(id))!.status).toBe("running");
      });

      it("returns 0 when run does not exist", async () => {
        expect(await db.runs.expireQueued("no-such-id", "reason")).toBe(0);
      });
    });

    describe("getByTrigger includes queued", () => {
      it("returns a queued run for the trigger", async () => {
        const id = await makeRun({ status: "queued", triggerId: "acme/repo#42" });
        const run = await db.runs.getByTrigger("acme/repo#42");
        expect(run).not.toBeNull();
        expect(run!.id).toBe(id);
        expect(run!.status).toBe("queued");
      });

      it("returns running run over older queued run", async () => {
        await makeRun({ status: "queued", triggerId: "acme/repo#43", startedAt: "2024-01-01T00:00:00.000Z" });
        const runId = await makeRun({ status: "running", triggerId: "acme/repo#43", startedAt: "2024-01-01T00:01:00.000Z" });
        const run = await db.runs.getByTrigger("acme/repo#43");
        expect(run!.id).toBe(runId);
      });
    });

    describe("listActive includes queued", () => {
      it("includes queued, running, and paused runs", async () => {
        const q = await makeRun({ status: "queued" });
        const r = await makeRun({ status: "running" });
        const p = await makeRun({ status: "paused" });
        await makeRun({ status: "succeeded" });
        await makeRun({ status: "failed" });
        const active = await db.runs.listActive();
        const ids = active.map((x) => x.id);
        expect(ids).toContain(q);
        expect(ids).toContain(r);
        expect(ids).toContain(p);
        expect(active).toHaveLength(3);
      });
    });

    /**
     * Insert a run row with raw SQL, bypassing `createRun`'s normalization — the
     * only way to produce a shape the store would never write itself (issue #279).
     */
    async function makeLegacyRun(overrides: { owner?: string | null; repo: string }): Promise<string> {
      const id = randomUUID();
      const now = new Date().toISOString();
      await runSql(
        db.client,
        sql`INSERT INTO workflow_runs (id, workflow_name, trigger_id, owner, repo, current_phase, status, started_at, updated_at)
            VALUES (${id}, 'explore', ${`slack:${id}`}, ${overrides.owner ?? null}, ${overrides.repo}, 'socratic', 'running', ${now}, ${now})`,
      );
      return id;
    }

    describe("repo-scoped queries", () => {
      it("list({ repo }) returns only that repo's runs, with the post-filter total", async () => {
        // Passing the qualified form is normalized on the way in (issue #279), so
        // the rows come back as the (owner, BARE repo) pair regardless.
        await makeRun({ repo: "acme/api" });
        await makeRun({ repo: "acme/api" });
        await makeRun({ repo: "acme/web" });
        await makeRun({ repo: undefined }); // repo-less run must not leak in

        const { runs, total } = await db.runs.list({ repo: "acme/api" });
        expect(total).toBe(2);
        expect(runs).toHaveLength(2);
        expect(runs.every((r) => r.owner === "acme" && r.repo === "api")).toBe(true);

        // The filter composes with pagination.
        const page = await db.runs.list({ repo: "acme/api", limit: 1 });
        expect(page.total).toBe(2);
        expect(page.runs).toHaveLength(1);
      });

      it("list({ repos }) scopes to a SET of repos (the visibility scope, issue #169)", async () => {
        await makeRun({ owner: "nearform", repo: "lastlight" });
        await makeRun({ owner: "nearform", repo: "www" });
        await makeRun({ owner: "nearform", repo: "unrelated" });

        const { runs, total } = await db.runs.list({
          repos: ["nearform/lastlight", "nearform/www"],
        });
        expect(total).toBe(2);
        expect(runs.map((r) => r.repo).sort()).toEqual(["lastlight", "www"]);
      });

      it("list({ repos }) matches BARE rows — a plain IN() would return nothing", async () => {
        // The regression: the real create path stores `repo` bare with `owner`
        // beside it, while the caller filters by the qualified `owner/repo`. An
        // `IN (…)` against the column matches no modern row at all, which would
        // silently show an empty dashboard rather than a filtered one.
        await makeRun({ owner: "nearform", repo: "lastlight" });
        await makeRun({ owner: "nearform", repo: "www" });

        const { runs } = await db.runs.list({ repos: ["nearform/lastlight", "nearform/www"] });
        expect(runs).toHaveLength(2);
      });

      it("still matches a legacy row the backfill never reached", async () => {
        // The `OR repo = ?` arm of `repoMatchClause` is compatibility, not the rule
        // (issue #279): `createRun` normalizes and the backfill converges the table,
        // so only a row written by an older process against an un-migrated DB looks
        // like this. Kept because dropping a row from a filter is the failure mode
        // that hides things silently — a SELECT is the wrong place to discover that
        // a backfill didn't run.
        await makeRun({ owner: "nearform", repo: "lastlight" });
        const legacy = await makeLegacyRun({ owner: null, repo: "nearform/www" });

        const { runs } = await db.runs.list({ repos: ["nearform/lastlight", "nearform/www"] });
        expect(runs).toHaveLength(2);
        expect(runs.map((r) => r.id)).toContain(legacy);

        // …and it reads back NORMALIZED, because `deserialize` is the shim every
        // consumer crosses. This is what lets admission.ts hand (owner, repo)
        // straight to Octokit without a split of its own.
        const read = (await db.runs.getRun(legacy))!;
        expect([read.owner, read.repo]).toEqual(["nearform", "www"]);
      });

      it("distinctRepos() folds a legacy row in with its normalized twin", async () => {
        // The bare-vs-qualified duplicate the /repos union must never show.
        await makeRun({ owner: "nearform", repo: "www", startedAt: "2026-01-01T00:00:00.000Z" });
        await makeLegacyRun({ owner: null, repo: "nearform/www" });

        const repos = await db.runs.distinctRepos();
        expect(repos.filter((r) => r.repo === "nearform/www")).toHaveLength(1);
        expect(repos.find((r) => r.repo === "nearform/www")!.runCount).toBe(2);
      });

      it("list({ repo }) wins over `repos` — the Repos tab's narrower ask", async () => {
        await makeRun({ owner: "nearform", repo: "lastlight" });
        await makeRun({ owner: "nearform", repo: "www" });

        const { runs } = await db.runs.list({
          repo: "nearform/lastlight",
          repos: ["nearform/lastlight", "nearform/www"],
        });
        expect(runs).toHaveLength(1);
        expect(runs[0]!.repo).toBe("lastlight");
      });

      it("distinctRepos() groups by repo with run counts, newest activity first", async () => {
        await makeRun({ repo: "acme/web", startedAt: "2026-01-01T00:00:00.000Z" });
        await makeRun({ repo: "acme/api", startedAt: "2026-02-01T00:00:00.000Z" });
        await makeRun({ repo: "acme/api", startedAt: "2026-03-01T00:00:00.000Z" });
        await makeRun({ repo: undefined }); // excluded — no repo

        const repos = await db.runs.distinctRepos();
        expect(repos.map((r) => r.repo)).toEqual(["acme/api", "acme/web"]);
        const api = repos.find((r) => r.repo === "acme/api")!;
        expect(api.runCount).toBe(2);
        expect(api.lastRunAt).toBe("2026-03-01T00:00:00.000Z");
      });

      it("distinctRepos() qualifies a bare repo with its owner column", async () => {
        // The real create path stores repo BARE + owner separately; distinctRepos
        // must recompose `owner/repo` so it aligns with managedRepos / artifact
        // slugs in the /repos union (no bare-vs-qualified duplicate rows).
        await makeRun({ owner: "nearform", repo: "drizzle-cube-help", startedAt: "2026-04-01T00:00:00.000Z" });
        const repos = await db.runs.distinctRepos();
        expect(repos.map((r) => r.repo)).toContain("nearform/drizzle-cube-help");
      });

      it("owner round-trips through create → list, and the list filter accepts owner/repo", async () => {
        await makeRun({ owner: "nearform", repo: "lastlight-flue", issueNumber: 2 });
        await makeRun({ owner: "other", repo: "lastlight-flue" }); // same bare repo, different owner

        // owner surfaces on the list payload (which omits `context`).
        const all = await db.runs.list();
        const flue = all.runs.find((r) => r.owner === "nearform" && r.repo === "lastlight-flue");
        expect(flue).toBeTruthy();

        // A qualified filter matches only the right owner; a bare filter matches both.
        expect((await db.runs.list({ repo: "nearform/lastlight-flue" })).total).toBe(1);
        expect((await db.runs.list({ repo: "lastlight-flue" })).total).toBe(2);
      });
    });

    describe("list() token/cost roll-up", () => {
      /** Record one finished execution attributed to a workflow run. */
      async function addExecution(
        runId: string,
        tokens: { input?: number; output?: number; cacheRead?: number },
        costUsd: number,
      ) {
        const id = randomUUID();
        await db.executions.recordStart({
          id,
          // Was `"github"` — never a member of the `triggerType` union, and until
          // this migration nothing typechecked `tests/`. Only the roll-up columns
          // matter here, so the honest webhook value is used.
          triggerType: "webhook",
          triggerId: `slack:${runId}`,
          skill: "explore:socratic",
          startedAt: new Date().toISOString(),
          workflowRunId: runId,
        });
        await db.executions.recordFinish(id, {
          success: true,
          costUsd,
          inputTokens: tokens.input,
          outputTokens: tokens.output,
          cacheReadInputTokens: tokens.cacheRead,
        });
      }

      it("sums cost and input+output+cacheRead tokens per run", async () => {
        const runId = await makeRun();
        await addExecution(runId, { input: 100, output: 20, cacheRead: 5 }, 0.01);
        await addExecution(runId, { input: 200, output: 30, cacheRead: 0 }, 0.02);

        const run = (await db.runs.list()).runs.find((r) => r.id === runId)!;
        expect(run.totalTokens).toBe(355); // (100+20+5) + (200+30+0)
        expect(run.totalCostUsd).toBeCloseTo(0.03, 6);
      });

      it("reports zero totals for a run with no executions", async () => {
        const runId = await makeRun();
        const run = (await db.runs.list()).runs.find((r) => r.id === runId)!;
        expect(run.totalTokens).toBe(0);
        expect(run.totalCostUsd).toBe(0);
      });
    });

    /**
     * The terminal-transition observer (09 → S2). It exists so the
     * `last-light/review` check can be a projection of run state rather than of an
     * in-memory promise — hung on the STORE rather than on the eight `finishRun`
     * call sites, which is what makes `simple.ts`, `resume.ts`, the queued-run TTL
     * expiry and the admin cancel all resolve an open check for free, and what
     * stops a ninth call site being added without one.
     */
    describe("terminal run observer", () => {
      function observed() {
        const seen: Array<[string, string]> = [];
        db.runs.addTerminalObserver((run, status) => seen.push([run.id, status]));
        return seen;
      }

      it("fires on every finishRun status", async () => {
        const seen = observed();
        for (const status of ["succeeded", "failed", "cancelled"] as const) {
          const id = await makeRun();
          await db.runs.finishRun(id, status);
          expect(seen.at(-1)).toEqual([id, status]);
        }
      });

      it("fires AFTER the row is written, so the observer reads terminal state", async () => {
        let statusAtNotify: string | undefined;
        const id = await makeRun();
        db.runs.addTerminalObserver((run) => { statusAtNotify = run.status; });
        await db.runs.finishRun(id, "succeeded");
        expect(statusAtNotify).toBe("succeeded");
      });

      it("fires for a queued run dropped by the TTL sweep — the case that used to strand a check", async () => {
        const seen = observed();
        const id = await makeRun({ status: "queued" });
        expect(await db.runs.expireQueued(id, "dropped from queue after waiting too long")).toBe(1);
        expect(seen).toEqual([[id, "cancelled"]]);
      });

      it("does NOT fire when the expiry CAS loses the race", async () => {
        const id = await makeRun({ status: "running" });
        const seen = observed();
        expect(await db.runs.expireQueued(id, "too long")).toBe(0);
        expect(seen).toEqual([]);
      });

      it("fires for the admin cancel", async () => {
        const seen = observed();
        const id = await makeRun();
        await db.runs.cancelRun(id);
        expect(seen).toEqual([[id, "cancelled"]]);
      });

      it("a throwing observer never fails the transition it observes", async () => {
        const id = await makeRun();
        db.runs.addTerminalObserver(() => { throw new Error("boom"); });
        await expect(db.runs.finishRun(id, "succeeded")).resolves.not.toThrow();
        expect((await db.runs.getRun(id))?.status).toBe("succeeded");
      });

      it("notifies EVERY registered observer — a second one must not displace the first", async () => {
        // Observers were a single slot until issue #255 added feedback-anchor
        // discovery beside the `last-light/review` check. With `set` semantics the
        // second registration silently unhooked the check, which is a bug that
        // would only ever show up in production as a stranded `in_progress`.
        const first: string[] = [];
        const second: string[] = [];
        db.runs.addTerminalObserver((run) => first.push(run.id));
        db.runs.addTerminalObserver((run) => second.push(run.id));

        const id = await makeRun();
        await db.runs.finishRun(id, "succeeded");
        expect(first).toEqual([id]);
        expect(second).toEqual([id]);
      });

      it("one observer throwing does not cost the others their notification", async () => {
        const survivor: string[] = [];
        db.runs.addTerminalObserver(() => { throw new Error("boom"); });
        db.runs.addTerminalObserver((run) => survivor.push(run.id));

        const id = await makeRun();
        await expect(db.runs.finishRun(id, "failed")).resolves.not.toThrow();
        expect(survivor).toEqual([id]);
      });

      it("still commits the terminal marker transaction before notifying", async () => {
        const seen = observed();
        const id = await makeRun();
        await db.runs.finishRun(id, "succeeded", {
          terminalMarker: { phase: "complete", summary: "done" },
        });
        expect(seen).toEqual([[id, "succeeded"]]);
        expect((await db.runs.getRun(id))?.phaseHistory.at(-1)?.phase).toBe("complete");
      });
    });

    describe("list() ordering — in-flight runs float above the queue", () => {
      /** Seed a run with an explicit start time so ordering is deterministic. */
      const at = (status: string, minutesAgo: number) =>
        makeRun({
          status: status as Parameters<WorkflowRunStore["createRun"]>[0]["status"],
          startedAt: new Date(Date.now() - minutesAgo * 60_000).toISOString(),
        });

      it("keeps a running run on page 1 when a cron fan-out floods the queue", async () => {
        // The reported bug: a batch of freshly-queued runs is NEWER than the work
        // actually executing, so a date-only sort pushed the running run to page 2.
        // The dashboard hides queued rows by default, so the Live tab rendered
        // empty while an agent was mid-run.
        const running = await at("running", 30);
        for (let i = 0; i < 40; i++) await at("queued", 1);

        const { runs, total } = await db.runs.list({
          limit: 20,
          statuses: ["queued", "running", "paused"],
        });

        expect(total).toBe(41);
        expect(runs[0]!.id).toBe(running);
        expect(runs.filter((r) => r.status !== "queued")).toHaveLength(1);
      });

      it("orders running before paused before queued", async () => {
        // Dates deliberately run OPPOSITE to the wanted order — queued is newest,
        // running oldest — so a date-only sort produces the exact reverse and this
        // test can only pass on the status key.
        const running = await at("running", 3);
        const paused = await at("paused", 2);
        const queued = await at("queued", 1);

        const { runs } = await db.runs.list({ statuses: ["queued", "running", "paused"] });

        expect(runs.map((r) => r.id)).toEqual([running, paused, queued]);
      });

      it("leaves terminal runs purely chronological — the day/week ranges are unchanged", async () => {
        const older = await at("succeeded", 20);
        const newer = await at("failed", 10);
        const newest = await at("cancelled", 5);

        const { runs } = await db.runs.list();

        expect(runs.map((r) => r.id)).toEqual([newest, newer, older]);
      });

      it("floats an in-flight run above terminal ones even in an unfiltered range", async () => {
        await at("succeeded", 1);
        const running = await at("running", 90);

        const { runs } = await db.runs.list();

        expect(runs[0]!.id).toBe(running);
      });

      it("paginates consistently — page 2 never repeats or drops a row", async () => {
        const running = await at("running", 60);
        for (let i = 0; i < 30; i++) await at("queued", 30 - i);

        const p1 = await db.runs.list({ limit: 20, statuses: ["queued", "running", "paused"] });
        const p2 = await db.runs.list({
          limit: 20,
          offset: 20,
          statuses: ["queued", "running", "paused"],
        });

        expect(p1.runs[0]!.id).toBe(running);
        const ids = [...p1.runs, ...p2.runs].map((r) => r.id);
        expect(ids).toHaveLength(31);
        expect(new Set(ids).size).toBe(31);
      });
    });
  });
}
