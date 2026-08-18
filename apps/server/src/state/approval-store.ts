import { and, asc, desc, eq } from "drizzle-orm";
import {
  nullsToUndefined,
  tablesOf,
  type StateClient,
  type StateDbc,
  type StateTables,
} from "./client.js";
import { changes } from "./dialect.js";

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

/** The row shape the builder returns for this table, before normalization. */
type ApprovalRow = StateTables["workflowApprovals"]["$inferSelect"];

/**
 * Owns the `workflow_approvals` table — the human-in-the-loop gates a workflow
 * run can pause on. Carved out of the old `StateDb` god-class (issue #97).
 *
 * Pure single-table reads/writes; it holds no transaction of its own. The
 * cross-table lifecycle operations that pair an approval mutation with a run
 * status flip (resolve-and-resume, resolve-and-fail, pause-for-approval) live
 * on {@link WorkflowRunStore}, the aggregate root, which is injected with an
 * instance of this store and calls these methods inside a single transaction.
 * That is what the trailing `dbc` parameter on `create` / `respond` /
 * `resolveReplyGate` / `getById` is for: they run against the enclosing
 * transaction when the aggregate passes one, and against the root client
 * otherwise.
 */
export class ApprovalStore {
  /**
   * Table objects for THIS client's dialect. Every method destructures what it
   * needs off this instead of importing from `schema/sqlite.js` — see
   * `client.ts` → {@link tablesOf} for why the cast alone cannot do it.
   */
  private readonly t: StateTables;

  constructor(private client: StateClient) {
    this.t = tablesOf(client);
  }

