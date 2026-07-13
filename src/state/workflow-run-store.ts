import type Database from "better-sqlite3";
import type { ApprovalStore } from "./approval-store.js";

export interface PhaseHistoryEntry {
  phase: string;
  timestamp: string;
  success: boolean;
  summary?: string;
}

export interface WorkflowRun {
  id: string;
  workflowName: string;
  triggerId: string;
  repo?: string;
  issueNumber?: number;
  currentPhase: string;
  phaseHistory: PhaseHistoryEntry[];
  status: "running" | "paused" | "succeeded" | "failed" | "cancelled";
  context?: Record<string, unknown>;
  /**
   * Mutable phase-to-phase state, merged at the top level by
   * `mergeScratch`. Distinct from `context` (which is the immutable trigger
   * input) — used by features like the socratic explore loop to accumulate
   * Q&A across reply-gate pauses.
   */
  scratch?: Record<string, unknown>;
  /**
   * Number of times `resumeOrphanedWorkflows` has re-dispatched this run
   * after a harness restart. Bounded by a small limit so a run that
   * crashes the host (e.g. agent OOM) is marked failed instead of
   * retried forever.
   */
  restartCount?: number;
  startedAt: string;
  updatedAt: string;
  finishedAt?: string;
}

/** A non-agent phase marker folded into an atomic lifecycle op. */
export interface PhaseMarker {
  phase: string;
  summary?: string;
}

/**
 * Aggregate root for a workflow run's lifecycle. Owns the `workflow_runs`
 * table (including the `phase_history` JSON column) and the named, atomic
 * transitions a run moves through: create → pause-for-approval →
 * resume/finish, plus gate resolution and the socratic reply append.
 *
 * Carved out of the old `StateDb` god-class (issue #97). The deepening: every
 * multi-step mutation that previously lived as an un-guarded read-modify-write
 * chain in `index.ts` / `admin/routes.ts` / `phase-executor.ts` is now a
 * single named operation wrapped in ONE `better-sqlite3` transaction — a throw
 * partway through rolls the whole thing back, so a run can never be left
 * marked `running` with its gate unresolved (the hazard the issue calls out).
 *
 * Constructed with an injected {@link ApprovalStore}: an approval has no life
 * independent of its run, so the cross-table ops call the approval store's
 * single-table writes from inside this store's transaction. Both stores MUST
 * be built from the same `Database` — better-sqlite3 transactions are
 * per-connection.
 *
 * The long-running re-dispatch (`dispatchWorkflow`, which spawns a Docker
 * sandbox for minutes) is deliberately NOT part of any transaction here —
 * better-sqlite3 transactions are synchronous. The atomic boundary is the DB
 * mutations only; the caller dispatches after the transaction commits.
 */
export class WorkflowRunStore {
  private db: Database.Database;
  private approvals: ApprovalStore;

  constructor(db: Database.Database, deps: { approvals: ApprovalStore }) {
    this.db = db;
    this.approvals = deps.approvals;
  }

  // ── Plain single-mutation operations ───────────────────────────

  /** Create a new workflow run record */
  createRun(run: Omit<WorkflowRun, "phaseHistory" | "updatedAt">): void {
    const now = new Date().toISOString();
    this.db.prepare(`
      INSERT INTO workflow_runs (id, workflow_name, trigger_id, repo, issue_number, current_phase, phase_history, status, context, scratch, started_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, '[]', ?, ?, ?, ?, ?)
    `).run(
      run.id,
      run.workflowName,
      run.triggerId,
      run.repo ?? null,
      run.issueNumber ?? null,
      run.currentPhase,
      run.status,
      run.context ? JSON.stringify(run.context) : null,
      run.scratch ? JSON.stringify(run.scratch) : null,
      run.startedAt,
      now,
    );
  }

