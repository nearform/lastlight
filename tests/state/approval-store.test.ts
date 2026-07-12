import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { randomUUID } from "crypto";
import { StateDb } from "#src/state/db.js";

let db: StateDb;

beforeEach(() => {
  db = new StateDb(":memory:");
});

afterEach(() => {
  db.close();
});

describe("ApprovalStore.listByArtifact", () => {
  it("returns approvals for the artifact sorted newest first", () => {
    const runId = randomUUID();
    const artifact = "architect-plan.md";

    const olderId = randomUUID();
    db.approvals.create({
      id: olderId,
      workflowRunId: runId,
      gate: "post_architect",
      summary: "Plan ready",
      artifact,
      createdAt: "2024-01-01T10:00:00.000Z",
    });

    const newerId = randomUUID();
    db.approvals.create({
      id: newerId,
      workflowRunId: runId,
      gate: "post_architect",
      summary: "Plan re-requested",
      artifact,
      createdAt: "2024-01-02T10:00:00.000Z",
    });

    const approvals = db.approvals.listByArtifact(artifact);
    expect(approvals.map((a) => a.id)).toEqual([newerId, olderId]);
    expect(approvals[0]!.createdAt).toBe("2024-01-02T10:00:00.000Z");
    expect(approvals[1]!.createdAt).toBe("2024-01-01T10:00:00.000Z");
  });

  it("filters out approvals for other artifacts and surfaces resolved rows", () => {
    const runId = randomUUID();
    const artifact = "architect-plan.md";

    const pendingId = randomUUID();
    db.approvals.create({
      id: pendingId,
      workflowRunId: runId,
      gate: "post_architect",
      summary: "Plan ready",
      artifact,
      createdAt: "2024-01-03T10:00:00.000Z",
    });

    const rejectedId = randomUUID();
    db.approvals.create({
      id: rejectedId,
      workflowRunId: runId,
      gate: "post_architect",
      summary: "Plan revised",
      artifact,
      createdAt: "2024-01-04T10:00:00.000Z",
    });
    db.approvals.respond(rejectedId, "rejected", "alice", "needs work");

    db.approvals.create({
      id: randomUUID(),
      workflowRunId: runId,
      gate: "post_architect",
      summary: "Different doc",
      artifact: "status.md",
      createdAt: "2024-01-05T10:00:00.000Z",
    });

    const approvals = db.approvals.listByArtifact(artifact);
    expect(approvals.map((a) => a.id)).toEqual([rejectedId, pendingId]);
    expect(approvals[0]!.status).toBe("rejected");
    expect(approvals[0]!.respondedBy).toBe("alice");
  });
});
