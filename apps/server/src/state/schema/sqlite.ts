/**
 * Drizzle SQLite schema — the single declaration of the harness state DB.
 *
 * Transcribed from the legacy DDL it replaces: `src/state/migrate.ts` (the
 * thirteen state tables, their `CREATE TABLE IF NOT EXISTS` bodies AND every
 * historical `ALTER TABLE ADD COLUMN`) plus
 * `src/connectors/messaging/session-manager.ts` (the two messaging tables,
 * which self-migrated on a second schema owner). 15 tables, 25 named indexes.
 *
 * Three transcription rules, all load-bearing:
 *
 * 1. **Column order matches the FRESH legacy physical order** — CREATE-body
 *    columns first, then the ALTER-added ones in the order `migrate.ts` adds
 *    them. `tests/state/schema-equivalence.test.ts` compares `PRAGMA
 *    table_info` in cid order on the fresh-vs-fresh legs.
 *
 *    Caveat, and the reason that test compares a legacy-shaped DB by NAME
 *    instead: `owner` is in both the CREATE body AND an `ALTER` for
 *    `executions` + `workflow_runs`. On a fresh DB the CREATE wins and the
 *    ALTER throws into a `catch {}`, so `owner` sits mid-table; on a DB
 *    upgraded from before the CREATE-body change the ALTER genuinely appended
 *    it, so it sits at the tail. No schema file can satisfy both, and it does
 *    not matter — SQLite and Drizzle both address columns by name.
 *
 * 2. **Index names are exact** — the equivalence test compares
 *    `sqlite_master` index rows by name, sql verbatim. sqlite-core has no
 *    `.desc()` on index columns (that API is pg-core only), so the five DESC
 *    keys use the `sql` expression form.
 *
 * 3. **`{ mode: "json" }` / `{ mode: "boolean" }` change the TypeScript type,
 *    not the emitted DDL** (still TEXT / INTEGER), so no data migration and no
 *    equivalence impact. Existing rows already hold valid JSON text and 0/1.
 */