  /**
   * Top-level merge of `patch` into the workflow run's scratch state.
   * Loop iterations can append to `scratch.socratic.qa` without clobbering
   * other keys.
   *
   * Throws if `patch` is not JSON-serializable (e.g. it contains a BigInt) —
   * which is exactly how the atomic ops prove their rollback: a poison patch
   * makes `JSON.stringify` throw mid-transaction.
   */
  mergeScratch(id: string, patch: Record<string, unknown>): void {
    const now = new Date().toISOString();
    const row = this.db
      .prepare(`SELECT scratch FROM workflow_runs WHERE id = ?`)
      .get(id) as { scratch: string | null } | undefined;
    if (!row) return;
    const current = row.scratch ? (JSON.parse(row.scratch) as Record<string, unknown>) : {};
    const merged = { ...current, ...patch };
    // Stringify BEFORE the UPDATE so a non-serializable patch throws without
    // having mutated the row — keeps the op all-or-nothing even outside a txn.
    const serialized = JSON.stringify(merged);
    this.db
      .prepare(`UPDATE workflow_runs SET scratch = ?, updated_at = ? WHERE id = ?`)
      .run(serialized, now, id);
  }

  /**
   * Update the current phase and append to phase history. This is the single
   * seam through which all phase-history writes flow (issue #97 defers the
   * full `phase_history`/`executions` reconciliation to a follow-up, but
   * routes every write through here so that future change touches one method
   * instead of ~10 call sites).
   */
  appendPhase(id: string, phase: string, entry: PhaseHistoryEntry): void {
    const now = new Date().toISOString();
    const row = this.db.prepare(`SELECT phase_history FROM workflow_runs WHERE id = ?`).get(id) as { phase_history: string } | undefined;
    if (!row) return;
    const history: PhaseHistoryEntry[] = JSON.parse(row.phase_history);
    history.push(entry);
    this.db.prepare(`
      UPDATE workflow_runs SET current_phase = ?, phase_history = ?, updated_at = ? WHERE id = ?
    `).run(phase, JSON.stringify(history), now, id);
  }

  /** Get a single workflow run by ID */
  getRun(id: string): WorkflowRun | null {
    const row = this.db.prepare(`SELECT * FROM workflow_runs WHERE id = ?`).get(id) as Record<string, unknown> | undefined;
    return row ? this.deserialize(row) : null;
  }

  /** Find the most recent active (running or paused) workflow run for a trigger */
  getByTrigger(triggerId: string): WorkflowRun | null {
    const row = this.db.prepare(`
      SELECT * FROM workflow_runs
      WHERE trigger_id = ? AND status IN ('running', 'paused')
      ORDER BY started_at DESC
      LIMIT 1
    `).get(triggerId) as Record<string, unknown> | undefined;
    return row ? this.deserialize(row) : null;
  }

  /**
   * True if any run of `workflowName` exists for this trigger, in ANY status.
   * Unlike `getByTrigger` (active runs only), this also sees a build that has
   * already succeeded/failed/cancelled — the signal the router uses to gate
   * reporter-driven re-triage to the pre-build window.
   */
  hasRunForTrigger(triggerId: string, workflowName: string): boolean {
    const row = this.db.prepare(`
      SELECT 1 FROM workflow_runs
      WHERE trigger_id = ? AND workflow_name = ?
      LIMIT 1
    `).get(triggerId, workflowName);
    return !!row;
  }

  /** List all active (running or paused) workflow runs */
  listActive(): WorkflowRun[] {
    const rows = this.db.prepare(`
      SELECT * FROM workflow_runs WHERE status IN ('running', 'paused') ORDER BY started_at DESC
    `).all() as Record<string, unknown>[];
    return rows.map((r) => this.deserialize(r));
  }

  /** List recent workflow runs, ordered by start time descending */
  listRecent(limit = 20): WorkflowRun[] {
    const rows = this.db.prepare(`
      SELECT * FROM workflow_runs ORDER BY started_at DESC LIMIT ?
    `).all(limit) as Record<string, unknown>[];
    return rows.map((r) => this.deserialize(r));
  }

