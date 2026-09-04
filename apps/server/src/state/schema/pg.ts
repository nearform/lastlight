/**
 * PostgreSQL mirror of `./sqlite.ts`.
 *
 * Export names, table names, column property names, column names and index
 * names are IDENTICAL to the sqlite schema, so the stores' one set of queries
 * runs on both dialects — the stores resolve their table objects from the
 * client (`client.ts` → `tablesOf`), and this is what the Postgres leg gets.
 * `tests/state/schema-parity.test.ts` guards the mirror structurally.
 *
 * Type divergence is intentional and confined to four mappings:
 *
 * | sqlite | pg | why |
 * |---|---|---|
 * | `integer({ mode: "boolean" })` | `boolean()` | a real boolean; `= 1` does not exist here |
 * | `text({ mode: "json" }).$type<T>()` | `jsonb().$type<T>()` | locked decision 4 — real JSON, same `$type<T>` so the store-facing inferred types match |
 * | `real()` | `doublePrecision()` | `executions.cost_usd`, the only one |
 * | `integer().primaryKey({ autoIncrement: true })` | `integer().generatedAlwaysAsIdentity().primaryKey()` | `messaging_messages.id`, the only one. GENERATED ALWAYS rejects an explicit id — inserts never supply one |
 *
 * Everything else — including every ISO-8601 timestamp — stays `text()`, which
 * is locked: it keeps lexicographic ORDER BY and the `substr()` stats bucketing
 * (`dialect.ts`'s `dayBucket`/`hourBucket`) identical across dialects, and needs
 * no data migration.
 *
 * This file exists ONLY for `drizzle-kit generate` (drizzle-pg.config.ts) and
 * the PGlite test leg. **No runtime module may import it** — the boundary is
 * grepped in Phase 4's verification.
 */
import { sql } from "drizzle-orm";
import {
  boolean,
  doublePrecision,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  unique,
  uniqueIndex,
} from "drizzle-orm/pg-core";
// The same origin modules `sqlite.ts` imports these from — it does not
// re-export them, and neither does this file. Type-only, so no runtime edge.
import type { ExtensionStatusMap, SkillsStatus } from "lastlight-workflow-engine";
import type {
  ActivityAction,
  ActivityDetail,
  ActivityOutcome,
} from "../activity-store.js";
import type { TriggerActorType } from "../user-store.js";
import type { PhaseHistoryEntry } from "../workflow-run-store.js";

/** @see sqlite.ts → `executions` */
export const executions = pgTable(
  "executions",
  {
    id: text("id").primaryKey(),
    triggerType: text("trigger_type").notNull(),
    triggerId: text("trigger_id").notNull(),
    skill: text("skill").notNull(),
    owner: text("owner"),
    repo: text("repo"),
    issueNumber: integer("issue_number"),
    startedAt: text("started_at").notNull(),
    finishedAt: text("finished_at"),
    // TRI-STATE: null means still in flight — nullable on purpose.
    success: boolean("success"),
    error: text("error"),
    turns: integer("turns"),
    durationMs: integer("duration_ms"),
    triggeredBy: text("triggered_by"),
    triggerActorType: text("trigger_actor_type"),
    sessionId: text("session_id"),
    costUsd: doublePrecision("cost_usd"),
    inputTokens: integer("input_tokens"),
    cacheCreationInputTokens: integer("cache_creation_input_tokens"),
    cacheReadInputTokens: integer("cache_read_input_tokens"),
    outputTokens: integer("output_tokens"),
    apiDurationMs: integer("api_duration_ms"),
    stopReason: text("stop_reason"),
    workflowRunId: text("workflow_run_id"),
    outputText: text("output_text"),
    extensionStatus: jsonb("extension_status").$type<ExtensionStatusMap>(),
    skillsStatus: jsonb("skills_status").$type<SkillsStatus>(),
  },
  (t) => [
    index("idx_executions_trigger").on(t.triggerType, t.triggerId),
    index("idx_executions_skill").on(t.skill, t.startedAt),
    index("idx_executions_workflow_run").on(t.workflowRunId, t.skill),
  ],
);

