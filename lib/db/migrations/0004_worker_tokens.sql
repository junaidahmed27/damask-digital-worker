CREATE TABLE "worker_tokens" (
	"id" text PRIMARY KEY NOT NULL,
	"worker_id" text NOT NULL,
	"name" text NOT NULL,
	"token_hash" text NOT NULL,
	"scopes" jsonb DEFAULT '["org"]'::jsonb NOT NULL,
	"last_used_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "worker_tokens_hash" ON "worker_tokens" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "worker_tokens_worker" ON "worker_tokens" USING btree ("worker_id");