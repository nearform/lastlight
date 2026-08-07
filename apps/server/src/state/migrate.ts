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

    -- First-class user identity (issue #205). An ADDITIVE enrichment table:
    -- every actor column elsewhere stays free-text \`login\`, and \`users\` is
    -- LEFT-JOINed on it to resolve a real person (name / email / avatar) for
    -- the dashboard and future email. \`github_id\` / \`slack_user_id\` are the
    -- stable upsert keys; \`login\` is the soft join key. \`email\` is indexed but
    -- deliberately NOT unique (corporate shared mailboxes + many null Slack-only
    -- rows would collide a UNIQUE constraint) — see issue #205 decisions.
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,                    -- randomUUID
      github_id INTEGER UNIQUE,               -- stable numeric id (upsert key); null for Slack-only rows
      login TEXT UNIQUE,                      -- GitHub login = the soft join key used everywhere
      name TEXT,
      email TEXT,                             -- captured for future email; indexed, NOT unique
      avatar_url TEXT,
      slack_user_id TEXT UNIQUE,              -- U… id, linked lazily on Slack match
      is_blocked INTEGER NOT NULL DEFAULT 0,
      email_is_placeholder INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      last_login_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_users_login ON users(login);
    CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);
    CREATE INDEX IF NOT EXISTS idx_users_slack ON users(slack_user_id);

    -- Feedback signals (issue #255) — a 👍/👎 on something the bot wrote, scored
    -- against the run that wrote it. Two tables, because a reaction names a
    -- MESSAGE and we need a run:
    --
    --   feedback_anchors  one row per reactable artefact the bot posted, and the
    --                     run it came from. Written when we POST (Slack, where
    --                     the ts is only ever known at send time) or when a run
    --                     finishes (GitHub discovery).
    --   feedback_signals  one row per (anchor, reactor, emoji).
    --
    -- Surface-agnostic from the start: \`source\` discriminates slack/github so a
    -- single query averages across both, and the GitHub poller adds rows rather
    -- than columns.
    CREATE TABLE IF NOT EXISTS feedback_anchors (
      id TEXT PRIMARY KEY,                    -- randomUUID
      source TEXT NOT NULL,                   -- slack | github
      kind TEXT NOT NULL,                     -- slack_message | issue_comment | review_comment | issue
      -- Slack message ts, or the GitHub comment/issue id as a string. Kept TEXT
      -- for both: a Slack ts ("1712000000.000100") is not a number, and a
      -- GitHub id read back as a float would lose precision.
      external_id TEXT NOT NULL,
      -- GitHub GraphQL global id. The batched reactions query keys on this, so
      -- the poller never has to re-resolve an id it already saw.
      node_id TEXT,
      -- Slack channel id. GitHub has no channel and stores the empty string
      -- rather than NULL, because **SQLite treats NULLs as DISTINCT in a UNIQUE
      -- constraint** — with NULL here, the UNIQUE below (and the ON CONFLICT
      -- that targets it) is silently inoperative for every GitHub anchor, and
      -- re-discovering the same comment forks a second row. A sentinel keeps
      -- ONE uniqueness rule and ONE upsert path for both surfaces; the store
      -- maps '' back to null at its boundary so callers still see
      -- \`channel: string | null\`.
      channel TEXT NOT NULL DEFAULT '',
      owner TEXT,
      repo TEXT,
      issue_number INTEGER,
      -- The attribution. Null is legal and deliberate: a bot comment we cannot
      -- tie to a run is still worth recording — dropping it would silently lose
      -- the reaction rather than the run.
      workflow_run_id TEXT,
      workflow_name TEXT,
      -- The Slack THREAD's messaging session, for a chat turn — which has no
      -- workflow run. Deliberately not called \`execution_id\`: it is
      -- \`messaging_sessions.id\`, which is what an \`executions\` row for a chat
      -- turn carries as its \`trigger_id\`, NOT an \`executions.id\`.
      messaging_session_id TEXT,
      created_at TEXT NOT NULL,               -- when the bot posted it
      last_polled_at TEXT,                    -- github only; slack arrives live
      UNIQUE(source, channel, external_id)
    );
    -- The reverse lookup a Slack reaction hits: (channel, ts) → anchor.
    CREATE INDEX IF NOT EXISTS idx_feedback_anchors_lookup
      ON feedback_anchors(source, channel, external_id);
    CREATE INDEX IF NOT EXISTS idx_feedback_anchors_run
      ON feedback_anchors(workflow_run_id);
    -- The poller's rotation: least-recently-polled first, within the window.
    CREATE INDEX IF NOT EXISTS idx_feedback_anchors_poll
      ON feedback_anchors(source, created_at, last_polled_at);

    CREATE TABLE IF NOT EXISTS feedback_signals (
      id TEXT PRIMARY KEY,
      anchor_id TEXT NOT NULL,
      -- Denormalized from the anchor so every analytics query is one table.
      -- These never change for a given anchor, so there is nothing to keep in
      -- sync — the anchor's attribution is fixed the moment it is created.
      source TEXT NOT NULL,
      workflow_run_id TEXT,
      workflow_name TEXT,
      messaging_session_id TEXT,
      owner TEXT,
      repo TEXT,
      issue_number INTEGER,
      emoji TEXT NOT NULL,                    -- canonical name (see engine/feedback/reactions.ts)
      score INTEGER NOT NULL,                 -- -2..+2; 0 means "recorded, not scored"
      sentiment TEXT NOT NULL,
      reactor TEXT,                           -- GitHub login / Slack user id
      reacted_at TEXT,                        -- when they reacted, when known
      observed_at TEXT NOT NULL,              -- when WE saw it
      -- Set when the reaction is taken away. Retracting rather than deleting
      -- keeps "somebody thumbed this and then thought better of it" visible,
      -- which is itself a signal; every score query filters on IS NULL.
      removed_at TEXT,
      -- OTel export watermark. Null means not yet exported, so a restart can't
      -- double-emit and signals recorded while telemetry was off can be
      -- backfilled later.
      exported_at TEXT,
      UNIQUE(anchor_id, reactor, emoji)
    );
    CREATE INDEX IF NOT EXISTS idx_feedback_signals_anchor ON feedback_signals(anchor_id);
    CREATE INDEX IF NOT EXISTS idx_feedback_signals_run ON feedback_signals(workflow_run_id);
    CREATE INDEX IF NOT EXISTS idx_feedback_signals_observed
      ON feedback_signals(observed_at DESC);
    CREATE INDEX IF NOT EXISTS idx_feedback_signals_workflow
      ON feedback_signals(workflow_name, observed_at DESC);
    CREATE INDEX IF NOT EXISTS idx_feedback_signals_export ON feedback_signals(exported_at);

    -- ── GitHub team-based dashboard visibility (issue #169) ────────────────
    -- These four tables are a CACHE, not a mirror of the org. Nothing here is
    -- enumerated up front: rows appear only for the teams a user who actually
    -- logged in belongs to, resolved on demand (see engine/github/team-visibility.ts).
    -- That is the whole scaling story — an org with thousands of repos and
    -- hundreds of teams costs a handful of requests per logged-in person
    -- instead of a full-org crawl. Safe to delete wholesale; it refills.

    -- One row per team we have ever resolved repos for.
    CREATE TABLE IF NOT EXISTS github_teams (
      org TEXT NOT NULL,
      slug TEXT NOT NULL,
      name TEXT,
      -- When this team's repo grant was last enumerated.
      repos_synced_at TEXT NOT NULL,
      -- 1 when the enumeration hit the per-team page budget and stopped early,
      -- so github_team_repos is a PREFIX of the real grant. A truncated team
      -- forces its members to fail open — a partial list would hide repos the
      -- person really can see, which is worse than not filtering at all.
      truncated INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (org, slug)
    );

    -- A team's grant, already intersected with the managed-repo set. The repo
    -- column holds the owner/repo full name.
    CREATE TABLE IF NOT EXISTS github_team_repos (
      org TEXT NOT NULL,
      team_slug TEXT NOT NULL,
      repo TEXT NOT NULL,
      PRIMARY KEY (org, team_slug, repo)
    );

    -- Membership we have LEARNED, not enumerated: one row per (team, login)
    -- discovered while resolving that login. Absence means "unknown", never
    -- "not a member" — which is why every read path fails open.
    CREATE TABLE IF NOT EXISTS github_team_members (
      org TEXT NOT NULL,
      team_slug TEXT NOT NULL,
      login TEXT NOT NULL,
      PRIMARY KEY (org, team_slug, login)
    );
    -- reposForLogin joins membership → team_repos on this column.
    CREATE INDEX IF NOT EXISTS idx_github_team_members_login
      ON github_team_members(login);

    -- Per-login freshness + outcome, so a resolution that failed or blew its
    -- request budget is remembered for the TTL rather than retried on every
    -- dashboard poll. status is one of: ok | empty | truncated | error | disabled.
    CREATE TABLE IF NOT EXISTS github_visibility_sync (
      login TEXT PRIMARY KEY,
      synced_at TEXT NOT NULL,
      status TEXT NOT NULL,
      -- Free-text detail for the error/truncated cases (admin surface only).
      detail TEXT
    );
  `);

  // Actor logging (issue #205): who triggered a run and how. Additive on both
  // the append-only `executions` ledger and the `workflow_runs` aggregate. The
  // run's `triggered_by` is the ORIGINAL trigger; retry/cancel/approve actors
  // land on the executions ledger, never overwriting the run's origin value.
  // `trigger_actor_type` is one of github | slack | cli | cron | admin | system.
  for (const table of ["executions", "workflow_runs"]) {
    try {
      db.exec(`ALTER TABLE ${table} ADD COLUMN triggered_by TEXT`);
    } catch {
      // Column already exists — ignore
    }
    try {
      db.exec(`ALTER TABLE ${table} ADD COLUMN trigger_actor_type TEXT`);
    } catch {
      // Column already exists — ignore
    }
  }

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

  // Explicit `owner` column. A run targets a GitHub repo identified by
  // (owner, repo); `repo` stays a single path-safe segment (taskIds and
  // workspace/session dirs derive from it), so the owner previously lived
  // ONLY inside the `context` JSON blob. That left the runs list — which
  // omits `context` for payload size — unable to reconstruct `owner/repo`,
  // so the Repos tab showed a bare row + a managed `owner/repo` row for the
  // same repo and the dashboard's GitHub links never resolved. Storing owner
  // as its own column fixes both. Backfill existing rows from context.owner
  // in the same guarded step (runs once, when the column is first added).
  try {
    db.exec(`ALTER TABLE workflow_runs ADD COLUMN owner TEXT`);
    db.exec(
      `UPDATE workflow_runs
          SET owner = json_extract(context, '$.owner')
        WHERE owner IS NULL AND context IS NOT NULL`,
    );
  } catch {
    // Column already exists — ignore
  }

  // `feedback_anchors.channel` moved from nullable to a '' sentinel (issue
  // #255) so its UNIQUE actually binds for GitHub — see the CREATE TABLE above.
  // `CREATE TABLE IF NOT EXISTS` can't restate a column, so backfill any rows
  // written by a build that predates the fix. Guarded like every ALTER here: on
  // a table that already accumulated NULL-channel duplicates the UPDATE trips
  // the constraint, and leaving those rows alone is strictly better than
  // failing boot over a cache of reaction anchors.
  try {
    db.exec(`UPDATE feedback_anchors SET channel = '' WHERE channel IS NULL`);
  } catch {
    // Pre-existing duplicates — they age out via `retentionDays`.
  }

  // The run's OTel trace/span context (issue #255). A feedback signal can
  // arrive days after the run finished and its span closed, so the only way to
  // put the score on the trace it grades is to remember where that trace was.
  // Captured by the observability adapter in `src/workflows/runner.ts` when the
  // `lastlight.workflow.run` span opens; null whenever telemetry was disabled,
  // in which case the signal exports as its own root span instead.
  for (const col of ["trace_id TEXT", "span_id TEXT"]) {
    try {
      db.exec(`ALTER TABLE workflow_runs ADD COLUMN ${col}`);
    } catch {
      // Column already exists — ignore
    }
  }

  // Gate flavor: 'approve' (explicit approve/reject) vs 'reply' (resolves
  // on any free-form reply in the same thread — used by the socratic
  // explore loop).
  try {
    db.exec(`ALTER TABLE workflow_approvals ADD COLUMN kind TEXT NOT NULL DEFAULT 'approve'`);
  } catch {
    // Column already exists — ignore
  }

  // Artifact (handoff doc) filename a gate is asking the reviewer to approve,
  // e.g. 'architect-plan.md'. Lets the focused approval view open the right
  // doc. Nullable — most gates carry no artifact. Additive, safe on existing DBs.
  try {
    db.exec(`ALTER TABLE workflow_approvals ADD COLUMN artifact TEXT`);
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
    // JSON object of agentic-pi's skill-loading status for this execution
    // ({status, discovered, skills[], mappedPaths, noSkills}). The skill-
    // loading counterpart to extension_status; surfaced in the same panel.
    "skills_status TEXT",
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
