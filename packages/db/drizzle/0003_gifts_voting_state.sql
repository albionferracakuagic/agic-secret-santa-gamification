ALTER TABLE "events" ADD COLUMN "voting_ends_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "events" ADD COLUMN "current_gift_id" uuid;--> statement-breakpoint
ALTER TABLE "gifts" ADD COLUMN "hidden" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "gifts" ADD CONSTRAINT "gifts_revealed_consistent" CHECK (("gifts"."status" = 'revealed') = ("gifts"."giver_revealed_at" is not null));