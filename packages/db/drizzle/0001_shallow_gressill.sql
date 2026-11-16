ALTER TABLE "scheduled_jobs" ADD COLUMN "locked_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "scheduled_jobs" ADD COLUMN "last_error" text;