/** @see sqlite.ts → `workflowRuns` */
export const workflowRuns = pgTable(
  "workflow_runs",
  {
    id: text("id").primaryKey(),
    workflowName: text("workflow_name").notNull(),
    triggerId: text("trigger_id").notNull(),
    owner: text("owner"),
    repo: text("repo"),
    issueNumber: integer("issue_number"),
    currentPhase: text("current_phase").notNull(),
    phaseHistory: jsonb("phase_history")
      .$type<PhaseHistoryEntry[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    status: text("status").notNull().default("running"),
    context: jsonb("context").$type<Record<string, unknown>>(),
    startedAt: text("started_at").notNull(),
    updatedAt: text("updated_at").notNull(),
    finishedAt: text("finished_at"),
    triggeredBy: text("triggered_by"),
    triggerActorType: text("trigger_actor_type"),
    scratch: jsonb("scratch").$type<Record<string, unknown>>(),
    restartCount: integer("restart_count").notNull().default(0),
    traceId: text("trace_id"),
    spanId: text("span_id"),
  },
  (t) => [
    index("idx_workflow_runs_trigger").on(t.triggerId, t.status),
    index("idx_workflow_runs_status").on(t.status),
    // pg-core has a real `.desc()` on index columns; sqlite-core does not, so
    // the sqlite twin spells the same thing with a `sql` expression.
    index("idx_workflow_runs_started_at").on(t.startedAt.desc()),
    index("idx_workflow_runs_name_started").on(t.workflowName, t.startedAt.desc()),
  ],
);

/** @see sqlite.ts → `cronOverrides` */
export const cronOverrides = pgTable("cron_overrides", {
  name: text("name").primaryKey(),
  enabled: boolean("enabled").notNull().default(true),
  schedule: text("schedule"),
  updatedAt: text("updated_at").notNull(),
  updatedBy: text("updated_by"),
});

/** @see sqlite.ts → `cronRuns` */
export const cronRuns = pgTable(
  "cron_runs",
  {
    id: text("id").primaryKey(),
    cronName: text("cron_name").notNull(),
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
  (t) => [index("idx_cron_runs_name_started").on(t.cronName, t.startedAt.desc())],
);

/** @see sqlite.ts → `workflowOverrides` */
export const workflowOverrides = pgTable("workflow_overrides", {
  name: text("name").primaryKey(),
  enabled: boolean("enabled").notNull().default(true),
  updatedAt: text("updated_at").notNull(),
  updatedBy: text("updated_by"),
});

/** @see sqlite.ts → `workflowApprovals` */
export const workflowApprovals = pgTable(
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
    kind: text("kind").notNull().default("approve"),
    // A handoff-doc FILENAME, never JSON — plain text on both legs.
    artifact: text("artifact"),
  },
  (t) => [
    index("idx_approvals_workflow").on(t.workflowRunId),
    index("idx_approvals_status").on(t.status),
  ],
);

/** @see sqlite.ts → `users` */
export const users = pgTable(
  "users",
  {
    id: text("id").primaryKey(),
    githubId: integer("github_id").unique(),
    login: text("login").unique(),
    name: text("name"),
    // Indexed but deliberately NOT unique (shared mailboxes).
    email: text("email"),
    avatarUrl: text("avatar_url"),
    slackUserId: text("slack_user_id").unique(),
    isBlocked: boolean("is_blocked").notNull().default(false),
    emailIsPlaceholder: boolean("email_is_placeholder").notNull().default(false),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
    lastLoginAt: text("last_login_at"),
  },
  (t) => [
    index("idx_users_login").on(t.login),
    index("idx_users_email").on(t.email),
    index("idx_users_slack").on(t.slackUserId),
  ],
);

/** @see sqlite.ts → `activityLog` */
export const activityLog = pgTable(
  "activity_log",
  {
    id: text("id").primaryKey(),
    createdAt: text("created_at").notNull(),
    actorLogin: text("actor_login"),
    actorType: text("actor_type").$type<TriggerActorType>(),
    action: text("action").notNull().$type<ActivityAction>(),
    targetType: text("target_type"),
    targetId: text("target_id"),
    outcome: text("outcome").notNull().$type<ActivityOutcome>(),
    detail: jsonb("detail").$type<ActivityDetail>(),
  },
  (t) => [
    index("idx_activity_created").on(t.createdAt.desc()),
    index("idx_activity_actor_created").on(t.actorLogin, t.createdAt.desc()),
    index("idx_activity_target").on(t.targetType, t.targetId),
  ],
);

/** @see sqlite.ts → `feedbackAnchors` */
export const feedbackAnchors = pgTable(
  "feedback_anchors",
  {
    id: text("id").primaryKey(),
    source: text("source").notNull(),
    kind: text("kind").notNull(),
    externalId: text("external_id").notNull(),
    nodeId: text("node_id"),
    // The `''` sentinel is STILL required here. Postgres, like SQLite, treats
    // NULLs as distinct in a UNIQUE, so a NULL would make the constraint below
    // (and the ON CONFLICT targeting it) inoperative for every GitHub anchor.
    // PG 15+ could express `UNIQUE NULLS NOT DISTINCT` instead — deliberately
    // not used: it would diverge from the sqlite leg and from `channelKey()`'s
    // `'' ↔ null` boundary mapping.
    channel: text("channel").notNull().default(""),
    owner: text("owner"),
    repo: text("repo"),
    issueNumber: integer("issue_number"),
    workflowRunId: text("workflow_run_id"),
    workflowName: text("workflow_name"),
    messagingSessionId: text("messaging_session_id"),
    createdAt: text("created_at").notNull(),
    lastPolledAt: text("last_polled_at"),
  },
  (t) => [
    unique().on(t.source, t.channel, t.externalId),
    index("idx_feedback_anchors_lookup").on(t.source, t.channel, t.externalId),
    index("idx_feedback_anchors_run").on(t.workflowRunId),
    index("idx_feedback_anchors_poll").on(t.source, t.createdAt, t.lastPolledAt),
  ],
);

/** @see sqlite.ts → `feedbackSignals` */
export const feedbackSignals = pgTable(
  "feedback_signals",
  {
    id: text("id").primaryKey(),
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
    removedAt: text("removed_at"),
    exportedAt: text("exported_at"),
  },
  (t) => [
    // `reactor` is nullable, so this does NOT bind for null reactors — same as
    // the sqlite leg. Transcribed as-is; do not "fix" it.
    unique().on(t.anchorId, t.reactor, t.emoji),
    index("idx_feedback_signals_anchor").on(t.anchorId),
    index("idx_feedback_signals_run").on(t.workflowRunId),
    index("idx_feedback_signals_observed").on(t.observedAt.desc()),
    index("idx_feedback_signals_workflow").on(t.workflowName, t.observedAt.desc()),
    index("idx_feedback_signals_export").on(t.exportedAt),
  ],
);

/** @see sqlite.ts → `githubTeams` */
export const githubTeams = pgTable(
  "github_teams",
  {
    org: text("org").notNull(),
    slug: text("slug").notNull(),
    name: text("name"),
    reposSyncedAt: text("repos_synced_at").notNull(),
    truncated: boolean("truncated").notNull().default(false),
  },
  (t) => [primaryKey({ columns: [t.org, t.slug] })],
);

/**
 * @see sqlite.ts → `githubTeamRepos`. `repo` holds the QUALIFIED owner/repo
 * full name — the one place post-#279 that does, so the bare-repo rule and
 * `qualifiedRepoSql` do not apply here.
 */
export const githubTeamRepos = pgTable(
  "github_team_repos",
  {
    org: text("org").notNull(),
    teamSlug: text("team_slug").notNull(),
    repo: text("repo").notNull(),
  },
  (t) => [primaryKey({ columns: [t.org, t.teamSlug, t.repo] })],
);

/** @see sqlite.ts → `githubTeamMembers` */
export const githubTeamMembers = pgTable(
  "github_team_members",
  {
    org: text("org").notNull(),
    teamSlug: text("team_slug").notNull(),
    login: text("login").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.org, t.teamSlug, t.login] }),
    index("idx_github_team_members_login").on(t.login),
  ],
);