  /**
   * List workflow runs with pagination + filters. Returns the page slice
   * AND the post-filter total so the dashboard knows how many remain.
   *
   * - sinceIso filters `started_at >= sinceIso` (used for the header date range).
   * - workflowName filters by exact `workflow_name`.
   * - statuses filters to one of the workflow statuses (`running`, `paused`,
   *   `succeeded`, `failed`, `cancelled`). Used for the dashboard's "live"
   *   filter, which maps to ['running','paused'].
   */
  list(opts: {
    limit?: number;
    offset?: number;
    sinceIso?: string;
    workflowName?: string;
    statuses?: string[];
  } = {}): { runs: WorkflowRun[]; total: number } {
    const limit = opts.limit ?? 20;
    const offset = opts.offset ?? 0;

    const where: string[] = [];
    const params: unknown[] = [];
    if (opts.sinceIso) {
      where.push("started_at >= ?");
      params.push(opts.sinceIso);
    }
    if (opts.workflowName) {
      where.push("workflow_name = ?");
      params.push(opts.workflowName);
    }
    if (opts.statuses && opts.statuses.length > 0) {
      where.push(`status IN (${opts.statuses.map(() => "?").join(",")})`);
      params.push(...opts.statuses);
    }
    const whereClause = where.length > 0 ? `WHERE ${where.join(" AND ")}` : "";

    const total = (
      this.db
        .prepare(`SELECT COUNT(*) as c FROM workflow_runs ${whereClause}`)
        .get(...params) as { c: number }
    ).c;

    // Explicit column list — the heavy JSON blobs (`context`, `scratch`)
    // can each be many MB on long-running build runs and
    // the dashboard list view doesn't read them. Returning them turned a
    // 20-row page into a 14MB payload. The single-row endpoint
    // (`getRun`) still uses `SELECT *` so the detail panel keeps
    // the full row when the user picks one.
    const rows = this.db
      .prepare(
        `SELECT
           id, workflow_name, trigger_id, repo, issue_number,
           current_phase, phase_history, status,
           restart_count, started_at, updated_at, finished_at
         FROM workflow_runs
         ${whereClause}
         ORDER BY started_at DESC
         LIMIT ? OFFSET ?`,
      )
      .all(...params, limit, offset) as Record<string, unknown>[];

    return {
      runs: rows.map((r) => this.deserialize(r)),
      total,
    };
  }

  /** Distinct workflow_name values, sorted alphabetically. */
  distinctNames(): string[] {
    const rows = this.db
      .prepare(`SELECT DISTINCT workflow_name FROM workflow_runs ORDER BY workflow_name ASC`)
      .all() as { workflow_name: string }[];
    return rows.map((r) => r.workflow_name);
  }

  /**
   * Mark a workflow run as finished. Plain status flip when called with just
   * `{ error }`; when a `terminalMarker` is supplied (the runner's
   * `on_success.set_phase`), the phase-history append and the status flip
   * happen in ONE transaction so the dashboard never sees the terminal phase
   * without the finished status, or vice versa.
   */
  finishRun(
    id: string,
    status: "succeeded" | "failed" | "cancelled",
    opts: { error?: string; terminalMarker?: PhaseMarker } = {},
  ): void {
    const apply = () => {
      if (opts.terminalMarker) {
        this.appendPhase(id, opts.terminalMarker.phase, {
          phase: opts.terminalMarker.phase,
          timestamp: new Date().toISOString(),
          success: true,
          summary: opts.terminalMarker.summary,
        });
      }
      this.flipFinished(id, status, opts.error);
    };
    if (opts.terminalMarker) {
      this.db.transaction(apply)();
    } else {
      apply();
    }
  }

  private flipFinished(id: string, status: "succeeded" | "failed" | "cancelled", error?: string): void {
    const now = new Date().toISOString();
    this.db.prepare(`
      UPDATE workflow_runs SET status = ?, finished_at = ?, updated_at = ?, context = CASE
        WHEN ? IS NOT NULL THEN json_patch(COALESCE(context, '{}'), json_object('error', ?))
        ELSE context
      END WHERE id = ?
    `).run(status, now, now, error ?? null, error ?? null, id);
  }

  /** Cancel a workflow run */
  cancelRun(id: string): void {
    const now = new Date().toISOString();
    this.db.prepare(`
      UPDATE workflow_runs SET status = 'cancelled', updated_at = ?, finished_at = ? WHERE id = ?
    `).run(now, now, id);
  }

