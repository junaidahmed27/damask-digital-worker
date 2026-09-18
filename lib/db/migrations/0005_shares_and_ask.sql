CREATE TABLE "questions" (
	"id" text PRIMARY KEY NOT NULL,
	"asked_by" text NOT NULL,
	"text" text NOT NULL,
	"kind" text NOT NULL,
	"bundle_hash" text,
	"answer" text NOT NULL,
	"citations" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"clarification" text,
	"asked_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "shares" (
	"id" text PRIMARY KEY NOT NULL,
	"subject" text NOT NULL,
	"subject_id" text NOT NULL,
	"grantee_id" text NOT NULL,
	"grantee_org_id" text,
	"access" text DEFAULT 'read' NOT NULL,
	"scopes" jsonb DEFAULT '["org"]'::jsonb NOT NULL,
	"granted_by" text NOT NULL,
	"reason" text,
	"expires_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "templates" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text,
	"name" text NOT NULL,
	"description" text NOT NULL,
	"definition" jsonb NOT NULL,
	"from_sheet_id" text,
	"published_by" text NOT NULL,
	"visibility" text DEFAULT 'org' NOT NULL,
	"times_used" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "shares_subject" ON "shares" USING btree ("subject","subject_id");--> statement-breakpoint
CREATE INDEX "shares_grantee" ON "shares" USING btree ("grantee_id");--> statement-breakpoint
CREATE UNIQUE INDEX "templates_org_name" ON "templates" USING btree ("org_id","name");