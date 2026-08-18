-- HAND-EDITED BASELINE — do not regenerate over this file.
-- Hand-editing a drizzle migration is an anti-pattern EXCEPT exactly here:
-- this is a baseline over a journal-less legacy production DB
-- (lastlight.db, previously migrated by src/state/migrate.ts +
-- SessionManager inline DDL, with no __drizzle_migrations table).
-- Every statement carries IF NOT EXISTS so the file is a strict no-op on an
-- existing DB; the migrator then records it in __drizzle_migrations and all
-- FUTURE migrations are generated normally and never hand-edited.
-- Frozen once shipped: never edit after any DB (incl. prod) has applied it.
--
-- Two deliberate hand-edits beyond IF NOT EXISTS:
--   * boolean DEFAULTs emitted as true/false are rewritten to 1/0, matching
--     the legacy DDL text so PRAGMA table_info diffs are trivially clean.
--   * nothing else. The five drizzle-only `*_unique` indexes below are
--     GENERATED, not hand-added: drizzle-kit expresses column-level and
--     table-level UNIQUE as standalone unique indexes, where the legacy DDL
--     used inline constraints (sqlite_autoindex_*). Semantically identical,
--     structurally different, and safe to create over prod because the inline
--     constraint already guarantees no violating row exists. See
--     tests/state/schema-equivalence.test.ts, which compares the enforced
--     unique key-tuples rather than the index names.