  /** Pause a workflow run (waiting for approval) */
  setPaused(id: string): void {
    const now = new Date().toISOString();
    this.db.prepare(`
      UPDATE workflow_runs SET status = 'paused', updated_at = ? WHERE id = ?
    `).run(now, id);
  }

  /** Resume a paused workflow run (set back to running) */
  setRunning(id: string): void {
    const now = new Date().toISOString();
    this.db.prepare(`
      UPDATE workflow_runs SET status = 'running', updated_at = ? WHERE id = ?
    `).run(now, id);
  }

  /**
   * Restart a FAILED run so it can be retried from the phase that failed.
   * Unlike {@link setRunning} this also clears the terminal markers a failure
   * left behind — `finished_at` and the `context.error` string `flipFinished`
   * wrote — so the row reads live again rather than "failed at …". The taskId,
   * branch, scratch and phase_history are all preserved, so the ledger-driven
   * re-dispatch (`resumeSimpleRun`) resumes from the failed phase with the same
   * context.
   *
   * Guarded by `WHERE status = 'failed'` and returns the changed-row count so
   * the caller can make retry a compare-and-set: a second concurrent retry
   * click sees 0 rows changed and does NOT dispatch again.
   */
  restartRun(id: string): number {
    const now = new Date().toISOString();
    const info = this.db.prepare(`
      UPDATE workflow_runs
      SET status = 'running',
          finished_at = NULL,
          updated_at = ?,
          restart_count = COALESCE(restart_count, 0) + 1,
          context = json_remove(COALESCE(context, '{}'), '$.error')
      WHERE id = ? AND status = 'failed'
    `).run(now, id);
    return info.changes;
  }

  /**
   * Increment the restart counter and return the new value. Used by
   * `resumeOrphanedWorkflows` to enforce a retry budget so a run that
   * crashes the host (agent OOM, etc.) eventually self-terminates instead
   * of being re-dispatched on every boot.
   */
  incrementRestartCount(id: string): number {
    const now = new Date().toISOString();
    this.db.prepare(`
      UPDATE workflow_runs
      SET restart_count = COALESCE(restart_count, 0) + 1, updated_at = ?
      WHERE id = ?
    `).run(now, id);
    const row = this.db.prepare(`SELECT restart_count FROM workflow_runs WHERE id = ?`)
      .get(id) as { restart_count: number } | undefined;
    return row?.restart_count ?? 0;
  }

  private deserialize(row: Record<string, unknown>): WorkflowRun {
    return {
      id: row.id as string,
      workflowName: row.workflow_name as string,
      triggerId: row.trigger_id as string,
      repo: row.repo as string | undefined,
      issueNumber: row.issue_number as number | undefined,
      currentPhase: row.current_phase as string,
      phaseHistory: JSON.parse(row.phase_history as string) as PhaseHistoryEntry[],
      status: row.status as WorkflowRun["status"],
      context: row.context ? JSON.parse(row.context as string) as Record<string, unknown> : undefined,
      scratch: row.scratch ? JSON.parse(row.scratch as string) as Record<string, unknown> : undefined,
      restartCount: typeof row.restart_count === "number" ? row.restart_count : 0,
      startedAt: row.started_at as string,
      updatedAt: row.updated_at as string,
      finishedAt: row.finished_at as string | undefined,
    };
  }

  // ── Named atomic lifecycle operations ──────────────────────────
  //
  // Each wraps ONE better-sqlite3 transaction. The long-running re-dispatch
  // (`dispatchWorkflow`) stays OUT of these — the caller dispatches after the
  // transaction commits.

