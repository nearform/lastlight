import type Database from "better-sqlite3";

export interface WorkflowApproval {
  id: string;
  workflowRunId: string;
  gate: string;
  summary: string;
  status: 'pending' | 'approved' | 'rejected';
  /**
   * Gate flavor. `approve` gates resolve only on an explicit approve/reject
   * command; `reply` gates resolve on any free-form reply in the same
   * thread (used by the socratic explore loop).
   */
  kind: 'approve' | 'reply';
  /**
   * Artifact (handoff doc) filename this gate is asking the reviewer to
   * approve, e.g. `architect-plan.md`. Surfaced by the focused approval view.
   */
  artifact?: string;
  requestedBy?: string;
  respondedBy?: string;
  response?: string;
  respondedAt?: string;
  createdAt: string;
}

/**
 * Owns the `workflow_approvals` table — the human-in-the-loop gates a workflow
 * run can pause on. Carved out of the old `StateDb` god-class (issue #97).
 *
 * Pure single-table reads/writes; it holds no transaction of its own. The
 * cross-table lifecycle operations that pair an approval mutation with a run
 * status flip (resolve-and-resume, resolve-and-fail, pause-for-approval) live
 * on {@link WorkflowRunStore}, the aggregate root, which is injected with an
 * instance of this store and calls these methods inside a single transaction.
 */
export class ApprovalStore {
  constructor(private db: Database.Database) {}

  /** Create a new pending approval request */
  create(
    approval: Omit<WorkflowApproval, "status" | "respondedBy" | "response" | "respondedAt" | "kind"> & {
      kind?: WorkflowApproval["kind"];
    },
  ): void {
    this.db
      .prepare(
        `
      INSERT INTO workflow_approvals (id, workflow_run_id, gate, summary, status, kind, artifact, requested_by, created_at)
      VALUES (?, ?, ?, ?, 'pending', ?, ?, ?, ?)
    `,
      )
      .run(
        approval.id,
        approval.workflowRunId,
        approval.gate,
        approval.summary,
        approval.kind ?? "approve",
        approval.artifact ?? null,
        approval.requestedBy ?? null,
        approval.createdAt,
      );
  }

  /**
   * Resolve a reply gate: marks the approval row as approved (reply gates
   * don't have approve/reject semantics — any reply is a "go") and stores
   * the reply text as the `response`. Used by the socratic explore loop.
   *
   * Guarded by `kind = 'reply' AND status = 'pending'` and returns the number
   * of rows changed (1 on success, 0 if the gate is missing / wrong kind /
   * already resolved). {@link WorkflowRunStore.resolveReplyGateAndResume} uses
   * the count as a double-reply concurrency guard — two replies racing on the
   * same thread, the second sees 0 rows and the transaction aborts before a
   * duplicate resume.
   */
  resolveReplyGate(id: string, replyText: string, responder: string): number {
    const now = new Date().toISOString();
    const result = this.db
      .prepare(
        `UPDATE workflow_approvals
           SET status = 'approved',
               responded_by = ?,
               response = ?,
               responded_at = ?
         WHERE id = ? AND kind = 'reply' AND status = 'pending'`,
      )
      .run(responder, replyText, now, id);
    return result.changes;
  }

  /**
   * Find the most recent pending reply gate for a given trigger id. Used by
   * the router to short-circuit free-form replies on a paused socratic
   * explore loop without re-running classifier logic.
   */
  getPendingReplyGateByTrigger(triggerId: string): WorkflowApproval | null {
    const row = this.db
      .prepare(
        `SELECT wa.* FROM workflow_approvals wa
         JOIN workflow_runs wr ON wa.workflow_run_id = wr.id
         WHERE wr.trigger_id = ? AND wa.status = 'pending' AND wa.kind = 'reply'
         ORDER BY wa.created_at DESC
         LIMIT 1`,
      )
      .get(triggerId) as Record<string, unknown> | undefined;
    return row ? this.deserialize(row) : null;
  }