/** @see sqlite.ts → `githubVisibilitySync` */
export const githubVisibilitySync = pgTable("github_visibility_sync", {
  login: text("login").primaryKey(),
  syncedAt: text("synced_at").notNull(),
  status: text("status").notNull(),
  detail: text("detail"),
});

/** @see sqlite.ts → `messagingSessions` */
export const messagingSessions = pgTable(
  "messaging_sessions",
  {
    id: text("id").primaryKey(),
    platform: text("platform").notNull(),
    channelId: text("channel_id").notNull(),
    threadId: text("thread_id"),
    userId: text("user_id").notNull(),
    agentSessionId: text("agent_session_id"),
    createdAt: text("created_at").notNull(),
    lastActivityAt: text("last_activity_at").notNull(),
    // The only two DEFAULT-without-NOT-NULL columns in the schema, on both
    // legs. Since `active` is the partial index's predicate, a NULL-active row
    // is exempt from uniqueness.
    messageCount: integer("message_count").default(0),
    active: boolean("active").default(true),
  },
  (t) => [
    index("idx_msg_sessions_lookup").on(t.platform, t.channelId, t.threadId, t.userId),
    // "One ACTIVE session per key". sqlite spells the predicate `active = 1`;
    // here `active` is a real boolean, so the bare column IS the predicate.
    // The parity test compares WHERE *presence*, not text.
    uniqueIndex("idx_msg_sessions_unique_active")
      .on(t.platform, t.channelId, t.threadId, t.userId)
      .where(sql`active`),
  ],
);

/** @see sqlite.ts → `messagingMessages` */
export const messagingMessages = pgTable(
  "messaging_messages",
  {
    // sqlite: INTEGER PK AUTOINCREMENT. Inserts NEVER supply an id, so
    // GENERATED ALWAYS is the faithful mirror — and will (correctly) error if
    // one ever does.
    id: integer("id").generatedAlwaysAsIdentity().primaryKey(),
    // The ONLY declared foreign key in the 15-table schema, and it is enforced
    // on both legs.
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