import { sql } from "drizzle-orm";
import {
  index,
  integer,
  primaryKey,
  real,
  sqliteTable,
  text,
  unique,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";
import type { ExtensionStatusMap, SkillsStatus } from "lastlight-workflow-engine";
import type {
  ActivityAction,
  ActivityDetail,
  ActivityOutcome,
} from "../activity-store.js";
import type { TriggerActorType } from "../user-store.js";
import type { PhaseHistoryEntry } from "../workflow-run-store.js";

/**
 * The append-only execution ledger — one row per agent invocation (a workflow
 * phase, or a chat turn). Legacy: `migrate.ts` CREATE + the issue-#205 actor
 * ALTERs + `session_id` + the usage-metric loop.
 */
export const executions = sqliteTable(
  "executions",
  {
    id: text("id").primaryKey(),
    triggerType: text("trigger_type").notNull(),
    triggerId: text("trigger_id").notNull(),
    skill: text("skill").notNull(),
    // (owner, BARE repo) — see state/repo-ref.ts, the one place that rule is
    // expressed. Present in the CREATE body AND ALTER-added; see rule 1 above.
    owner: text("owner"),
    repo: text("repo"),
    issueNumber: integer("issue_number"),
    startedAt: text("started_at").notNull(),
    finishedAt: text("finished_at"),
    // TRI-STATE: null means still in flight. `ExecutionRecord.success?:
    // boolean` is optional for exactly this reason.
    success: integer("success", { mode: "boolean" }),
    error: text("error"),
    turns: integer("turns"),
    durationMs: integer("duration_ms"),
    // ── historical ALTERs, in migrate.ts order ──
    // issue #205 actor columns — added BEFORE session_id, so they sit right
    // after duration_ms. Plain text: NOT json, NOT boolean.
    triggeredBy: text("triggered_by"),
    triggerActorType: text("trigger_actor_type"),
    sessionId: text("session_id"),
    costUsd: real("cost_usd"),
    inputTokens: integer("input_tokens"),
    cacheCreationInputTokens: integer("cache_creation_input_tokens"),
    cacheReadInputTokens: integer("cache_read_input_tokens"),
    outputTokens: integer("output_tokens"),
    apiDurationMs: integer("api_duration_ms"),
    stopReason: text("stop_reason"),
    workflowRunId: text("workflow_run_id"),
    outputText: text("output_text"),
    extensionStatus: text("extension_status", { mode: "json" }).$type<ExtensionStatusMap>(),
    skillsStatus: text("skills_status", { mode: "json" }).$type<SkillsStatus>(),
  },
  (t) => [
    index("idx_executions_trigger").on(t.triggerType, t.triggerId),
    index("idx_executions_skill").on(t.skill, t.startedAt),
    index("idx_executions_workflow_run").on(t.workflowRunId, t.skill),
  ],
);

/**
 * The per-run aggregate a workflow advances phase by phase. Legacy:
 * `migrate.ts` CREATE + the actor ALTERs + `scratch` + `restart_count` +
 * `owner` (which carries a one-time data backfill) + `trace_id`/`span_id`.
 */
export const workflowRuns = sqliteTable(
  "workflow_runs",
  {
    id: text("id").primaryKey(),
    workflowName: text("workflow_name").notNull(),
    triggerId: text("trigger_id").notNull(),
    // Same (owner, BARE repo) pair as the executions ledger; same CREATE-plus-
    // ALTER duplication (rule 1).
    owner: text("owner"),
    repo: text("repo"),
    issueNumber: integer("issue_number"),
    currentPhase: text("current_phase").notNull(),
    // list() omits `context`/`scratch` for payload size but DOES select
    // phase_history and parses it unconditionally — so this one stays
    // notNull with the '[]' default, or list() starts throwing.
    phaseHistory: text("phase_history", { mode: "json" })
      .$type<PhaseHistoryEntry[]>()
      .notNull()
      .default(sql`'[]'`),
    status: text("status").notNull().default("running"),
    context: text("context", { mode: "json" }).$type<Record<string, unknown>>(),
    startedAt: text("started_at").notNull(),
    updatedAt: text("updated_at").notNull(),
    finishedAt: text("finished_at"),
    // ── historical ALTERs, in migrate.ts order ──
    triggeredBy: text("triggered_by"),
    triggerActorType: text("trigger_actor_type"),
    scratch: text("scratch", { mode: "json" }).$type<Record<string, unknown>>(),
    restartCount: integer("restart_count").notNull().default(0),
    // The run's OTel trace/span context (issue #255) — a feedback signal can
    // arrive days after the span closed, so we remember where the trace was.
    traceId: text("trace_id"),
    spanId: text("span_id"),
  },
  (t) => [
    index("idx_workflow_runs_trigger").on(t.triggerId, t.status),
    index("idx_workflow_runs_status").on(t.status),
    // The dashboard's runs list is ORDER BY started_at DESC LIMIT 20 on a 5s
    // poll — the DESC is a covering index, not decoration.
    index("idx_workflow_runs_started_at").on(sql`${t.startedAt} DESC`),
    // Mixed ASC+DESC composite: the one shape SQLite cannot satisfy by a
    // reverse scan, so the DESC here is load-bearing.
    index("idx_workflow_runs_name_started").on(t.workflowName, sql`${t.startedAt} DESC`),
  ],
);

/** Operator on/off + schedule overrides for cron jobs. Legacy: `migrate.ts`. */
export const cronOverrides = sqliteTable("cron_overrides", {
  name: text("name").primaryKey(),
  enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
  schedule: text("schedule"),
  updatedAt: text("updated_at").notNull(),
  updatedBy: text("updated_by"),
});

/**
 * One row per cron FIRE — scheduled or manual, `workflow:` or `handler:`.
 * A zero-discovery fire dispatches nothing, so this is the only record it ran
 * at all. Keyed on cron_name, never the workflow.
 */
export const cronRuns = sqliteTable(
  "cron_runs",
  {
    id: text("id").primaryKey(),
    cronName: text("cron_name").notNull(),
    // A cron declares exactly one of these two — hence both nullable.
    workflow: text("workflow"),
    handler: text("handler"),
    source: text("source").notNull(),
    actor: text("actor"),
    startedAt: text("started_at").notNull(),
    finishedAt: text("finished_at"),
    status: text("status").notNull().default("running"),
    reposEligible: integer("repos_eligible"),
    reposScanned: integer("repos_scanned"),
    discovered: integer("discovered"),
    dispatched: integer("dispatched"),
    failures: integer("failures"),
    error: text("error"),
  },
  (t) => [index("idx_cron_runs_name_started").on(t.cronName, sql`${t.startedAt} DESC`)],
);

/** Operator on/off overrides for workflows. Legacy: `migrate.ts`. */
export const workflowOverrides = sqliteTable("workflow_overrides", {
  name: text("name").primaryKey(),
  enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
  updatedAt: text("updated_at").notNull(),
  updatedBy: text("updated_by"),
});

/** Approval / reply gates a paused run is waiting on. */
export const workflowApprovals = sqliteTable(
  "workflow_approvals",
  {
    id: text("id").primaryKey(),
    workflowRunId: text("workflow_run_id").notNull(),
    gate: text("gate").notNull(),
    summary: text("summary").notNull(),
    status: text("status").notNull().default("pending"),
    requestedBy: text("requested_by"),
    respondedBy: text("responded_by"),
    response: text("response"),
    respondedAt: text("responded_at"),
    createdAt: text("created_at").notNull(),
    // ── historical ALTERs ──
    // Gate flavor: 'approve' (explicit approve/reject) vs 'reply' (resolves on
    // any free-form reply in the same thread).
    kind: text("kind").notNull().default("approve"),
    // A handoff-doc FILENAME ('architect-plan.md') — never JSON, and queried
    // with `WHERE artifact = ?`. Plain text on purpose.
    artifact: text("artifact"),
  },
  (t) => [
    index("idx_approvals_workflow").on(t.workflowRunId),
    index("idx_approvals_status").on(t.status),
  ],
);

/**
 * First-class user identity (issue #205) — an ADDITIVE enrichment table
 * LEFT-JOINed on `login`. `github_id` / `slack_user_id` are the stable upsert
 * keys; `email` is indexed but deliberately NOT unique (shared mailboxes).
 */
export const users = sqliteTable(
  "users",
  {
    id: text("id").primaryKey(),
    githubId: integer("github_id").unique(),
    login: text("login").unique(),
    name: text("name"),
    email: text("email"),
    avatarUrl: text("avatar_url"),
    slackUserId: text("slack_user_id").unique(),
    isBlocked: integer("is_blocked", { mode: "boolean" }).notNull().default(false),
    emailIsPlaceholder: integer("email_is_placeholder", { mode: "boolean" })
      .notNull()
      .default(false),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
    lastLoginAt: text("last_login_at"),
  },
  (t) => [
    // idx_users_login and idx_users_slack duplicate the column-level UNIQUE
    // autoindexes. Declared anyway: omit them and `drizzle-kit generate` emits
    // a DROP INDEX against production.
    index("idx_users_login").on(t.login),
    index("idx_users_email").on(t.email),
    index("idx_users_slack").on(t.slackUserId),
  ],
);

/**
 * The cross-cutting audit stream (issue #206) — one row per user-initiated
 * action, across the dashboard, CLI, Slack, GitHub and cron.
 *
 * COMPLEMENTS the per-run actor columns #205 put on `workflow_runs` and
 * `executions`; it does not replace them. Those stay the hot-path attribution
 * a run's detail view reads, and this is the chronological stream that answers
 * "what has this person done?" without joining five ledgers.
 *
 * `actor_login` is free text soft-joined to `users.login`, deliberately WITHOUT
 * a foreign key — the same additive-enrichment choice #205 made, so a row
 * survives an actor who never logged into the dashboard. It is nullable
 * because a password login carries no verified login to record.
 */
export const activityLog = sqliteTable(
  "activity_log",
  {
    id: text("id").primaryKey(),
    createdAt: text("created_at").notNull(),
    actorLogin: text("actor_login"),
    actorType: text("actor_type").$type<TriggerActorType>(),
    action: text("action").notNull().$type<ActivityAction>(),
    // Null together, for an action with no target — `login` is the only one.
    targetType: text("target_type"),
    targetId: text("target_id"),
    outcome: text("outcome").notNull().$type<ActivityOutcome>(),
    detail: text("detail", { mode: "json" }).$type<ActivityDetail>(),
  },
  (t) => [
    index("idx_activity_created").on(sql`${t.createdAt} DESC`),
    index("idx_activity_actor_created").on(t.actorLogin, sql`${t.createdAt} DESC`),
    index("idx_activity_target").on(t.targetType, t.targetId),
  ],
);

/**
 * One row per reactable artefact the bot posted, and the run it came from
 * (issue #255). Written when we POST (Slack) or when a run finishes (GitHub
 * discovery) — the only moments the association is free.
 */
export const feedbackAnchors = sqliteTable(
  "feedback_anchors",
  {
    id: text("id").primaryKey(),
    source: text("source").notNull(),
    kind: text("kind").notNull(),
    // Slack ts or the GitHub comment/issue id. TEXT for both: a Slack ts is
    // not a number, and a GitHub id read back as a float loses precision.
    externalId: text("external_id").notNull(),
    nodeId: text("node_id"),
    // '' is a SENTINEL, not an oversight: SQLite treats NULLs as DISTINCT in a
    // UNIQUE, so a NULL here would make the constraint below (and the
    // ON CONFLICT targeting it) silently inoperative for every GitHub anchor.
    // The store maps '' ↔ null at its boundary.
    channel: text("channel").notNull().default(""),
    owner: text("owner"),
    repo: text("repo"),
    issueNumber: integer("issue_number"),
    // Nullable on purpose: a bot comment we cannot tie to a run is still
    // worth anchoring — dropping it loses the reaction, not just the run.
    workflowRunId: text("workflow_run_id"),
    workflowName: text("workflow_name"),
    messagingSessionId: text("messaging_session_id"),
    createdAt: text("created_at").notNull(),
    lastPolledAt: text("last_polled_at"),
  },
  (t) => [
    unique().on(t.source, t.channel, t.externalId),
    // Duplicates the UNIQUE autoindex above — same columns, same order.
    // Declared anyway, for the same DROP INDEX reason as idx_users_login.
    index("idx_feedback_anchors_lookup").on(t.source, t.channel, t.externalId),
    index("idx_feedback_anchors_run").on(t.workflowRunId),
    // The poller's rotation: least-recently-polled first, within the window.
    index("idx_feedback_anchors_poll").on(t.source, t.createdAt, t.lastPolledAt),
  ],
);

/**
 * One row per (anchor, reactor, emoji) — a 👍/👎 scored against the run that
 * wrote the thing reacted to. Attribution columns are denormalized from the
 * anchor because they never change for a given anchor.
 */
export const feedbackSignals = sqliteTable(
  "feedback_signals",
  {
    id: text("id").primaryKey(),
    // A logical reference to feedback_anchors.id with NO `REFERENCES` clause
    // in the legacy DDL — keep it a plain column.
    anchorId: text("anchor_id").notNull(),
    source: text("source").notNull(),
    workflowRunId: text("workflow_run_id"),
    workflowName: text("workflow_name"),
    messagingSessionId: text("messaging_session_id"),
    owner: text("owner"),
    repo: text("repo"),
    issueNumber: integer("issue_number"),
    emoji: text("emoji").notNull(),
    // −2..+2; 0 means "recorded, not scored". A real number, NOT a boolean.
    score: integer("score").notNull(),
    sentiment: text("sentiment").notNull(),
    reactor: text("reactor"),
    reactedAt: text("reacted_at"),
    observedAt: text("observed_at").notNull(),
    // Retracting rather than deleting keeps "somebody thumbed this and then
    // thought better of it" visible; every score query filters IS NULL.
    removedAt: text("removed_at"),
    // OTel export watermark — null means not yet exported.
    exportedAt: text("exported_at"),
  },
  (t) => [
    // `reactor` is nullable, so unlike the anchors table this does NOT bind
    // for null reactors. Transcribed as-is — do not "fix" it.
    unique().on(t.anchorId, t.reactor, t.emoji),
    index("idx_feedback_signals_anchor").on(t.anchorId),
    index("idx_feedback_signals_run").on(t.workflowRunId),
    index("idx_feedback_signals_observed").on(sql`${t.observedAt} DESC`),
    index("idx_feedback_signals_workflow").on(t.workflowName, sql`${t.observedAt} DESC`),
    index("idx_feedback_signals_export").on(t.exportedAt),
  ],
);

// ── GitHub team-based dashboard visibility (issue #169) ──────────────────────
// A CACHE, not a mirror of the org: rows appear only for the teams of somebody
// who actually logged in. Absence means "unknown", never "no access", so every
// read path fails open. Safe to delete wholesale; it refills.

/** One row per team we have ever resolved repos for. */
export const githubTeams = sqliteTable(
  "github_teams",
  {
    org: text("org").notNull(),
    slug: text("slug").notNull(),
    name: text("name"),
    reposSyncedAt: text("repos_synced_at").notNull(),
    // True when enumeration hit the per-team page budget and stopped early, so
    // github_team_repos is a PREFIX of the real grant — its members must then
    // fail open.
    truncated: integer("truncated", { mode: "boolean" }).notNull().default(false),
  },
  (t) => [primaryKey({ columns: [t.org, t.slug] })],
);

/**
 * A team's grant, already intersected with the managed-repo set. `repo` holds
 * the QUALIFIED owner/repo full name — unlike everywhere else post-#279, so
 * the bare-repo rule does not apply here.
 */
export const githubTeamRepos = sqliteTable(
  "github_team_repos",
  {
    org: text("org").notNull(),
    // (org, team_slug) logically references github_teams.(org, slug) — note
    // the column-name mismatch and that no FK is declared. Keep it that way.
    teamSlug: text("team_slug").notNull(),
    repo: text("repo").notNull(),
  },
  (t) => [primaryKey({ columns: [t.org, t.teamSlug, t.repo] })],
);

/** Membership we have LEARNED, not enumerated. */
export const githubTeamMembers = sqliteTable(
  "github_team_members",
  {
    org: text("org").notNull(),
    teamSlug: text("team_slug").notNull(),
    login: text("login").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.org, t.teamSlug, t.login] }),
    // reposForLogin joins membership → team_repos on this column.
    index("idx_github_team_members_login").on(t.login),
  ],
);