  /** Create a new pending approval request */
  async create(
    approval: Omit<WorkflowApproval, "status" | "respondedBy" | "response" | "respondedAt" | "kind"> & {
      kind?: WorkflowApproval["kind"];
    },
    dbc: StateDbc = this.client,
  ): Promise<void> {
    const { workflowApprovals } = this.t;
    await dbc.insert(workflowApprovals).values({
      id: approval.id,
      workflowRunId: approval.workflowRunId,
      gate: approval.gate,
      summary: approval.summary,
      status: "pending",
      kind: approval.kind ?? "approve",
      artifact: approval.artifact ?? null,
      requestedBy: approval.requestedBy ?? null,
      createdAt: approval.createdAt,
    });
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
  async resolveReplyGate(
    id: string,
    replyText: string,
    responder: string,
    dbc: StateDbc = this.client,
  ): Promise<number> {
    const { workflowApprovals } = this.t;
    const now = new Date().toISOString();
    const result = await dbc
      .update(workflowApprovals)
      .set({ status: "approved", respondedBy: responder, response: replyText, respondedAt: now })
      .where(
        and(
          eq(workflowApprovals.id, id),
          eq(workflowApprovals.kind, "reply"),
          eq(workflowApprovals.status, "pending"),
        ),
      );
    return changes(result);
  }

  /**
   * Find the most recent pending reply gate for a given trigger id. Used by
   * the router to short-circuit free-form replies on a paused socratic
   * explore loop without re-running classifier logic.
   */
  async getPendingReplyGateByTrigger(triggerId: string): Promise<WorkflowApproval | null> {
    const { workflowApprovals, workflowRuns } = this.t;
    const [row] = await this.client
      .select(approvalColumns(this.t))
      .from(workflowApprovals)
      .innerJoin(workflowRuns, eq(workflowApprovals.workflowRunId, workflowRuns.id))
      .where(
        and(
          eq(workflowRuns.triggerId, triggerId),
          eq(workflowApprovals.status, "pending"),
          eq(workflowApprovals.kind, "reply"),
        ),
      )
      .orderBy(desc(workflowApprovals.createdAt))
      .limit(1);
    return row ? deserialize(row) : null;
  }

  /** Get a single approval by ID */
  async getById(id: string, dbc: StateDbc = this.client): Promise<WorkflowApproval | null> {
    const { workflowApprovals } = this.t;
    const [row] = await dbc
      .select()
      .from(workflowApprovals)
      .where(eq(workflowApprovals.id, id))
      .limit(1);
    return row ? deserialize(row) : null;
  }

  /** Find the pending approval for a workflow run */
  async getPendingForWorkflow(workflowRunId: string): Promise<WorkflowApproval | null> {
    const { workflowApprovals } = this.t;
    const [row] = await this.client
      .select()
      .from(workflowApprovals)
      .where(
        and(
          eq(workflowApprovals.workflowRunId, workflowRunId),
          eq(workflowApprovals.status, "pending"),
        ),
      )
      .limit(1);
    return row ? deserialize(row) : null;
  }

  /** Find the pending approval by trigger ID (join with workflow_runs) */
  async getPendingByTrigger(triggerId: string): Promise<WorkflowApproval | null> {
    const { workflowApprovals, workflowRuns } = this.t;
    const [row] = await this.client
      .select(approvalColumns(this.t))
      .from(workflowApprovals)
      .innerJoin(workflowRuns, eq(workflowApprovals.workflowRunId, workflowRuns.id))
      .where(and(eq(workflowRuns.triggerId, triggerId), eq(workflowApprovals.status, "pending")))
      .orderBy(desc(workflowApprovals.createdAt))
      .limit(1);
    return row ? deserialize(row) : null;
  }

  /**
   * List every approval for a workflow run — all statuses (pending, approved,
   * rejected), oldest first. Powers the dashboard's per-run approval history
   * (who approved/rejected a gate, when, and any comment). Unlike
   * {@link getPendingForWorkflow} this does not filter on status.
   */
  async listForWorkflow(workflowRunId: string): Promise<WorkflowApproval[]> {
    const { workflowApprovals } = this.t;
    const rows = await this.client
      .select()
      .from(workflowApprovals)
      .where(eq(workflowApprovals.workflowRunId, workflowRunId))
      .orderBy(asc(workflowApprovals.createdAt));
    return rows.map(deserialize);
  }

  /** List all approvals carrying a specific artifact name, newest first */
  async listByArtifact(artifact: string): Promise<WorkflowApproval[]> {
    const { workflowApprovals } = this.t;
    const rows = await this.client
      .select()
      .from(workflowApprovals)
      .where(eq(workflowApprovals.artifact, artifact))
      .orderBy(desc(workflowApprovals.createdAt));
    return rows.map(deserialize);
  }

  /** List all pending approvals */
  async listPending(): Promise<WorkflowApproval[]> {
    const { workflowApprovals } = this.t;
    const rows = await this.client
      .select()
      .from(workflowApprovals)
      .where(eq(workflowApprovals.status, "pending"))
      .orderBy(desc(workflowApprovals.createdAt));
    return rows.map(deserialize);
  }

  /**
   * Record the response to a still-pending approval.
   *
   * Returns the number of rows changed so aggregate lifecycle operations can
   * use this as a compare-and-set guard: if two responders race, only the
   * first pending row update succeeds and the loser must not resume/fail the
   * workflow a second time.
   */
  async respond(
    id: string,
    status: 'approved' | 'rejected',
    respondedBy: string,
    response?: string,
    dbc: StateDbc = this.client,
  ): Promise<number> {
    const { workflowApprovals } = this.t;
    const now = new Date().toISOString();
    const result = await dbc
      .update(workflowApprovals)
      .set({ status, respondedBy, response: response ?? null, respondedAt: now })
      .where(and(eq(workflowApprovals.id, id), eq(workflowApprovals.status, "pending")));
    return changes(result);
  }
}

/**
 * Explicit column map for the two joined reads. A bare `.select()` across a
 * join returns `{ workflow_approvals: {...}, workflow_runs: {...} }`; naming
 * the columns keeps those two methods returning a flat approval row like every
 * other read here.
 */
const approvalColumns = ({ workflowApprovals }: StateTables) => ({
  id: workflowApprovals.id,
  workflowRunId: workflowApprovals.workflowRunId,
  gate: workflowApprovals.gate,
  summary: workflowApprovals.summary,
  status: workflowApprovals.status,
  requestedBy: workflowApprovals.requestedBy,
  respondedBy: workflowApprovals.respondedBy,
  response: workflowApprovals.response,
  respondedAt: workflowApprovals.respondedAt,
  createdAt: workflowApprovals.createdAt,
  kind: workflowApprovals.kind,
  artifact: workflowApprovals.artifact,
});

/**
 * Builder rows are already camelCase, so this is down to two jobs: turn the
 * nullable columns into absent optionals, and keep the `kind` fallback for
 * rows written before that column existed.
 */
function deserialize(row: ApprovalRow): WorkflowApproval {
  const r = nullsToUndefined(row);
  return {
    ...r,
    status: r.status as WorkflowApproval["status"],
    kind: (r.kind || "approve") as WorkflowApproval["kind"],
  };
}
