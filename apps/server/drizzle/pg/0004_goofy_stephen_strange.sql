CREATE TABLE "harness_settings" (
	"key" text PRIMARY KEY NOT NULL,
	"value" jsonb NOT NULL,
	"updated_at" text NOT NULL,
	"updated_by" text
);
