CREATE TABLE `activity_log` (
	`id` text PRIMARY KEY NOT NULL,
	`created_at` text NOT NULL,
	`actor_login` text,
	`actor_type` text,
	`action` text NOT NULL,
	`target_type` text,
	`target_id` text,
	`outcome` text NOT NULL,
	`detail` text
);
--> statement-breakpoint
CREATE INDEX `idx_activity_created` ON `activity_log` ("created_at" DESC);--> statement-breakpoint
CREATE INDEX `idx_activity_actor_created` ON `activity_log` (`actor_login`,"created_at" DESC);--> statement-breakpoint
CREATE INDEX `idx_activity_target` ON `activity_log` (`target_type`,`target_id`);