  /**
   * Resolve a socratic reply gate and resume the run, atomically: the reply
   * gate flips `pending → approved` (recording the reply text), the caller's
   * scratch patch merges in, and the run goes back to `running` — all in one
   * transaction. A throw anywhere rolls the whole thing back, so the run can
   * never be left `running` with its gate unresolved or its reply lost (the
   * hazard issue #97 calls out).
   *
   * The reply-gate resolve is guarded by `kind = 'reply' AND status = 'pending'`
   * (see {@link ApprovalStore.resolveReplyGate}); if it changes zero rows —
   * because a racing reply already resolved the gate — this throws and the
   * transaction aborts, which is the double-reply concurrency guard.
   *
   * The caller (`index.ts`) computes the explore-domain `scratch.socratic.qa`
   * patch and passes it in; the generic store stays ignorant of that shape.
   */
  /**
   * Pause a run for an approval gate, atomically: create the pending approval,
   * optionally merge a scratch patch (loops persist their iteration state
   * here), append the `waiting_approval` phase marker, and flip the run to
   * `paused` — all in one transaction. Covers the standard post-phase gate,
   * the reviewer-loop gate, and the interactive generic-loop gate.
   *
   * The marker is appended BEFORE the approval insert so that an insert
   * failure provably rolls back the phase-history write (the injected
   * ApprovalStore participates in the same transaction); ordering is invisible
   * outside the transaction.
   */
  pauseForApproval(
    runId: string,
    approval: Parameters<ApprovalStore["create"]>[0],
    marker: PhaseMarker,
    scratchPatch?: Record<string, unknown>,
  ): void {
    this.db.transaction(() => {
      this.appendPhase(runId, marker.phase, {
        phase: marker.phase,
        timestamp: new Date().toISOString(),
        success: true,
        summary: marker.summary,
      });
      if (scratchPatch) this.mergeScratch(runId, scratchPatch);
      this.approvals.create(approval);
      this.setPaused(runId);
    })();
  }

  /**
   * Approve a gate and resume its run, atomically. Reads the approval to find
   * its run, records the `approved` response, and flips the run back to
   * `running` in one transaction; returns the run so the caller can dispatch.
   * Used by the GitHub/Slack path (`index.ts`), which validates the dispatch
   * target BEFORE calling this so the flip to `running` is always followed by a
   * dispatch. The dashboard path does NOT use this — it can't prove a dispatch
   * will follow before responding, so it records the approval and lets
   * `resumeWorkflow` flip the run only as part of an actual dispatch.
   */
  resolveGateAndResume(approvalId: string, responder: string): WorkflowRun | null {
    return this.db.transaction(() => {
      const approval = this.approvals.getById(approvalId);
      if (!approval) throw new Error(`approval ${approvalId} not found`);
      const changed = this.approvals.respond(approvalId, "approved", responder);
      if (changed !== 1) {
        throw new Error(`approval ${approvalId} is not pending (already resolved?)`);
      }
      this.setRunning(approval.workflowRunId);
      return this.getRun(approval.workflowRunId);
    })();
  }

  /**
   * Reject a gate and fail its run, atomically: record the `rejected` response
   * (with reason) and flip the run to `failed` in one transaction. Returns the
   * run (or null if the approval's run was already gone).
   */
  resolveGateAndFail(approvalId: string, responder: string, reason?: string): WorkflowRun | null {
    return this.db.transaction(() => {
      const approval = this.approvals.getById(approvalId);
      if (!approval) throw new Error(`approval ${approvalId} not found`);
      const changed = this.approvals.respond(approvalId, "rejected", responder, reason);
      if (changed !== 1) {
        throw new Error(`approval ${approvalId} is not pending (already resolved?)`);
      }
      this.flipFinished(approval.workflowRunId, "failed", `Rejected: ${reason || "no reason given"}`);
      return this.getRun(approval.workflowRunId);
    })();
  }

  resolveReplyGateAndResume(
    runId: string,
    approvalId: string,
    replyText: string,
    responder: string,
    scratchPatch: Record<string, unknown>,
  ): WorkflowRun | null {
    return this.db.transaction(() => {
      const changed = this.approvals.resolveReplyGate(approvalId, replyText, responder);
      if (changed !== 1) {
        throw new Error(`reply gate ${approvalId} is not pending (already resolved?)`);
      }
      this.mergeScratch(runId, scratchPatch);
      this.setRunning(runId);
      return this.getRun(runId);
    })();
  }
}
