import type Database from "better-sqlite3";
import type { ApprovalStore } from "./approval-store.js";
import type { TriggerActorType } from "./user-store.js";

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
  /** GitHub org/user that owns {@link repo}. Stored as its own column so the
   *  runs list (which omits `context`) can compose the qualified `owner/repo`. */
  owner?: string;
  /** BARE repo name (no owner) — kept path-safe for taskIds / workspace dirs. */
  repo?: string;
  issueNumber?: number;
  /**
   * Who originally triggered this run (issue #205) — a GitHub login, a Slack
   * display name, or `cli`/`cron`. The run's value is the ORIGINAL trigger;
   * retry/cancel/approve actors land on the `executions` ledger, never
   * overwriting this. Free-text, joined to `users` on `login` for enrichment.
   */
  triggeredBy?: string;
  /** Coarse actor category for {@link triggeredBy}. */
  triggerActorType?: TriggerActorType;
  currentPhase: string;
  phaseHistory: PhaseHistoryEntry[];
  status: "queued" | "running" | "paused" | "succeeded" | "failed" | "cancelled";
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
  /**
   * Rolled-up totals across the run's executions (SUM of `cost_usd` and
   * input+output+cache-read tokens). Populated only by {@link WorkflowRunStore.list}
   * for the dashboard's runs view via a LEFT JOIN on `executions`; absent on
   * single-run reads (`getRun`, which selects the row without the join).
   */
  totalCostUsd?: number;
  totalTokens?: number;
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
      INSERT INTO workflow_runs (id, workflow_name, trigger_id, owner, repo, issue_number, current_phase, phase_history, status, context, scratch, started_at, updated_at, triggered_by, trigger_actor_type)
      VALUES (?, ?, ?, ?, ?, ?, ?, '[]', ?, ?, ?, ?, ?, ?, ?)
    `).run(
      run.id,
      run.workflowName,
      run.triggerId,
      run.owner ?? null,
      run.repo ?? null,
      run.issueNumber ?? null,
      run.currentPhase,
      run.status,
      run.context ? JSON.stringify(run.context) : null,
      run.scratch ? JSON.stringify(run.scratch) : null,
      run.startedAt,
      now,
      run.triggeredBy ?? null,
      run.triggerActorType ?? null,
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

  /** Find the most recent active (running, paused, or queued) workflow run for a trigger */
  getByTrigger(triggerId: string): WorkflowRun | null {
    const row = this.db.prepare(`
      SELECT * FROM workflow_runs
      WHERE trigger_id = ? AND status IN ('queued', 'running', 'paused')
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

  /**
   * The most recent SUCCEEDED run of `workflowName` for this trigger, or null.
   * Unlike `getByTrigger` (active rows only), this reads terminal history: the
   * dependency-workflow dedup guard reads the winner's stored `context.headSha`
   * to skip re-assessing a PR at a head SHA it already handled.
   */
  latestSucceededForTrigger(workflowName: string, triggerId: string): WorkflowRun | null {
    const row = this.db.prepare(`
      SELECT * FROM workflow_runs
      WHERE trigger_id = ? AND workflow_name = ? AND status = 'succeeded'
      ORDER BY started_at DESC
      LIMIT 1
    `).get(triggerId, workflowName) as Record<string, unknown> | undefined;
    return row ? this.deserialize(row) : null;
  }

  /** List all active (queued, running, or paused) workflow runs */
  listActive(): WorkflowRun[] {
    const rows = this.db.prepare(`
      SELECT * FROM workflow_runs WHERE status IN ('queued', 'running', 'paused') ORDER BY started_at DESC
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
    repo?: string;
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
    if (opts.repo) {
      // The Repos tab filters by the qualified `owner/repo`, but the column is
      // the bare repo (+ a separate `owner`). Match EITHER shape: new rows
      // (`owner` set, `repo` bare) via `owner = ? AND repo = ?`, OR legacy rows
      // that stored the qualified string in `repo` itself via `repo = ?`. A
      // bare filter value has no owner to split, so it just matches `repo`.
      const slash = opts.repo.indexOf("/");
      if (slash > 0) {
        where.push("((owner = ? AND repo = ?) OR repo = ?)");
        params.push(opts.repo.slice(0, slash), opts.repo.slice(slash + 1), opts.repo);
      } else {
        where.push("repo = ?");
        params.push(opts.repo);
      }
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
    // LEFT JOIN a per-run token/cost roll-up (indexed by
    // `idx_executions_workflow_run`). `agg` only exposes `workflow_run_id` +
    // the two sums, so the outer unqualified column names (and `whereClause`)
    // still bind unambiguously to `workflow_runs`.
    const rows = this.db
      .prepare(
        `SELECT
           id, workflow_name, trigger_id, owner, repo, issue_number,
           current_phase, phase_history, status,
           restart_count, started_at, updated_at, finished_at,
           triggered_by, trigger_actor_type,
           COALESCE(agg.total_cost_usd, 0) AS total_cost_usd,
           COALESCE(agg.total_tokens, 0)   AS total_tokens
         FROM workflow_runs
         LEFT JOIN (
           SELECT workflow_run_id,
                  SUM(COALESCE(cost_usd, 0)) AS total_cost_usd,
                  SUM(COALESCE(input_tokens, 0)
                      + COALESCE(output_tokens, 0)
                      + COALESCE(cache_read_input_tokens, 0)) AS total_tokens
             FROM executions
            WHERE workflow_run_id IS NOT NULL
            GROUP BY workflow_run_id
         ) agg ON agg.workflow_run_id = workflow_runs.id
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

  /**
   * Count workflow runs with status 'running'. Excludes 'queued' and 'paused'
   * since those are not holding a sandbox slot. Used by the concurrency cap
   * (issue #172) to decide whether to queue a fresh run.
   */
  countRunning(): number {
    const row = this.db
      .prepare(`SELECT COUNT(*) AS c FROM workflow_runs WHERE status = 'running'`)
      .get() as { c: number };
    return row.c;
  }

  /**
   * List all queued runs ordered by started_at ascending (FIFO enqueue order).
   * Used by the admission controller to pick the next run to promote and to
   * perform TTL expiry.
   */
  listQueued(): WorkflowRun[] {
    const rows = this.db
      .prepare(`SELECT * FROM workflow_runs WHERE status = 'queued' ORDER BY started_at ASC`)
      .all() as Record<string, unknown>[];
    return rows.map((r) => this.deserialize(r));
  }

  /**
   * CAS: transition a queued run to running. Returns the number of rows changed
   * (1 = winner, 0 = already admitted or run not found). The guard
   * `WHERE status = 'queued'` prevents double-admission when the event-driven
   * and periodic paths race.
   *
   * Does NOT touch started_at or restart_count — those stay at their enqueue
   * values so TTL sweep can detect staleness and dashboards show enqueue time.
   */
  admitRun(id: string): number {
    const now = new Date().toISOString();
    const info = this.db
      .prepare(
        `UPDATE workflow_runs
         SET status = 'running', updated_at = ?
         WHERE id = ? AND status = 'queued'`,
      )
      .run(now, id);
    return info.changes;
  }

  /**
   * CAS: transition a queued run to cancelled, recording the reason in
   * context.error. Returns the number of rows changed (1 on success, 0 if the
   * run was no longer queued). Used by the TTL sweep in the admission
   * controller to drop stale queued runs.
   */
  expireQueued(id: string, reason: string): number {
    const now = new Date().toISOString();
    const info = this.db
      .prepare(
        `UPDATE workflow_runs
         SET status = 'cancelled',
             finished_at = ?,
             updated_at = ?,
             context = json_patch(COALESCE(context, '{}'), json_object('error', ?))
         WHERE id = ? AND status = 'queued'`,
      )
      .run(now, now, reason, id);
    return info.changes;
  }

  /** Distinct workflow_name values, sorted alphabetically. */
  distinctNames(): string[] {
    const rows = this.db
      .prepare(`SELECT DISTINCT workflow_name FROM workflow_runs ORDER BY workflow_name ASC`)
      .all() as { workflow_name: string }[];
    return rows.map((r) => r.workflow_name);
  }

  /**
   * Per-repo run activity — one row per distinct `owner/repo`, with the run
   * count and the most-recent `started_at`. Powers the dashboard's Repos tab,
   * which annotates the managed-repo list with recent activity and sorts by it.
   * Ordered newest-activity first.
   *
   * The `repo` key is the QUALIFIED `owner/repo` (owner-less legacy rows fall
   * back to the bare name) so it aligns with `getManagedRepos()` and the
   * artifact-store slugs the `/repos` endpoint unions it against — without this
   * a repo split into two rows (bare-with-runs vs qualified-managed-with-zero).
   */
  distinctRepos(): { repo: string; runCount: number; lastRunAt: string }[] {
    const rows = this.db
      .prepare(
        `SELECT owner, repo, COUNT(*) AS c, MAX(started_at) AS last
           FROM workflow_runs
          WHERE repo IS NOT NULL AND repo != ''
          GROUP BY owner, repo
          ORDER BY last DESC`,
      )
      .all() as { owner: string | null; repo: string; c: number; last: string }[];
    return rows.map((r) => ({
      repo: r.owner && !r.repo.includes("/") ? `${r.owner}/${r.repo}` : r.repo,
      runCount: r.c,
      lastRunAt: r.last,
    }));
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
   * Restart a FAILED or CANCELLED run so it can be retried from where it
   * stopped. Unlike {@link setRunning} this also clears the terminal markers the
   * stop left behind — `finished_at` and the `context.error` string
   * (`flipFinished` / `expireQueued` wrote it) — so the row reads live again
   * rather than "failed at …" / "dropped from queue …". The taskId, branch,
   * scratch and phase_history are all preserved, so the ledger-driven
   * re-dispatch (`resumeSimpleRun`) resumes from the stopped phase with the same
   * context; a queue-dropped `cancelled` run ran no phases, so it starts clean.
   *
   * `cancelled` is retryable because it covers two recoverable cases — a run
   * TTL-dropped from the queue after a server death, and a manual dashboard
   * cancel — neither of which is a permanent verdict. Guarded by
   * `WHERE status IN ('failed','cancelled')` and returns the changed-row count
   * so the caller can make retry a compare-and-set: a second concurrent retry
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
      WHERE id = ? AND status IN ('failed', 'cancelled')
    `).run(now, id);
    return info.changes;
  }

  /**
   * Refresh a QUEUED run's enqueue clock to now. Used by boot recovery: a run
   * that was `queued` when the harness died carries a stale `started_at`, so the
   * admission TTL sweep would immediately expire it to `cancelled` on the next
   * tick instead of admitting it. Re-stamping the clock gives it a fresh
   * `maxQueueWaitMs` window so the AdmissionController admits it normally as
   * slots free. CAS-guarded on `status = 'queued'`; returns rows changed.
   */
  requeue(id: string): number {
    const now = new Date().toISOString();
    const info = this.db.prepare(`
      UPDATE workflow_runs
      SET started_at = ?, updated_at = ?
      WHERE id = ? AND status = 'queued'
    `).run(now, now, id);
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
      owner: (row.owner as string | null) ?? undefined,
      repo: row.repo as string | undefined,
      issueNumber: row.issue_number as number | undefined,
      triggeredBy: (row.triggered_by as string | null) ?? undefined,
      triggerActorType: (row.trigger_actor_type as TriggerActorType | null) ?? undefined,
      currentPhase: row.current_phase as string,
      phaseHistory: JSON.parse(row.phase_history as string) as PhaseHistoryEntry[],
      status: row.status as WorkflowRun["status"],
      context: row.context ? JSON.parse(row.context as string) as Record<string, unknown> : undefined,
      scratch: row.scratch ? JSON.parse(row.scratch as string) as Record<string, unknown> : undefined,
      restartCount: typeof row.restart_count === "number" ? row.restart_count : 0,
      startedAt: row.started_at as string,
      updatedAt: row.updated_at as string,
      finishedAt: row.finished_at as string | undefined,
      // Present only on `list()` rows (the executions JOIN); undefined on getRun.
      totalCostUsd: typeof row.total_cost_usd === "number" ? row.total_cost_usd : undefined,
      totalTokens: typeof row.total_tokens === "number" ? row.total_tokens : undefined,
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
