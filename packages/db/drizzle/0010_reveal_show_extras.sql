CREATE TABLE "show_choice_ballots" (
	"round_id" uuid NOT NULL,
	"participant_id" uuid NOT NULL,
	"choice" text NOT NULL,
	"voted_at" timestamp with time zone NOT NULL,
	CONSTRAINT "show_choice_ballots_pk" PRIMARY KEY("round_id","participant_id"),
	CONSTRAINT "show_choice_ballots_choice_ck" CHECK ("show_choice_ballots"."choice" in ('snowstorm','sleigh_bells'))
);
--> statement-breakpoint
CREATE TABLE "show_choice_rounds" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"event_id" uuid NOT NULL,
	"round_no" integer NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"opened_at" timestamp with time zone NOT NULL,
	"ends_at" timestamp with time zone NOT NULL,
	"closed_at" timestamp with time zone,
	"result" text,
	CONSTRAINT "show_choice_rounds_event_round_uq" UNIQUE("event_id","round_no"),
	CONSTRAINT "show_choice_rounds_result_consistent" CHECK (("show_choice_rounds"."status" = 'closed') = ("show_choice_rounds"."result" is not null))
);
--> statement-breakpoint
CREATE TABLE "show_tree_lights" (
	"event_id" uuid NOT NULL,
	"gift_id" uuid NOT NULL,
	"participant_id" uuid NOT NULL,
	"lit_at" timestamp with time zone NOT NULL,
	CONSTRAINT "show_tree_lights_pk" PRIMARY KEY("gift_id","participant_id")
);
--> statement-breakpoint
ALTER TABLE "show_choice_ballots" ADD CONSTRAINT "show_choice_ballots_round_id_show_choice_rounds_id_fk" FOREIGN KEY ("round_id") REFERENCES "public"."show_choice_rounds"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "show_choice_ballots" ADD CONSTRAINT "show_choice_ballots_participant_id_participants_id_fk" FOREIGN KEY ("participant_id") REFERENCES "public"."participants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "show_choice_rounds" ADD CONSTRAINT "show_choice_rounds_event_id_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "show_tree_lights" ADD CONSTRAINT "show_tree_lights_event_id_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "show_tree_lights" ADD CONSTRAINT "show_tree_lights_gift_id_gifts_id_fk" FOREIGN KEY ("gift_id") REFERENCES "public"."gifts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "show_tree_lights" ADD CONSTRAINT "show_tree_lights_participant_id_participants_id_fk" FOREIGN KEY ("participant_id") REFERENCES "public"."participants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "show_choice_rounds_one_open_uq" ON "show_choice_rounds" USING btree ("event_id") WHERE "show_choice_rounds"."status" = 'open';--> statement-breakpoint
CREATE INDEX "show_tree_lights_event_idx" ON "show_tree_lights" USING btree ("event_id");