import type Database from "better-sqlite3";

/**
 * Apply the full SQLite schema for the harness state DB.
 *
 * Centralized here (rather than on a store) because the three stores
 * (`WorkflowRunStore` / `ApprovalStore` / `ExecutionStore`) all share a
 * single `Database` connection and assume the schema already exists. `StateDb`
 * is the construction root and calls this once at boot; tests that exercise a
 * store directly construct a raw `Database`, call `migrate()`, then build the
 * store on top.
 *
 * Every statement is idempotent (`IF NOT EXISTS` / additive `ALTER` guarded by
 * try/catch) so it is safe to run on an existing DB.
 */
export function migrate(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS executions (
      id TEXT PRIMARY KEY,
      trigger_type TEXT NOT NULL,
      trigger_id TEXT NOT NULL,
      skill TEXT NOT NULL,
      repo TEXT,
      issue_number INTEGER,
      started_at TEXT NOT NULL,
      finished_at TEXT,
      success INTEGER,
      error TEXT,
      turns INTEGER,
      duration_ms INTEGER
    );

    CREATE INDEX IF NOT EXISTS idx_executions_trigger ON executions(trigger_type, trigger_id);
    CREATE INDEX IF NOT EXISTS idx_executions_skill ON executions(skill, started_at);

    CREATE TABLE IF NOT EXISTS workflow_runs (
      id TEXT PRIMARY KEY,
      workflow_name TEXT NOT NULL,
      trigger_id TEXT NOT NULL,
      repo TEXT,
      issue_number INTEGER,
      current_phase TEXT NOT NULL,
      phase_history TEXT NOT NULL DEFAULT '[]',
      status TEXT NOT NULL DEFAULT 'running',
      context TEXT,
      started_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      finished_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_workflow_runs_trigger ON workflow_runs(trigger_id, status);
    CREATE INDEX IF NOT EXISTS idx_workflow_runs_status ON workflow_runs(status);
    -- Dashboard's workflow-runs list query is ORDER BY started_at DESC
    -- LIMIT 20, often with optional workflow_name / status filters and a
    -- companion COUNT(*). It polls every 5s, so it's worth a covering
    -- index — without one this is a full-table sort.
    CREATE INDEX IF NOT EXISTS idx_workflow_runs_started_at ON workflow_runs(started_at DESC);
    CREATE INDEX IF NOT EXISTS idx_workflow_runs_name_started ON workflow_runs(workflow_name, started_at DESC);

    CREATE TABLE IF NOT EXISTS cron_overrides (
      name TEXT PRIMARY KEY,
      enabled INTEGER NOT NULL DEFAULT 1,
      schedule TEXT,
      updated_at TEXT NOT NULL,
      updated_by TEXT
    );

    CREATE TABLE IF NOT EXISTS workflow_overrides (
      name TEXT PRIMARY KEY,
      enabled INTEGER NOT NULL DEFAULT 1,
      updated_at TEXT NOT NULL,
      updated_by TEXT
    );

    CREATE TABLE IF NOT EXISTS workflow_approvals (
      id TEXT PRIMARY KEY,
      workflow_run_id TEXT NOT NULL,
      gate TEXT NOT NULL,
      summary TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      requested_by TEXT,
      responded_by TEXT,
      response TEXT,
      responded_at TEXT,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_approvals_workflow ON workflow_approvals(workflow_run_id);
    CREATE INDEX IF NOT EXISTS idx_approvals_status ON workflow_approvals(status);
  `);

  // Mutable phase-to-phase state for features like the socratic explore
  // loop that accumulate data across reply-gate pauses.
  try {
    db.exec(`ALTER TABLE workflow_runs ADD COLUMN scratch TEXT`);
  } catch {
    // Column already exists — ignore
  }

  // Restart attempt counter — bumped each time resumeOrphanedWorkflows
  // re-dispatches a still-'running' row at boot. Acts as a circuit
  // breaker so an OOM-on-restart loop can't churn forever.
  try {
    db.exec(`ALTER TABLE workflow_runs ADD COLUMN restart_count INTEGER NOT NULL DEFAULT 0`);
  } catch {
    // Column already exists — ignore
  }

  // Gate flavor: 'approve' (explicit approve/reject) vs 'reply' (resolves
  // on any free-form reply in the same thread — used by the socratic
  // explore loop).
  try {
    db.exec(`ALTER TABLE workflow_approvals ADD COLUMN kind TEXT NOT NULL DEFAULT 'approve'`);
  } catch {
    // Column already exists — ignore
  }

  // Add session_id column to executions so the dashboard can resolve a
  // phase click to its agent session log. Additive — safe on existing DBs.
  try {
    db.exec(`ALTER TABLE executions ADD COLUMN session_id TEXT`);
  } catch {
    // Column already exists — ignore
  }

  // Per-execution runtime usage metrics, captured from the OpenCode
  // step_finish events. Lets the dashboard show cost / tokens per phase
  // and lets us aggregate spend later. All additive, safe on existing DBs.
  for (const col of [
    "cost_usd REAL",
    "input_tokens INTEGER",
    "cache_creation_input_tokens INTEGER",
    "cache_read_input_tokens INTEGER",
    "output_tokens INTEGER",
    "api_duration_ms INTEGER",
    "stop_reason TEXT",
    // Links a phase execution to its owning workflow_run. Dedup and
    // "already running / done" checks scope to this column so a fresh
    // re-trigger of the same workflow on the same issue creates new
    // executions instead of reusing the old run's rows.
    "workflow_run_id TEXT",
    // Final assistant text for a phase execution. Populated only for
    // loop iterations whose output is referenced by `scratch.<key>
    // .lastOutputExecutionId` — keeps the inlined LLM output out of
    // `workflow_runs.scratch` (which is read on every list query)
    // while still being available to the runner's resume path.
    "output_text TEXT",
    // JSON map of agentic-pi extensions active for this execution
    // (file-search / github / web-search → {status, mode?, provider?,
    // toolCount?, reason?}). Surfaced in the dashboard phase-detail panel.
    "extension_status TEXT",
  ]) {
    try {
      db.exec(`ALTER TABLE executions ADD COLUMN ${col}`);
    } catch {
      // Column already exists — ignore
    }
  }
  try {
    db.exec(
      `CREATE INDEX IF NOT EXISTS idx_executions_workflow_run ON executions(workflow_run_id, skill)`,
    );
  } catch {
    // Index already exists — ignore
  }
}
