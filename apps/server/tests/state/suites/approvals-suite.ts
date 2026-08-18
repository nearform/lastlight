/**
 * `ApprovalStore` — the approval lifecycle reads and writes.
 *
 * Bodies moved verbatim from the pre-Phase-3 `tests/state/db.test.ts`
 * (`workflow_approvals CRUD`) and `tests/state/approval-store.test.ts`.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { randomUUID } from "crypto";
import type { StateDb } from "#src/state/db.js";
import type { MakeDb, SuiteOpts } from "../store-suite.js";

export function runApprovalsSuite(makeDb: MakeDb, _opts: SuiteOpts): void {
  describe("ApprovalStore", () => {
    let db: StateDb;

    beforeEach(async () => {
      db = await makeDb();
    });

    describe("workflow_approvals CRUD", () => {
      it("creates an approval and retrieves it by ID", async () => {
        const id = randomUUID();
        const workflowRunId = randomUUID();
        await db.runs.createRun({ id: workflowRunId, workflowName: "build", triggerId: "owner/repo#20", currentPhase: "architect", status: "running", startedAt: new Date().toISOString() });

        const now = new Date().toISOString();
        await db.approvals.create({
          id,
          workflowRunId,
          gate: "post_architect",
          summary: "Plan ready for review",
          requestedBy: "alice",
          createdAt: now,
        });

        const approval = await db.approvals.getById(id);
        expect(approval).not.toBeNull();
        expect(approval!.id).toBe(id);
        expect(approval!.workflowRunId).toBe(workflowRunId);
        expect(approval!.gate).toBe("post_architect");
        expect(approval!.summary).toBe("Plan ready for review");
        expect(approval!.status).toBe("pending");
        expect(approval!.requestedBy).toBe("alice");
        expect(approval!.createdAt).toBe(now);
      });

      it("returns null for a non-existent approval", async () => {
        expect(await db.approvals.getById("no-such-id")).toBeNull();
      });

      it("getPendingApprovalForWorkflow returns pending approval", async () => {
        const workflowRunId = randomUUID();
        await db.runs.createRun({ id: workflowRunId, workflowName: "build", triggerId: "owner/repo#21", currentPhase: "architect", status: "running", startedAt: new Date().toISOString() });

        const approvalId = randomUUID();
        await db.approvals.create({ id: approvalId, workflowRunId, gate: "post_architect", summary: "Test", createdAt: new Date().toISOString() });

        const approval = await db.approvals.getPendingForWorkflow(workflowRunId);
        expect(approval).not.toBeNull();
        expect(approval!.id).toBe(approvalId);
        expect(approval!.status).toBe("pending");
      });

      it("getPendingApprovalForWorkflow returns null when no pending approval", async () => {
        expect(await db.approvals.getPendingForWorkflow("no-such-workflow")).toBeNull();
      });

      it("getPendingApprovalByTrigger returns pending approval by trigger ID", async () => {
        const workflowRunId = randomUUID();
        const triggerId = "owner/repo#22";
        await db.runs.createRun({ id: workflowRunId, workflowName: "build", triggerId, currentPhase: "architect", status: "running", startedAt: new Date().toISOString() });

        const approvalId = randomUUID();
        await db.approvals.create({ id: approvalId, workflowRunId, gate: "post_architect", summary: "Test", createdAt: new Date().toISOString() });

        const approval = await db.approvals.getPendingByTrigger(triggerId);
        expect(approval).not.toBeNull();
        expect(approval!.id).toBe(approvalId);
      });

      it("getPendingApprovalByTrigger returns null when trigger has no pending approval", async () => {
        expect(await db.approvals.getPendingByTrigger("owner/repo#9999")).toBeNull();
      });

      it("listPendingApprovals returns all pending approvals", async () => {
        for (let i = 0; i < 3; i++) {
          const workflowRunId = randomUUID();
          await db.runs.createRun({ id: workflowRunId, workflowName: "build", triggerId: `owner/repo#${30 + i}`, currentPhase: "architect", status: "running", startedAt: new Date().toISOString() });
          await db.approvals.create({ id: randomUUID(), workflowRunId, gate: "post_architect", summary: `Summary ${i}`, createdAt: new Date().toISOString() });
        }

        const pending = await db.approvals.listPending();
        expect(pending.length).toBeGreaterThanOrEqual(3);
        expect(pending.every((a) => a.status === "pending")).toBe(true);
      });

      it("respondToApproval sets status and respondedBy", async () => {
        const workflowRunId = randomUUID();
        await db.runs.createRun({ id: workflowRunId, workflowName: "build", triggerId: "owner/repo#23", currentPhase: "architect", status: "running", startedAt: new Date().toISOString() });

        const approvalId = randomUUID();
        await db.approvals.create({ id: approvalId, workflowRunId, gate: "post_architect", summary: "Test", createdAt: new Date().toISOString() });

        await db.approvals.respond(approvalId, "approved", "bob");

        const approval = await db.approvals.getById(approvalId);
        expect(approval!.status).toBe("approved");
        expect(approval!.respondedBy).toBe("bob");
        expect(approval!.respondedAt).toBeTruthy();
        expect(approval!.response).toBeUndefined();
      });

      it("respondToApproval stores rejection reason", async () => {
        const workflowRunId = randomUUID();
        await db.runs.createRun({ id: workflowRunId, workflowName: "build", triggerId: "owner/repo#24", currentPhase: "architect", status: "running", startedAt: new Date().toISOString() });

        const approvalId = randomUUID();
        await db.approvals.create({ id: approvalId, workflowRunId, gate: "post_architect", summary: "Test", createdAt: new Date().toISOString() });

        await db.approvals.respond(approvalId, "rejected", "carol", "Plan is incomplete");

        const approval = await db.approvals.getById(approvalId);
        expect(approval!.status).toBe("rejected");
        expect(approval!.respondedBy).toBe("carol");
        expect(approval!.response).toBe("Plan is incomplete");
      });

      it("getPendingApprovalForWorkflow ignores responded approvals", async () => {
        const workflowRunId = randomUUID();
        await db.runs.createRun({ id: workflowRunId, workflowName: "build", triggerId: "owner/repo#25", currentPhase: "architect", status: "running", startedAt: new Date().toISOString() });

        const approvalId = randomUUID();
        await db.approvals.create({ id: approvalId, workflowRunId, gate: "post_architect", summary: "Test", createdAt: new Date().toISOString() });
        await db.approvals.respond(approvalId, "approved", "dave");

        expect(await db.approvals.getPendingForWorkflow(workflowRunId)).toBeNull();
      });
    });

    describe("ApprovalStore.listByArtifact", () => {
      it("returns approvals for the artifact sorted newest first", async () => {
        const runId = randomUUID();
        const artifact = "architect-plan.md";

        const olderId = randomUUID();
        await db.approvals.create({
          id: olderId,
          workflowRunId: runId,
          gate: "post_architect",
          summary: "Plan ready",
          artifact,
          createdAt: "2024-01-01T10:00:00.000Z",
        });

        const newerId = randomUUID();
        await db.approvals.create({
          id: newerId,
          workflowRunId: runId,
          gate: "post_architect",
          summary: "Plan re-requested",
          artifact,
          createdAt: "2024-01-02T10:00:00.000Z",
        });

        const approvals = await db.approvals.listByArtifact(artifact);
        expect(approvals.map((a) => a.id)).toEqual([newerId, olderId]);
        expect(approvals[0]!.createdAt).toBe("2024-01-02T10:00:00.000Z");
        expect(approvals[1]!.createdAt).toBe("2024-01-01T10:00:00.000Z");
      });

      it("filters out approvals for other artifacts and surfaces resolved rows", async () => {
        const runId = randomUUID();
        const artifact = "architect-plan.md";

        const pendingId = randomUUID();
        await db.approvals.create({
          id: pendingId,
          workflowRunId: runId,
          gate: "post_architect",
          summary: "Plan ready",
          artifact,
          createdAt: "2024-01-03T10:00:00.000Z",
        });

        const rejectedId = randomUUID();
        await db.approvals.create({
          id: rejectedId,
          workflowRunId: runId,
          gate: "post_architect",
          summary: "Plan revised",
          artifact,
          createdAt: "2024-01-04T10:00:00.000Z",
        });
        await db.approvals.respond(rejectedId, "rejected", "alice", "needs work");

        await db.approvals.create({
          id: randomUUID(),
          workflowRunId: runId,
          gate: "post_architect",
          summary: "Different doc",
          artifact: "status.md",
          createdAt: "2024-01-05T10:00:00.000Z",
        });

        const approvals = await db.approvals.listByArtifact(artifact);
        expect(approvals.map((a) => a.id)).toEqual([rejectedId, pendingId]);
        expect(approvals[0]!.status).toBe("rejected");
        expect(approvals[0]!.respondedBy).toBe("alice");
      });
    });
  });
}