CREATE TABLE IF NOT EXISTS `cron_overrides` (
	`name` text PRIMARY KEY NOT NULL,
	`enabled` integer DEFAULT 1 NOT NULL,
	`schedule` text,
	`updated_at` text NOT NULL,
	`updated_by` text
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `cron_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`cron_name` text NOT NULL,
	`workflow` text,
	`handler` text,
	`source` text NOT NULL,
	`actor` text,
	`started_at` text NOT NULL,
	`finished_at` text,
	`status` text DEFAULT 'running' NOT NULL,
	`repos_eligible` integer,
	`repos_scanned` integer,
	`discovered` integer,
	`dispatched` integer,
	`failures` integer,
	`error` text
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_cron_runs_name_started` ON `cron_runs` (`cron_name`,"started_at" DESC);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `executions` (
	`id` text PRIMARY KEY NOT NULL,
	`trigger_type` text NOT NULL,
	`trigger_id` text NOT NULL,
	`skill` text NOT NULL,
	`owner` text,
	`repo` text,
	`issue_number` integer,
	`started_at` text NOT NULL,
	`finished_at` text,
	`success` integer,
	`error` text,
	`turns` integer,
	`duration_ms` integer,
	`triggered_by` text,
	`trigger_actor_type` text,
	`session_id` text,
	`cost_usd` real,
	`input_tokens` integer,
	`cache_creation_input_tokens` integer,
	`cache_read_input_tokens` integer,
	`output_tokens` integer,
	`api_duration_ms` integer,
	`stop_reason` text,
	`workflow_run_id` text,
	`output_text` text,
	`extension_status` text,
	`skills_status` text
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_executions_trigger` ON `executions` (`trigger_type`,`trigger_id`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_executions_skill` ON `executions` (`skill`,`started_at`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_executions_workflow_run` ON `executions` (`workflow_run_id`,`skill`);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `feedback_anchors` (
	`id` text PRIMARY KEY NOT NULL,
	`source` text NOT NULL,
	`kind` text NOT NULL,
	`external_id` text NOT NULL,
	`node_id` text,
	`channel` text DEFAULT '' NOT NULL,
	`owner` text,
	`repo` text,
	`issue_number` integer,
	`workflow_run_id` text,
	`workflow_name` text,
	`messaging_session_id` text,
	`created_at` text NOT NULL,
	`last_polled_at` text
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_feedback_anchors_lookup` ON `feedback_anchors` (`source`,`channel`,`external_id`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_feedback_anchors_run` ON `feedback_anchors` (`workflow_run_id`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_feedback_anchors_poll` ON `feedback_anchors` (`source`,`created_at`,`last_polled_at`);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `feedback_anchors_source_channel_external_id_unique` ON `feedback_anchors` (`source`,`channel`,`external_id`);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `feedback_signals` (
	`id` text PRIMARY KEY NOT NULL,
	`anchor_id` text NOT NULL,
	`source` text NOT NULL,
	`workflow_run_id` text,
	`workflow_name` text,
	`messaging_session_id` text,
	`owner` text,
	`repo` text,
	`issue_number` integer,
	`emoji` text NOT NULL,
	`score` integer NOT NULL,
	`sentiment` text NOT NULL,
	`reactor` text,
	`reacted_at` text,
	`observed_at` text NOT NULL,
	`removed_at` text,
	`exported_at` text
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_feedback_signals_anchor` ON `feedback_signals` (`anchor_id`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_feedback_signals_run` ON `feedback_signals` (`workflow_run_id`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_feedback_signals_observed` ON `feedback_signals` ("observed_at" DESC);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_feedback_signals_workflow` ON `feedback_signals` (`workflow_name`,"observed_at" DESC);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_feedback_signals_export` ON `feedback_signals` (`exported_at`);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `feedback_signals_anchor_id_reactor_emoji_unique` ON `feedback_signals` (`anchor_id`,`reactor`,`emoji`);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `github_team_members` (
	`org` text NOT NULL,
	`team_slug` text NOT NULL,
	`login` text NOT NULL,
	PRIMARY KEY(`org`, `team_slug`, `login`)
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_github_team_members_login` ON `github_team_members` (`login`);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `github_team_repos` (
	`org` text NOT NULL,
	`team_slug` text NOT NULL,
	`repo` text NOT NULL,
	PRIMARY KEY(`org`, `team_slug`, `repo`)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `github_teams` (
	`org` text NOT NULL,
	`slug` text NOT NULL,
	`name` text,
	`repos_synced_at` text NOT NULL,
	`truncated` integer DEFAULT 0 NOT NULL,
	PRIMARY KEY(`org`, `slug`)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `github_visibility_sync` (
	`login` text PRIMARY KEY NOT NULL,
	`synced_at` text NOT NULL,
	`status` text NOT NULL,
	`detail` text
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `messaging_messages` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`session_id` text NOT NULL,
	`role` text NOT NULL,
	`content` text NOT NULL,
	`timestamp` text NOT NULL,
	`platform_message_id` text,
	FOREIGN KEY (`session_id`) REFERENCES `messaging_sessions`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_msg_messages_session` ON `messaging_messages` (`session_id`,`timestamp`);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `messaging_sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`platform` text NOT NULL,
	`channel_id` text NOT NULL,
	`thread_id` text,
	`user_id` text NOT NULL,
	`agent_session_id` text,
	`created_at` text NOT NULL,
	`last_activity_at` text NOT NULL,
	`message_count` integer DEFAULT 0,
	`active` integer DEFAULT 1
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_msg_sessions_lookup` ON `messaging_sessions` (`platform`,`channel_id`,`thread_id`,`user_id`);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `idx_msg_sessions_unique_active` ON `messaging_sessions` (`platform`,`channel_id`,`thread_id`,`user_id`) WHERE active = 1;--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `users` (
	`id` text PRIMARY KEY NOT NULL,
	`github_id` integer,
	`login` text,
	`name` text,
	`email` text,
	`avatar_url` text,
	`slack_user_id` text,
	`is_blocked` integer DEFAULT 0 NOT NULL,
	`email_is_placeholder` integer DEFAULT 0 NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`last_login_at` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `users_github_id_unique` ON `users` (`github_id`);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `users_login_unique` ON `users` (`login`);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `users_slack_user_id_unique` ON `users` (`slack_user_id`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_users_login` ON `users` (`login`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_users_email` ON `users` (`email`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_users_slack` ON `users` (`slack_user_id`);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `workflow_approvals` (
	`id` text PRIMARY KEY NOT NULL,
	`workflow_run_id` text NOT NULL,
	`gate` text NOT NULL,
	`summary` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`requested_by` text,
	`responded_by` text,
	`response` text,
	`responded_at` text,
	`created_at` text NOT NULL,
	`kind` text DEFAULT 'approve' NOT NULL,
	`artifact` text
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_approvals_workflow` ON `workflow_approvals` (`workflow_run_id`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_approvals_status` ON `workflow_approvals` (`status`);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `workflow_overrides` (
	`name` text PRIMARY KEY NOT NULL,
	`enabled` integer DEFAULT 1 NOT NULL,
	`updated_at` text NOT NULL,
	`updated_by` text
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `workflow_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`workflow_name` text NOT NULL,
	`trigger_id` text NOT NULL,
	`owner` text,
	`repo` text,
	`issue_number` integer,
	`current_phase` text NOT NULL,
	`phase_history` text DEFAULT '[]' NOT NULL,
	`status` text DEFAULT 'running' NOT NULL,
	`context` text,
	`started_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`finished_at` text,
	`triggered_by` text,
	`trigger_actor_type` text,
	`scratch` text,
	`restart_count` integer DEFAULT 0 NOT NULL,
	`trace_id` text,
	`span_id` text
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_workflow_runs_trigger` ON `workflow_runs` (`trigger_id`,`status`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_workflow_runs_status` ON `workflow_runs` (`status`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_workflow_runs_started_at` ON `workflow_runs` ("started_at" DESC);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_workflow_runs_name_started` ON `workflow_runs` (`workflow_name`,"started_at" DESC);