/**
 * Per-login freshness + outcome, so a resolution that failed or blew its
 * request budget is remembered for the TTL rather than retried on every poll.
 * status is one of: ok | empty | truncated | error | disabled.
 */
export const githubVisibilitySync = sqliteTable("github_visibility_sync", {
  login: text("login").primaryKey(),
  syncedAt: text("synced_at").notNull(),
  status: text("status").notNull(),
  detail: text("detail"),
});

/**
 * Per-thread messaging conversations. Legacy owner: `SessionManager`, which
 * self-migrated this DDL against the raw handle.
 */
export const messagingSessions = sqliteTable(
  "messaging_sessions",
  {
    id: text("id").primaryKey(),
    platform: text("platform").notNull(),
    channelId: text("channel_id").notNull(),
    // Nullable while being a key column of the unique index below, so
    // DM-style sessions with no thread do not collide.
    threadId: text("thread_id"),
    userId: text("user_id").notNull(),
    agentSessionId: text("agent_session_id"),
    createdAt: text("created_at").notNull(),
    lastActivityAt: text("last_activity_at").notNull(),
    // These two are the only DEFAULT-without-NOT-NULL columns in the schema —
    // everything else pairs them. Transcribed as-is. Since `active` is the
    // partial index's predicate, a NULL-active row is exempt from uniqueness.
    messageCount: integer("message_count").default(0),
    active: integer("active", { mode: "boolean" }).default(true),
  },
  (t) => [
    index("idx_msg_sessions_lookup").on(t.platform, t.channelId, t.threadId, t.userId),
    // "One ACTIVE session per key". Do NOT restore the table-level
    // UNIQUE(platform, channel_id, thread_id, user_id) this replaced: a
    // deactivated row occupied the key, so a returning user could never start
    // a new session. SessionManager.rebuildWithoutTableUnique() exists purely
    // to strip that constraint from databases still carrying it.
    uniqueIndex("idx_msg_sessions_unique_active")
      .on(t.platform, t.channelId, t.threadId, t.userId)
      .where(sql`active = 1`),
  ],
);

/** Turn-by-turn transcript for a messaging session. */
export const messagingMessages = sqliteTable(
  "messaging_messages",
  {
    // The only AUTOINCREMENT in the schema; inserts never supply an id.
    id: integer("id").primaryKey({ autoIncrement: true }),
    // The ONLY declared foreign key in the entire 15-table schema (no ON
    // DELETE), and it is LIVE. Nothing sets `PRAGMA foreign_keys` explicitly,
    // which used to be read as "so it is declared-but-unenforced" — that was
    // wrong: better-sqlite3 and libsql BOTH default it on (verified on
    // @libsql/client 0.17 and better-sqlite3 13 — an orphan insert is rejected
    // by each). So it has always bitten in production, and it still does. The
    // legacy messaging rebuild toggles it off around the table swap precisely
    // because it is enforced (see `state/legacy-sqlite.ts`).
    sessionId: text("session_id")
      .notNull()
      .references(() => messagingSessions.id),
    role: text("role").notNull(),
    content: text("content").notNull(),
    timestamp: text("timestamp").notNull(),
    platformMessageId: text("platform_message_id"),
  },
  (t) => [index("idx_msg_messages_session").on(t.sessionId, t.timestamp)],
);
