CREATE TABLE "account_link_tokens" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"participant_id" uuid NOT NULL,
	"email" text NOT NULL,
	"token_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "account_link_tokens_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
CREATE TABLE "auction_bids" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"event_id" uuid NOT NULL,
	"prize_id" uuid NOT NULL,
	"bidder_id" uuid NOT NULL,
	"amount" integer NOT NULL,
	"status" text DEFAULT 'leading' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "auction_bids_prize_amount_uq" UNIQUE("prize_id","amount")
);
--> statement-breakpoint
CREATE TABLE "auction_prizes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"event_id" uuid NOT NULL,
	"title" jsonb NOT NULL,
	"reveal" jsonb NOT NULL,
	"min_bid" integer DEFAULT 1 NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"on_stage" boolean DEFAULT false NOT NULL,
	"ends_at" timestamp with time zone,
	"extensions" integer DEFAULT 0 NOT NULL,
	"close_version" integer DEFAULT 0 NOT NULL,
	"winner_id" uuid,
	"winning_bid" integer,
	"sort" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"closed_at" timestamp with time zone,
	"revealed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "coin_ledger" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"event_id" uuid NOT NULL,
	"participant_id" uuid NOT NULL,
	"reason" text NOT NULL,
	"amount" integer NOT NULL,
	"reward_key" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "coin_ledger_reward_uq" UNIQUE("event_id","participant_id","reward_key")
);
--> statement-breakpoint
CREATE TABLE "custom_achievements" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"event_id" uuid NOT NULL,
	"key" text NOT NULL,
	"name" jsonb NOT NULL,
	"description" jsonb NOT NULL,
	"category_key" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "custom_achievements_event_key_uq" UNIQUE("event_id","key")
);
--> statement-breakpoint
CREATE TABLE "event_archives" (
	"event_id" uuid PRIMARY KEY NOT NULL,
	"snapshot" jsonb NOT NULL,
	"completed_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "lifetime_titles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"event_id" uuid NOT NULL,
	"event_name" text NOT NULL,
	"year" integer NOT NULL,
	"key" text NOT NULL,
	"trophy" boolean DEFAULT false NOT NULL,
	"earned_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "lifetime_titles_uq" UNIQUE("user_id","event_id","key")
);
--> statement-breakpoint
CREATE TABLE "outbox_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"seq" bigserial NOT NULL,
	"event_id" uuid,
	"topic" text NOT NULL,
	"payload" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"dispatched_at" timestamp with time zone,
	"attempts" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "season_xp" (
	"user_id" text NOT NULL,
	"event_id" uuid NOT NULL,
	"owner_id" text NOT NULL,
	"year" integer NOT NULL,
	"xp" integer NOT NULL,
	CONSTRAINT "season_xp_user_id_event_id_pk" PRIMARY KEY("user_id","event_id")
);
--> statement-breakpoint
ALTER TABLE "voting_categories" ADD COLUMN "custom" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "account_link_tokens" ADD CONSTRAINT "account_link_tokens_participant_id_participants_id_fk" FOREIGN KEY ("participant_id") REFERENCES "public"."participants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "auction_bids" ADD CONSTRAINT "auction_bids_event_id_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "auction_bids" ADD CONSTRAINT "auction_bids_prize_id_auction_prizes_id_fk" FOREIGN KEY ("prize_id") REFERENCES "public"."auction_prizes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "auction_bids" ADD CONSTRAINT "auction_bids_bidder_id_participants_id_fk" FOREIGN KEY ("bidder_id") REFERENCES "public"."participants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "auction_prizes" ADD CONSTRAINT "auction_prizes_event_id_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "auction_prizes" ADD CONSTRAINT "auction_prizes_winner_id_participants_id_fk" FOREIGN KEY ("winner_id") REFERENCES "public"."participants"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "coin_ledger" ADD CONSTRAINT "coin_ledger_event_id_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "coin_ledger" ADD CONSTRAINT "coin_ledger_participant_id_participants_id_fk" FOREIGN KEY ("participant_id") REFERENCES "public"."participants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "custom_achievements" ADD CONSTRAINT "custom_achievements_event_id_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "event_archives" ADD CONSTRAINT "event_archives_event_id_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lifetime_titles" ADD CONSTRAINT "lifetime_titles_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "season_xp" ADD CONSTRAINT "season_xp_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "account_link_tokens_participant_idx" ON "account_link_tokens" USING btree ("participant_id");--> statement-breakpoint
CREATE INDEX "auction_bids_prize_idx" ON "auction_bids" USING btree ("prize_id");--> statement-breakpoint
CREATE INDEX "auction_prizes_event_idx" ON "auction_prizes" USING btree ("event_id");--> statement-breakpoint
CREATE UNIQUE INDEX "auction_prizes_one_stage_uq" ON "auction_prizes" USING btree ("event_id") WHERE "auction_prizes"."on_stage";--> statement-breakpoint
CREATE INDEX "coin_ledger_participant_idx" ON "coin_ledger" USING btree ("participant_id");--> statement-breakpoint
CREATE INDEX "lifetime_titles_user_idx" ON "lifetime_titles" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "outbox_pending_idx" ON "outbox_events" USING btree ("dispatched_at","created_at");--> statement-breakpoint
CREATE INDEX "season_xp_owner_idx" ON "season_xp" USING btree ("owner_id","year");