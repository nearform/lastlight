ALTER TABLE "executions" ADD COLUMN "cpu_seconds" double precision;--> statement-breakpoint
ALTER TABLE "executions" ADD COLUMN "peak_memory_bytes" bigint;--> statement-breakpoint
ALTER TABLE "executions" ADD COLUMN "memory_limit_bytes" bigint;