CREATE TABLE "idempotency_keys" (
	"key" text PRIMARY KEY NOT NULL,
	"fingerprint" text NOT NULL,
	"state" text NOT NULL,
	"status" integer,
	"body" text,
	"content_type" text,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE INDEX "idempotency_keys_expires_idx" ON "idempotency_keys" USING btree ("expires_at");