-- FROZEN LEGACY SCHEMA — the pre-Drizzle shape, captured verbatim.
--
-- Mechanically dumped from `sqlite_master` after running the old
-- `src/state/migrate.ts` (CREATE bodies + every historical ALTER) plus
-- `SessionManager`'s inline messaging DDL, on the commit that deleted both.
-- Not hand-written, and deliberately not maintained: it is a fossil.
--
-- `tests/state/schema-equivalence.test.ts` applies this, then runs
-- `applyLegacySqliteCompat()` + the Drizzle migrator over it and asserts every
-- statement no-ops. That is the proof that the baseline is safe on the real
-- production database — the one that was migrated by the code above and has no
-- `__drizzle_migrations` table. Phase 1 could compare against the live legacy
-- code because both drivers coexisted; this file is how that proof survives
-- better-sqlite3's removal.
--
-- DO NOT regenerate or "update" this to match schema changes. A future
-- migration that legitimately changes the schema is expected to make the
-- post-migration shape differ from this one — that is what the journal is for.
-- This only ever describes where production started.

CREATE TABLE IF NOT EXISTS cron_overrides (
      name TEXT PRIMARY KEY,
      enabled INTEGER NOT NULL DEFAULT 1,
      schedule TEXT,
      updated_at TEXT NOT NULL,
      updated_by TEXT
    );

CREATE TABLE IF NOT EXISTS cron_runs (
      id TEXT PRIMARY KEY,
      cron_name TEXT NOT NULL,
      workflow TEXT,
      handler TEXT,
      source TEXT NOT NULL,
      actor TEXT,
      started_at TEXT NOT NULL,
      finished_at TEXT,
      status TEXT NOT NULL DEFAULT 'running',
      repos_eligible INTEGER,
      repos_scanned INTEGER,
      discovered INTEGER,
      dispatched INTEGER,
      failures INTEGER,
      error TEXT
    );

CREATE TABLE IF NOT EXISTS executions (
      id TEXT PRIMARY KEY,
      trigger_type TEXT NOT NULL,
      trigger_id TEXT NOT NULL,
      skill TEXT NOT NULL,
      -- The target repo as (owner, BARE repo) — see state/repo-ref.ts, the one
      -- place that rule is expressed. The owner column arrives by ALTER below
      -- on an upgraded DB; it is here too so a fresh DB reaches the same shape.
      owner TEXT,
      repo TEXT,
      issue_number INTEGER,
      started_at TEXT NOT NULL,
      finished_at TEXT,
      success INTEGER,
      error TEXT,
      turns INTEGER,
      duration_ms INTEGER
    , triggered_by TEXT, trigger_actor_type TEXT, session_id TEXT, cost_usd REAL, input_tokens INTEGER, cache_creation_input_tokens INTEGER, cache_read_input_tokens INTEGER, output_tokens INTEGER, api_duration_ms INTEGER, stop_reason TEXT, workflow_run_id TEXT, output_text TEXT, extension_status TEXT, skills_status TEXT);

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
      -- `channel: string | null`.
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
      -- workflow run. Deliberately not called `execution_id`: it is
      -- `messaging_sessions.id`, which is what an `executions` row for a chat
      -- turn carries as its `trigger_id`, NOT an `executions.id`.
      messaging_session_id TEXT,
      created_at TEXT NOT NULL,               -- when the bot posted it
      last_polled_at TEXT,                    -- github only; slack arrives live
      UNIQUE(source, channel, external_id)
    );

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

CREATE TABLE IF NOT EXISTS github_team_members (
      org TEXT NOT NULL,
      team_slug TEXT NOT NULL,
      login TEXT NOT NULL,
      PRIMARY KEY (org, team_slug, login)
    );

CREATE TABLE IF NOT EXISTS github_team_repos (
      org TEXT NOT NULL,
      team_slug TEXT NOT NULL,
      repo TEXT NOT NULL,
      PRIMARY KEY (org, team_slug, repo)
    );

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

CREATE TABLE IF NOT EXISTS github_visibility_sync (
      login TEXT PRIMARY KEY,
      synced_at TEXT NOT NULL,
      status TEXT NOT NULL,
      -- Free-text detail for the error/truncated cases (admin surface only).
      detail TEXT
    );

CREATE TABLE IF NOT EXISTS messaging_messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL REFERENCES messaging_sessions(id),
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        timestamp TEXT NOT NULL,
        platform_message_id TEXT
      );

