ALTER TABLE "board_publications" ADD COLUMN "forced" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "ceremony_state" ADD COLUMN "status" text DEFAULT 'idle' NOT NULL;--> statement-breakpoint
ALTER TABLE "ceremony_state" ADD COLUMN "step_ends_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "ceremony_state" ADD COLUMN "voting_round" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "ceremony_state" ADD COLUMN "started_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "events" ADD COLUMN "completed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "events" ADD COLUMN "suspended_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "participants" ADD COLUMN "anonymized_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "awards" ADD CONSTRAINT "awards_event_board_round_uq" UNIQUE("event_id","board_key","voting_round");