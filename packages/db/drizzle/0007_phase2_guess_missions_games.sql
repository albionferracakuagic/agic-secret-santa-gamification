CREATE TABLE "event_spotlights" (
	"event_id" uuid PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"data" jsonb NOT NULL,
	"shown_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "game_bingo_cards" (
	"game_id" uuid NOT NULL,
	"participant_id" uuid NOT NULL,
	"cells" jsonb NOT NULL,
	CONSTRAINT "game_bingo_cards_game_id_participant_id_pk" PRIMARY KEY("game_id","participant_id")
);
--> statement-breakpoint
CREATE TABLE "game_bingo_marks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"game_id" uuid NOT NULL,
	"participant_id" uuid NOT NULL,
	"cell" integer NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"decided_at" timestamp with time zone,
	CONSTRAINT "game_bingo_marks_uq" UNIQUE("game_id","participant_id","cell")
);
--> statement-breakpoint
CREATE TABLE "game_rounds" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"game_id" uuid NOT NULL,
	"idx" integer NOT NULL,
	"spec" jsonb NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"opens_at" timestamp with time zone,
	"ends_at" timestamp with time zone,
	"closed_at" timestamp with time zone,
	CONSTRAINT "game_rounds_game_idx_uq" UNIQUE("game_id","idx")
);
--> statement-breakpoint
CREATE TABLE "game_scores" (
	"game_id" uuid NOT NULL,
	"participant_id" uuid NOT NULL,
	"score" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "game_scores_game_id_participant_id_pk" PRIMARY KEY("game_id","participant_id")
);
--> statement-breakpoint
CREATE TABLE "game_submissions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"game_id" uuid NOT NULL,
	"round_id" uuid NOT NULL,
	"participant_id" uuid NOT NULL,
	"answer" text NOT NULL,
	"submitted_at" timestamp with time zone NOT NULL,
	"points" integer,
	CONSTRAINT "game_submissions_round_participant_uq" UNIQUE("round_id","participant_id")
);
--> statement-breakpoint
CREATE TABLE "mini_games" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"event_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"title" jsonb NOT NULL,
	"config" jsonb NOT NULL,
	"round_index" integer DEFAULT -1 NOT NULL,
	"step_ends_at" timestamp with time zone,
	"step_version" integer DEFAULT 0 NOT NULL,
	"results" jsonb,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "mission_assignments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"event_id" uuid NOT NULL,
	"participant_id" uuid NOT NULL,
	"mission_key" text NOT NULL,
	"status" text DEFAULT 'assigned' NOT NULL,
	"note" text,
	"swaps_used" integer DEFAULT 0 NOT NULL,
	"submitted_at" timestamp with time zone,
	"verified_at" timestamp with time zone,
	"verified_by" text,
	"announced_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "mission_assignments_participant_mission_uq" UNIQUE("participant_id","mission_key")
);
--> statement-breakpoint
CREATE TABLE "mission_opt_outs" (
	"event_id" uuid NOT NULL,
	"participant_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "mission_opt_outs_event_id_participant_id_pk" PRIMARY KEY("event_id","participant_id")
);
--> statement-breakpoint
CREATE TABLE "santa_clues" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"event_id" uuid NOT NULL,
	"gift_id" uuid NOT NULL,
	"giver_id" uuid NOT NULL,
	"text" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"decided_at" timestamp with time zone,
	"decided_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "santa_guesses" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"event_id" uuid NOT NULL,
	"gift_id" uuid NOT NULL,
	"guesser_id" uuid NOT NULL,
	"suspect_id" uuid NOT NULL,
	"source" text DEFAULT 'guess' NOT NULL,
	"correct" boolean,
	"settled_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "santa_guesses_gift_guesser_uq" UNIQUE("gift_id","guesser_id")
);
--> statement-breakpoint
ALTER TABLE "event_spotlights" ADD CONSTRAINT "event_spotlights_event_id_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "game_bingo_cards" ADD CONSTRAINT "game_bingo_cards_game_id_mini_games_id_fk" FOREIGN KEY ("game_id") REFERENCES "public"."mini_games"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "game_bingo_cards" ADD CONSTRAINT "game_bingo_cards_participant_id_participants_id_fk" FOREIGN KEY ("participant_id") REFERENCES "public"."participants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "game_bingo_marks" ADD CONSTRAINT "game_bingo_marks_game_id_mini_games_id_fk" FOREIGN KEY ("game_id") REFERENCES "public"."mini_games"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "game_bingo_marks" ADD CONSTRAINT "game_bingo_marks_participant_id_participants_id_fk" FOREIGN KEY ("participant_id") REFERENCES "public"."participants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "game_rounds" ADD CONSTRAINT "game_rounds_game_id_mini_games_id_fk" FOREIGN KEY ("game_id") REFERENCES "public"."mini_games"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "game_scores" ADD CONSTRAINT "game_scores_game_id_mini_games_id_fk" FOREIGN KEY ("game_id") REFERENCES "public"."mini_games"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "game_scores" ADD CONSTRAINT "game_scores_participant_id_participants_id_fk" FOREIGN KEY ("participant_id") REFERENCES "public"."participants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "game_submissions" ADD CONSTRAINT "game_submissions_game_id_mini_games_id_fk" FOREIGN KEY ("game_id") REFERENCES "public"."mini_games"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "game_submissions" ADD CONSTRAINT "game_submissions_round_id_game_rounds_id_fk" FOREIGN KEY ("round_id") REFERENCES "public"."game_rounds"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "game_submissions" ADD CONSTRAINT "game_submissions_participant_id_participants_id_fk" FOREIGN KEY ("participant_id") REFERENCES "public"."participants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mini_games" ADD CONSTRAINT "mini_games_event_id_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mission_assignments" ADD CONSTRAINT "mission_assignments_event_id_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mission_assignments" ADD CONSTRAINT "mission_assignments_participant_id_participants_id_fk" FOREIGN KEY ("participant_id") REFERENCES "public"."participants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mission_opt_outs" ADD CONSTRAINT "mission_opt_outs_event_id_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mission_opt_outs" ADD CONSTRAINT "mission_opt_outs_participant_id_participants_id_fk" FOREIGN KEY ("participant_id") REFERENCES "public"."participants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "santa_clues" ADD CONSTRAINT "santa_clues_event_id_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "santa_clues" ADD CONSTRAINT "santa_clues_gift_id_gifts_id_fk" FOREIGN KEY ("gift_id") REFERENCES "public"."gifts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "santa_clues" ADD CONSTRAINT "santa_clues_giver_id_participants_id_fk" FOREIGN KEY ("giver_id") REFERENCES "public"."participants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "santa_guesses" ADD CONSTRAINT "santa_guesses_event_id_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "santa_guesses" ADD CONSTRAINT "santa_guesses_gift_id_gifts_id_fk" FOREIGN KEY ("gift_id") REFERENCES "public"."gifts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "santa_guesses" ADD CONSTRAINT "santa_guesses_guesser_id_participants_id_fk" FOREIGN KEY ("guesser_id") REFERENCES "public"."participants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "santa_guesses" ADD CONSTRAINT "santa_guesses_suspect_id_participants_id_fk" FOREIGN KEY ("suspect_id") REFERENCES "public"."participants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "game_submissions_game_idx" ON "game_submissions" USING btree ("game_id");--> statement-breakpoint
CREATE INDEX "mini_games_event_idx" ON "mini_games" USING btree ("event_id");--> statement-breakpoint
CREATE UNIQUE INDEX "mini_games_one_active_uq" ON "mini_games" USING btree ("event_id") WHERE "mini_games"."status" in ('intro','round_open','round_closed','results');--> statement-breakpoint
CREATE INDEX "mission_assignments_event_idx" ON "mission_assignments" USING btree ("event_id","status");--> statement-breakpoint
CREATE INDEX "santa_clues_event_idx" ON "santa_clues" USING btree ("event_id","status");--> statement-breakpoint
CREATE INDEX "santa_clues_gift_idx" ON "santa_clues" USING btree ("gift_id");--> statement-breakpoint
CREATE INDEX "santa_guesses_event_idx" ON "santa_guesses" USING btree ("event_id");