CREATE TABLE IF NOT EXISTS messaging_sessions (
        id TEXT PRIMARY KEY,
        platform TEXT NOT NULL,
        channel_id TEXT NOT NULL,
        thread_id TEXT,
        user_id TEXT NOT NULL,
        agent_session_id TEXT,
        created_at TEXT NOT NULL,
        last_activity_at TEXT NOT NULL,
        message_count INTEGER DEFAULT 0,
        active INTEGER DEFAULT 1
      );

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
    , kind TEXT NOT NULL DEFAULT 'approve', artifact TEXT);

CREATE TABLE IF NOT EXISTS workflow_overrides (
      name TEXT PRIMARY KEY,
      enabled INTEGER NOT NULL DEFAULT 1,
      updated_at TEXT NOT NULL,
      updated_by TEXT
    );

CREATE TABLE IF NOT EXISTS workflow_runs (
      id TEXT PRIMARY KEY,
      workflow_name TEXT NOT NULL,
      trigger_id TEXT NOT NULL,
      -- Same (owner, BARE repo) pair as the executions ledger above.
      owner TEXT,
      repo TEXT,
      issue_number INTEGER,
      current_phase TEXT NOT NULL,
      phase_history TEXT NOT NULL DEFAULT '[]',
      status TEXT NOT NULL DEFAULT 'running',
      context TEXT,
      started_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      finished_at TEXT
    , triggered_by TEXT, trigger_actor_type TEXT, scratch TEXT, restart_count INTEGER NOT NULL DEFAULT 0, trace_id TEXT, span_id TEXT);

CREATE INDEX IF NOT EXISTS idx_approvals_status ON workflow_approvals(status);

CREATE INDEX IF NOT EXISTS idx_approvals_workflow ON workflow_approvals(workflow_run_id);

CREATE INDEX IF NOT EXISTS idx_cron_runs_name_started ON cron_runs(cron_name, started_at DESC);

CREATE INDEX IF NOT EXISTS idx_executions_skill ON executions(skill, started_at);

CREATE INDEX IF NOT EXISTS idx_executions_trigger ON executions(trigger_type, trigger_id);

CREATE INDEX IF NOT EXISTS idx_executions_workflow_run ON executions(workflow_run_id, skill);

CREATE INDEX IF NOT EXISTS idx_feedback_anchors_lookup
      ON feedback_anchors(source, channel, external_id);

CREATE INDEX IF NOT EXISTS idx_feedback_anchors_poll
      ON feedback_anchors(source, created_at, last_polled_at);

CREATE INDEX IF NOT EXISTS idx_feedback_anchors_run
      ON feedback_anchors(workflow_run_id);

CREATE INDEX IF NOT EXISTS idx_feedback_signals_anchor ON feedback_signals(anchor_id);

CREATE INDEX IF NOT EXISTS idx_feedback_signals_export ON feedback_signals(exported_at);

CREATE INDEX IF NOT EXISTS idx_feedback_signals_observed
      ON feedback_signals(observed_at DESC);

CREATE INDEX IF NOT EXISTS idx_feedback_signals_run ON feedback_signals(workflow_run_id);

CREATE INDEX IF NOT EXISTS idx_feedback_signals_workflow
      ON feedback_signals(workflow_name, observed_at DESC);

CREATE INDEX IF NOT EXISTS idx_github_team_members_login
      ON github_team_members(login);

CREATE INDEX IF NOT EXISTS idx_msg_messages_session
        ON messaging_messages(session_id, timestamp);

CREATE INDEX IF NOT EXISTS idx_msg_sessions_lookup
        ON messaging_sessions(platform, channel_id, thread_id, user_id);

CREATE UNIQUE INDEX IF NOT EXISTS idx_msg_sessions_unique_active
        ON messaging_sessions(platform, channel_id, thread_id, user_id)
        WHERE active = 1;

CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);

CREATE INDEX IF NOT EXISTS idx_users_login ON users(login);

CREATE INDEX IF NOT EXISTS idx_users_slack ON users(slack_user_id);

CREATE INDEX IF NOT EXISTS idx_workflow_runs_name_started ON workflow_runs(workflow_name, started_at DESC);

CREATE INDEX IF NOT EXISTS idx_workflow_runs_started_at ON workflow_runs(started_at DESC);

CREATE INDEX IF NOT EXISTS idx_workflow_runs_status ON workflow_runs(status);

CREATE INDEX IF NOT EXISTS idx_workflow_runs_trigger ON workflow_runs(trigger_id, status);
