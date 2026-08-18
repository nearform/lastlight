CREATE TABLE "cron_overrides" (
	"name" text PRIMARY KEY NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"schedule" text,
	"updated_at" text NOT NULL,
	"updated_by" text
);
--> statement-breakpoint
CREATE TABLE "cron_runs" (
	"id" text PRIMARY KEY NOT NULL,
	"cron_name" text NOT NULL,
	"workflow" text,
	"handler" text,
	"source" text NOT NULL,
	"actor" text,
	"started_at" text NOT NULL,
	"finished_at" text,
	"status" text DEFAULT 'running' NOT NULL,
	"repos_eligible" integer,
	"repos_scanned" integer,
	"discovered" integer,
	"dispatched" integer,
	"failures" integer,
	"error" text
);
--> statement-breakpoint
CREATE TABLE "executions" (
	"id" text PRIMARY KEY NOT NULL,
	"trigger_type" text NOT NULL,
	"trigger_id" text NOT NULL,
	"skill" text NOT NULL,
	"owner" text,
	"repo" text,
	"issue_number" integer,
	"started_at" text NOT NULL,
	"finished_at" text,
	"success" boolean,
	"error" text,
	"turns" integer,
	"duration_ms" integer,
	"triggered_by" text,
	"trigger_actor_type" text,
	"session_id" text,
	"cost_usd" double precision,
	"input_tokens" integer,
	"cache_creation_input_tokens" integer,
	"cache_read_input_tokens" integer,
	"output_tokens" integer,
	"api_duration_ms" integer,
	"stop_reason" text,
	"workflow_run_id" text,
	"output_text" text,
	"extension_status" jsonb,
	"skills_status" jsonb
);
--> statement-breakpoint
CREATE TABLE "feedback_anchors" (
	"id" text PRIMARY KEY NOT NULL,
	"source" text NOT NULL,
	"kind" text NOT NULL,
	"external_id" text NOT NULL,
	"node_id" text,
	"channel" text DEFAULT '' NOT NULL,
	"owner" text,
	"repo" text,
	"issue_number" integer,
	"workflow_run_id" text,
	"workflow_name" text,
	"messaging_session_id" text,
	"created_at" text NOT NULL,
	"last_polled_at" text,
	CONSTRAINT "feedback_anchors_source_channel_external_id_unique" UNIQUE("source","channel","external_id")
);
--> statement-breakpoint
CREATE TABLE "feedback_signals" (
	"id" text PRIMARY KEY NOT NULL,
	"anchor_id" text NOT NULL,
	"source" text NOT NULL,
	"workflow_run_id" text,
	"workflow_name" text,
	"messaging_session_id" text,
	"owner" text,
	"repo" text,
	"issue_number" integer,
	"emoji" text NOT NULL,
	"score" integer NOT NULL,
	"sentiment" text NOT NULL,
	"reactor" text,
	"reacted_at" text,
	"observed_at" text NOT NULL,
	"removed_at" text,
	"exported_at" text,
	CONSTRAINT "feedback_signals_anchor_id_reactor_emoji_unique" UNIQUE("anchor_id","reactor","emoji")
);
--> statement-breakpoint
CREATE TABLE "github_team_members" (
	"org" text NOT NULL,
	"team_slug" text NOT NULL,
	"login" text NOT NULL,
	CONSTRAINT "github_team_members_org_team_slug_login_pk" PRIMARY KEY("org","team_slug","login")
);
--> statement-breakpoint
CREATE TABLE "github_team_repos" (
	"org" text NOT NULL,
	"team_slug" text NOT NULL,
	"repo" text NOT NULL,
	CONSTRAINT "github_team_repos_org_team_slug_repo_pk" PRIMARY KEY("org","team_slug","repo")
);
--> statement-breakpoint
CREATE TABLE "github_teams" (
	"org" text NOT NULL,
	"slug" text NOT NULL,
	"name" text,
	"repos_synced_at" text NOT NULL,
	"truncated" boolean DEFAULT false NOT NULL,
	CONSTRAINT "github_teams_org_slug_pk" PRIMARY KEY("org","slug")
);
--> statement-breakpoint
CREATE TABLE "github_visibility_sync" (
	"login" text PRIMARY KEY NOT NULL,
	"synced_at" text NOT NULL,
	"status" text NOT NULL,
	"detail" text
);
--> statement-breakpoint
CREATE TABLE "messaging_messages" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "messaging_messages_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"session_id" text NOT NULL,
	"role" text NOT NULL,
	"content" text NOT NULL,
	"timestamp" text NOT NULL,
	"platform_message_id" text
);
--> statement-breakpoint
CREATE TABLE "messaging_sessions" (
	"id" text PRIMARY KEY NOT NULL,
	"platform" text NOT NULL,
	"channel_id" text NOT NULL,
	"thread_id" text,
	"user_id" text NOT NULL,
	"agent_session_id" text,
	"created_at" text NOT NULL,
	"last_activity_at" text NOT NULL,
	"message_count" integer DEFAULT 0,
	"active" boolean DEFAULT true
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" text PRIMARY KEY NOT NULL,
	"github_id" integer,
	"login" text,
	"name" text,
	"email" text,
	"avatar_url" text,
	"slack_user_id" text,
	"is_blocked" boolean DEFAULT false NOT NULL,
	"email_is_placeholder" boolean DEFAULT false NOT NULL,
	"created_at" text NOT NULL,
	"updated_at" text NOT NULL,
	"last_login_at" text,
	CONSTRAINT "users_github_id_unique" UNIQUE("github_id"),
	CONSTRAINT "users_login_unique" UNIQUE("login"),
	CONSTRAINT "users_slack_user_id_unique" UNIQUE("slack_user_id")
);
--> statement-breakpoint
CREATE TABLE "workflow_approvals" (
	"id" text PRIMARY KEY NOT NULL,
	"workflow_run_id" text NOT NULL,
	"gate" text NOT NULL,
	"summary" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"requested_by" text,
	"responded_by" text,
	"response" text,
	"responded_at" text,
	"created_at" text NOT NULL,
	"kind" text DEFAULT 'approve' NOT NULL,
	"artifact" text
);
--> statement-breakpoint
CREATE TABLE "workflow_overrides" (
	"name" text PRIMARY KEY NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"updated_at" text NOT NULL,
	"updated_by" text
);
--> statement-breakpoint
CREATE TABLE "workflow_runs" (
	"id" text PRIMARY KEY NOT NULL,
	"workflow_name" text NOT NULL,
	"trigger_id" text NOT NULL,
	"owner" text,
	"repo" text,
	"issue_number" integer,
	"current_phase" text NOT NULL,
	"phase_history" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"status" text DEFAULT 'running' NOT NULL,
	"context" jsonb,
	"started_at" text NOT NULL,
	"updated_at" text NOT NULL,
	"finished_at" text,
	"triggered_by" text,
	"trigger_actor_type" text,
	"scratch" jsonb,
	"restart_count" integer DEFAULT 0 NOT NULL,
	"trace_id" text,
	"span_id" text
);
--> statement-breakpoint
ALTER TABLE "messaging_messages" ADD CONSTRAINT "messaging_messages_session_id_messaging_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."messaging_sessions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_cron_runs_name_started" ON "cron_runs" USING btree ("cron_name","started_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "idx_executions_trigger" ON "executions" USING btree ("trigger_type","trigger_id");--> statement-breakpoint
CREATE INDEX "idx_executions_skill" ON "executions" USING btree ("skill","started_at");--> statement-breakpoint
CREATE INDEX "idx_executions_workflow_run" ON "executions" USING btree ("workflow_run_id","skill");--> statement-breakpoint
CREATE INDEX "idx_feedback_anchors_lookup" ON "feedback_anchors" USING btree ("source","channel","external_id");--> statement-breakpoint
CREATE INDEX "idx_feedback_anchors_run" ON "feedback_anchors" USING btree ("workflow_run_id");--> statement-breakpoint
CREATE INDEX "idx_feedback_anchors_poll" ON "feedback_anchors" USING btree ("source","created_at","last_polled_at");--> statement-breakpoint
CREATE INDEX "idx_feedback_signals_anchor" ON "feedback_signals" USING btree ("anchor_id");--> statement-breakpoint
CREATE INDEX "idx_feedback_signals_run" ON "feedback_signals" USING btree ("workflow_run_id");--> statement-breakpoint
CREATE INDEX "idx_feedback_signals_observed" ON "feedback_signals" USING btree ("observed_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "idx_feedback_signals_workflow" ON "feedback_signals" USING btree ("workflow_name","observed_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "idx_feedback_signals_export" ON "feedback_signals" USING btree ("exported_at");--> statement-breakpoint
CREATE INDEX "idx_github_team_members_login" ON "github_team_members" USING btree ("login");--> statement-breakpoint
CREATE INDEX "idx_msg_messages_session" ON "messaging_messages" USING btree ("session_id","timestamp");--> statement-breakpoint
CREATE INDEX "idx_msg_sessions_lookup" ON "messaging_sessions" USING btree ("platform","channel_id","thread_id","user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_msg_sessions_unique_active" ON "messaging_sessions" USING btree ("platform","channel_id","thread_id","user_id") WHERE active;--> statement-breakpoint
CREATE INDEX "idx_users_login" ON "users" USING btree ("login");--> statement-breakpoint
CREATE INDEX "idx_users_email" ON "users" USING btree ("email");--> statement-breakpoint
CREATE INDEX "idx_users_slack" ON "users" USING btree ("slack_user_id");--> statement-breakpoint
CREATE INDEX "idx_approvals_workflow" ON "workflow_approvals" USING btree ("workflow_run_id");--> statement-breakpoint
CREATE INDEX "idx_approvals_status" ON "workflow_approvals" USING btree ("status");--> statement-breakpoint
CREATE INDEX "idx_workflow_runs_trigger" ON "workflow_runs" USING btree ("trigger_id","status");--> statement-breakpoint
CREATE INDEX "idx_workflow_runs_status" ON "workflow_runs" USING btree ("status");--> statement-breakpoint
CREATE INDEX "idx_workflow_runs_started_at" ON "workflow_runs" USING btree ("started_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "idx_workflow_runs_name_started" ON "workflow_runs" USING btree ("workflow_name","started_at" DESC NULLS LAST);