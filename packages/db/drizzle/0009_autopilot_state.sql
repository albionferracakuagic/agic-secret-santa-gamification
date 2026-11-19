CREATE TABLE "autopilot_state" (
	"event_id" uuid PRIMARY KEY NOT NULL,
	"state" jsonb NOT NULL,
	"claim_seq" integer,
	"claimed_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "autopilot_state" ADD CONSTRAINT "autopilot_state_event_id_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE cascade ON UPDATE no action;