  /** Get a single approval by ID */
  getById(id: string): WorkflowApproval | null {
    const row = this.db.prepare(`SELECT * FROM workflow_approvals WHERE id = ?`).get(id) as Record<string, unknown> | undefined;
    return row ? this.deserialize(row) : null;
  }

  /** Find the pending approval for a workflow run */
  getPendingForWorkflow(workflowRunId: string): WorkflowApproval | null {
    const row = this.db.prepare(`
      SELECT * FROM workflow_approvals WHERE workflow_run_id = ? AND status = 'pending' LIMIT 1
    `).get(workflowRunId) as Record<string, unknown> | undefined;
    return row ? this.deserialize(row) : null;
  }

  /** Find the pending approval by trigger ID (join with workflow_runs) */
  getPendingByTrigger(triggerId: string): WorkflowApproval | null {
    const row = this.db.prepare(`
      SELECT wa.* FROM workflow_approvals wa
      JOIN workflow_runs wr ON wa.workflow_run_id = wr.id
      WHERE wr.trigger_id = ? AND wa.status = 'pending'
      ORDER BY wa.created_at DESC
      LIMIT 1
    `).get(triggerId) as Record<string, unknown> | undefined;
    return row ? this.deserialize(row) : null;
  }

  /**
   * List every approval for a workflow run — all statuses (pending, approved,
   * rejected), oldest first. Powers the dashboard's per-run approval history
   * (who approved/rejected a gate, when, and any comment). Unlike
   * {@link getPendingForWorkflow} this does not filter on status.
   */
  listForWorkflow(workflowRunId: string): WorkflowApproval[] {
    const rows = this.db.prepare(`
      SELECT * FROM workflow_approvals WHERE workflow_run_id = ? ORDER BY created_at ASC
    `).all(workflowRunId) as Record<string, unknown>[];
    return rows.map((r) => this.deserialize(r));
  }

  /** List all approvals carrying a specific artifact name, newest first */
  listByArtifact(artifact: string): WorkflowApproval[] {
    const rows = this.db.prepare(`
      SELECT * FROM workflow_approvals
      WHERE artifact = ?
      ORDER BY created_at DESC
    `).all(artifact) as Record<string, unknown>[];
    return rows.map((r) => this.deserialize(r));
  }

  /** List all pending approvals */
  listPending(): WorkflowApproval[] {
    const rows = this.db.prepare(`
      SELECT * FROM workflow_approvals WHERE status = 'pending' ORDER BY created_at DESC
    `).all() as Record<string, unknown>[];
    return rows.map((r) => this.deserialize(r));
  }

  /**
   * Record the response to a still-pending approval.
   *
   * Returns the number of rows changed so aggregate lifecycle operations can
   * use this as a compare-and-set guard: if two responders race, only the
   * first pending row update succeeds and the loser must not resume/fail the
   * workflow a second time.
   */
  respond(id: string, status: 'approved' | 'rejected', respondedBy: string, response?: string): number {
    const now = new Date().toISOString();
    const result = this.db.prepare(`
      UPDATE workflow_approvals
        SET status = ?, responded_by = ?, response = ?, responded_at = ?
      WHERE id = ? AND status = 'pending'
    `).run(status, respondedBy, response ?? null, now, id);
    return result.changes;
  }

  private deserialize(row: Record<string, unknown>): WorkflowApproval {
    return {
      id: row.id as string,
      workflowRunId: row.workflow_run_id as string,
      gate: row.gate as string,
      summary: row.summary as string,
      status: row.status as WorkflowApproval['status'],
      kind: ((row.kind as string | undefined) || "approve") as WorkflowApproval["kind"],
      artifact: row.artifact as string | undefined || undefined,
      requestedBy: row.requested_by as string | undefined || undefined,
      respondedBy: row.responded_by as string | undefined || undefined,
      response: row.response as string | undefined || undefined,
      respondedAt: row.responded_at as string | undefined || undefined,
      createdAt: row.created_at as string,
    };
  }
}
