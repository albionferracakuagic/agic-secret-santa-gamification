CREATE TYPE "public"."access_kind" AS ENUM('join', 'display');--> statement-breakpoint
CREATE TYPE "public"."board_state" AS ENUM('hidden', 'live', 'paused');--> statement-breakpoint
CREATE TYPE "public"."claim_method" AS ENUM('email_link', 'personal_code', 'organizer_approved');--> statement-breakpoint
CREATE TYPE "public"."gift_status" AS ENUM('registered', 'opened', 'revealed');--> statement-breakpoint
CREATE TYPE "public"."import_status" AS ENUM('draft', 'ready');--> statement-breakpoint
CREATE TYPE "public"."job_status" AS ENUM('pending', 'running', 'done', 'failed', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."organizer_role" AS ENUM('owner', 'co');--> statement-breakpoint
CREATE TYPE "public"."pairing_source" AS ENUM('import', 'manual');--> statement-breakpoint
CREATE TYPE "public"."participant_source" AS ENUM('import', 'join');--> statement-breakpoint
CREATE TYPE "public"."participant_status" AS ENUM('unclaimed', 'pending', 'active', 'removed');--> statement-breakpoint
CREATE TYPE "public"."phase" AS ENUM('preparation', 'registration', 'gift_registration', 'gift_opening', 'voting', 'games', 'reveal', 'awards', 'completed');--> statement-breakpoint
CREATE TABLE "account" (
	"id" text PRIMARY KEY NOT NULL,
	"account_id" text NOT NULL,
	"provider_id" text NOT NULL,
	"user_id" text NOT NULL,
	"access_token" text,
	"refresh_token" text,
	"id_token" text,
	"access_token_expires_at" timestamp with time zone,
	"refresh_token_expires_at" timestamp with time zone,
	"scope" text,
	"password" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "audit_log" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"event_id" uuid,
	"actor" text NOT NULL,
	"action" text NOT NULL,
	"target" text,
	"reason" text,
	"data" jsonb,
	"at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "awards" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"event_id" uuid NOT NULL,
	"board_key" text NOT NULL,
	"voting_round" integer DEFAULT 1 NOT NULL,
	"winners" jsonb NOT NULL,
	"tie_info" jsonb,
	"publishable" boolean DEFAULT false NOT NULL,
	"locked_at" timestamp with time zone,
	"invalidated_at" timestamp with time zone,
	"confirmed_by" text,
	"revealed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "board_publications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"event_id" uuid NOT NULL,
	"board_key" text NOT NULL,
	"state" "board_state" DEFAULT 'hidden' NOT NULL,
	"last_published" jsonb,
	"last_published_at" timestamp with time zone,
	"cursor" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "board_publications_event_board_uq" UNIQUE("event_id","board_key")
);
--> statement-breakpoint
CREATE TABLE "ceremony_state" (
	"event_id" uuid PRIMARY KEY NOT NULL,
	"script" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"step_index" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "event_access" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"event_id" uuid NOT NULL,
	"kind" "access_kind" NOT NULL,
	"token_hash" text NOT NULL,
	"short_code" text,
	"expires_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "event_access_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
CREATE TABLE "event_organizers" (
	"event_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"role" "organizer_role" NOT NULL,
	"participant_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "event_organizers_event_id_user_id_pk" PRIMARY KEY("event_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_id" text NOT NULL,
	"name" text NOT NULL,
	"starts_at" timestamp with time zone NOT NULL,
	"timezone" text NOT NULL,
	"description" text,
	"theme" text DEFAULT 'classic' NOT NULL,
	"budget_text" text,
	"max_participants" integer DEFAULT 100 NOT NULL,
	"phase" "phase" DEFAULT 'preparation' NOT NULL,
	"paused" boolean DEFAULT false NOT NULL,
	"gift_opening_started_at" timestamp with time zone,
	"voting_closed_at" timestamp with time zone,
	"reveal_started_at" timestamp with time zone,
	"ceremony_started_at" timestamp with time zone,
	"voting_round" integer DEFAULT 1 NOT NULL,
	"settings" jsonb NOT NULL,
	"default_locale" text DEFAULT 'en' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "gifts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"event_id" uuid NOT NULL,
	"giver_id" uuid NOT NULL,
	"alias_no" integer NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"photo_key" text,
	"status" "gift_status" DEFAULT 'registered' NOT NULL,
	"opening_order" integer,
	"opened_at" timestamp with time zone,
	"giver_revealed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "gifts_event_giver_uq" UNIQUE("event_id","giver_id"),
	CONSTRAINT "gifts_event_alias_uq" UNIQUE("event_id","alias_no")
);
--> statement-breakpoint
CREATE TABLE "media" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"event_id" uuid,
	"key" text NOT NULL,
	"owner_id" uuid,
	"kind" text NOT NULL,
	"mime" text NOT NULL,
	"size" integer NOT NULL,
	"deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "media_key_unique" UNIQUE("key")
);
--> statement-breakpoint
CREATE TABLE "pairing_imports" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"event_id" uuid NOT NULL,
	"file_name" text,
	"file_size" integer,
	"column_mapping" jsonb,
	"issue_summary" jsonb,
	"status" "import_status" DEFAULT 'draft' NOT NULL,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "pairings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"event_id" uuid NOT NULL,
	"giver_id" uuid NOT NULL,
	"recipient_id" uuid NOT NULL,
	"source" "pairing_source" NOT NULL,
	"import_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "pairings_event_giver_uq" UNIQUE("event_id","giver_id")
);
--> statement-breakpoint
CREATE TABLE "participant_achievements" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"event_id" uuid NOT NULL,
	"participant_id" uuid NOT NULL,
	"key" text NOT NULL,
	"unlocked_at" timestamp with time zone DEFAULT now() NOT NULL,
	"announced_at" timestamp with time zone,
	"source" text NOT NULL,
	CONSTRAINT "participant_achievements_uq" UNIQUE("participant_id","key")
);
--> statement-breakpoint
CREATE TABLE "participants" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"event_id" uuid NOT NULL,
	"display_name" text NOT NULL,
	"avatar" text,
	"email" text,
	"status" "participant_status" DEFAULT 'unclaimed' NOT NULL,
	"source" "participant_source" NOT NULL,
	"claim_method" "claim_method",
	"claim_verified_at" timestamp with time zone,
	"claim_code_hash" text,
	"session_token_hash" text,
	"locale" text DEFAULT 'en' NOT NULL,
	"prefs" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "participants_event_id_uq" UNIQUE("event_id","id")
);
--> statement-breakpoint
CREATE TABLE "scheduled_jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"event_id" uuid,
	"kind" text NOT NULL,
	"run_at" timestamp with time zone NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"status" "job_status" DEFAULT 'pending' NOT NULL,
	"locked_by" text,
	"attempts" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "session" (
	"id" text PRIMARY KEY NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"token" text NOT NULL,
	"ip_address" text,
	"user_agent" text,
	"user_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "session_token_unique" UNIQUE("token")
);
--> statement-breakpoint
CREATE TABLE "unmask_grants" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"event_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"reason" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "user" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"email" text NOT NULL,
	"email_verified" boolean DEFAULT false NOT NULL,
	"image" text,
	"is_platform_admin" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_email_unique" UNIQUE("email")
);
--> statement-breakpoint
CREATE TABLE "verification" (
	"id" text PRIMARY KEY NOT NULL,
	"identifier" text NOT NULL,
	"value" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "votes" (
	"category_id" uuid NOT NULL,
	"voter_id" uuid NOT NULL,
	"event_id" uuid NOT NULL,
	"gift_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "votes_category_id_voter_id_pk" PRIMARY KEY("category_id","voter_id")
);
--> statement-breakpoint
CREATE TABLE "voting_categories" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"event_id" uuid NOT NULL,
	"key" text NOT NULL,
	"name" jsonb NOT NULL,
	"description" jsonb,
	"enabled" boolean DEFAULT true NOT NULL,
	"sort" integer DEFAULT 0 NOT NULL,
	"board_enabled" boolean DEFAULT false NOT NULL,
	CONSTRAINT "voting_categories_event_key_uq" UNIQUE("event_id","key")
);
--> statement-breakpoint
CREATE TABLE "xp_ledger" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"event_id" uuid NOT NULL,
	"participant_id" uuid NOT NULL,
	"activity" text NOT NULL,
	"amount" integer NOT NULL,
	"reward_key" text NOT NULL,
	"qualifying" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "xp_ledger_reward_uq" UNIQUE("event_id","participant_id","reward_key")
);
--> statement-breakpoint
ALTER TABLE "account" ADD CONSTRAINT "account_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_event_id_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "awards" ADD CONSTRAINT "awards_event_id_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "awards" ADD CONSTRAINT "awards_confirmed_by_user_id_fk" FOREIGN KEY ("confirmed_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "board_publications" ADD CONSTRAINT "board_publications_event_id_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ceremony_state" ADD CONSTRAINT "ceremony_state_event_id_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "event_access" ADD CONSTRAINT "event_access_event_id_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "event_organizers" ADD CONSTRAINT "event_organizers_event_id_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "event_organizers" ADD CONSTRAINT "event_organizers_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "events" ADD CONSTRAINT "events_owner_id_user_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gifts" ADD CONSTRAINT "gifts_event_id_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gifts" ADD CONSTRAINT "gifts_giver_id_participants_id_fk" FOREIGN KEY ("giver_id") REFERENCES "public"."participants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "media" ADD CONSTRAINT "media_event_id_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pairing_imports" ADD CONSTRAINT "pairing_imports_event_id_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pairing_imports" ADD CONSTRAINT "pairing_imports_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pairings" ADD CONSTRAINT "pairings_event_id_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pairings" ADD CONSTRAINT "pairings_giver_id_participants_id_fk" FOREIGN KEY ("giver_id") REFERENCES "public"."participants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pairings" ADD CONSTRAINT "pairings_recipient_id_participants_id_fk" FOREIGN KEY ("recipient_id") REFERENCES "public"."participants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pairings" ADD CONSTRAINT "pairings_import_id_pairing_imports_id_fk" FOREIGN KEY ("import_id") REFERENCES "public"."pairing_imports"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "participant_achievements" ADD CONSTRAINT "participant_achievements_event_id_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "participant_achievements" ADD CONSTRAINT "participant_achievements_participant_id_participants_id_fk" FOREIGN KEY ("participant_id") REFERENCES "public"."participants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "participants" ADD CONSTRAINT "participants_event_id_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "participants" ADD CONSTRAINT "participants_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scheduled_jobs" ADD CONSTRAINT "scheduled_jobs_event_id_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session" ADD CONSTRAINT "session_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "unmask_grants" ADD CONSTRAINT "unmask_grants_event_id_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "unmask_grants" ADD CONSTRAINT "unmask_grants_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "votes" ADD CONSTRAINT "votes_category_id_voting_categories_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."voting_categories"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "votes" ADD CONSTRAINT "votes_voter_id_participants_id_fk" FOREIGN KEY ("voter_id") REFERENCES "public"."participants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "votes" ADD CONSTRAINT "votes_event_id_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "votes" ADD CONSTRAINT "votes_gift_id_gifts_id_fk" FOREIGN KEY ("gift_id") REFERENCES "public"."gifts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "voting_categories" ADD CONSTRAINT "voting_categories_event_id_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "xp_ledger" ADD CONSTRAINT "xp_ledger_event_id_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "xp_ledger" ADD CONSTRAINT "xp_ledger_participant_id_participants_id_fk" FOREIGN KEY ("participant_id") REFERENCES "public"."participants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "account_user_idx" ON "account" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "audit_log_event_idx" ON "audit_log" USING btree ("event_id","at");--> statement-breakpoint
CREATE INDEX "awards_event_idx" ON "awards" USING btree ("event_id","board_key","voting_round");--> statement-breakpoint
CREATE UNIQUE INDEX "event_access_short_code_uq" ON "event_access" USING btree ("short_code");--> statement-breakpoint
CREATE INDEX "event_access_event_idx" ON "event_access" USING btree ("event_id");--> statement-breakpoint
CREATE INDEX "events_owner_idx" ON "events" USING btree ("owner_id");--> statement-breakpoint
CREATE INDEX "pairings_recipient_idx" ON "pairings" USING btree ("recipient_id");--> statement-breakpoint
CREATE INDEX "participants_event_idx" ON "participants" USING btree ("event_id");--> statement-breakpoint
CREATE UNIQUE INDEX "participants_session_uq" ON "participants" USING btree ("session_token_hash");--> statement-breakpoint
CREATE INDEX "scheduled_jobs_due_idx" ON "scheduled_jobs" USING btree ("status","run_at");--> statement-breakpoint
CREATE INDEX "session_user_idx" ON "session" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "unmask_grants_event_idx" ON "unmask_grants" USING btree ("event_id","expires_at");--> statement-breakpoint
CREATE INDEX "votes_gift_idx" ON "votes" USING btree ("gift_id");