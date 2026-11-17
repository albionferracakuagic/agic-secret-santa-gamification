CREATE TABLE "claim_tokens" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"participant_id" uuid NOT NULL,
	"method" "claim_method" NOT NULL,
	"token_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "claim_tokens_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
ALTER TABLE "participants" ADD COLUMN "reactions_muted" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "claim_tokens" ADD CONSTRAINT "claim_tokens_participant_id_participants_id_fk" FOREIGN KEY ("participant_id") REFERENCES "public"."participants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "claim_tokens_participant_idx" ON "claim_tokens" USING btree ("participant_id");