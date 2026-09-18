CREATE TABLE "cells" (
	"id" text PRIMARY KEY NOT NULL,
	"sheet_id" text NOT NULL,
	"row_id" text NOT NULL,
	"column_id" text NOT NULL,
	"value" jsonb,
	"set_by" text NOT NULL,
	"set_from" text NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "check_results" (
	"id" text PRIMARY KEY NOT NULL,
	"contract_id" text NOT NULL,
	"check_id" text NOT NULL,
	"passed" boolean NOT NULL,
	"details" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"evidence_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "columns" (
	"id" text PRIMARY KEY NOT NULL,
	"sheet_id" text NOT NULL,
	"name" text NOT NULL,
	"type" text NOT NULL,
	"config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"position" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "connector_events" (
	"id" text PRIMARY KEY NOT NULL,
	"connector_id" text NOT NULL,
	"kind" text NOT NULL,
	"payload" jsonb NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "connectors" (
	"id" text PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"impl" text NOT NULL,
	"config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"capabilities" jsonb NOT NULL,
	"data_policy" text DEFAULT 'allowed' NOT NULL,
	"policy_note" text,
	"status" text DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "contracts" (
	"id" text PRIMARY KEY NOT NULL,
	"run_id" text NOT NULL,
	"parent_id" text,
	"key" text NOT NULL,
	"title" text NOT NULL,
	"goal" text NOT NULL,
	"owner_id" text,
	"state" text DEFAULT 'drafted' NOT NULL,
	"check_id" text,
	"check_params" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"evidence_required" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"inputs" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"outputs" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"budget" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"deadline" timestamp with time zone,
	"escalation_to" text,
	"blocked_by" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"max_attempts" integer DEFAULT 2 NOT NULL,
	"confidence" numeric(4, 3),
	"position" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "evidence" (
	"id" text PRIMARY KEY NOT NULL,
	"contract_id" text NOT NULL,
	"kind" text NOT NULL,
	"uri" text,
	"body" jsonb,
	"sha256" text NOT NULL,
	"source_connector" text,
	"as_of" timestamp with time zone,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "invariants" (
	"id" text PRIMARY KEY NOT NULL,
	"sheet_id" text,
	"run_id" text,
	"name" text NOT NULL,
	"expression" text NOT NULL,
	"severity" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "memberships" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"worker_id" text NOT NULL,
	"role" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "orgs" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "projections" (
	"id" text PRIMARY KEY NOT NULL,
	"contract_id" text,
	"run_id" text,
	"surface" text NOT NULL,
	"external_id" text NOT NULL,
	"last_synced_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "proposals" (
	"id" text PRIMARY KEY NOT NULL,
	"sheet_id" text NOT NULL,
	"kind" text NOT NULL,
	"payload" jsonb NOT NULL,
	"proposed_by" text NOT NULL,
	"reason" text NOT NULL,
	"evidence_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"decided_by" text,
	"decided_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "records" (
	"id" text PRIMARY KEY NOT NULL,
	"sheet_id" text NOT NULL,
	"kind" text NOT NULL,
	"fields" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"source" text,
	"created_by" text NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "rules" (
	"id" text PRIMARY KEY NOT NULL,
	"sheet_id" text NOT NULL,
	"name" text NOT NULL,
	"trigger" jsonb NOT NULL,
	"condition" text,
	"action" jsonb NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "runs" (
	"id" text PRIMARY KEY NOT NULL,
	"workflow_id" text NOT NULL,
	"workflow_version" integer NOT NULL,
	"goal" text NOT NULL,
	"requested_by" text NOT NULL,
	"status" text DEFAULT 'drafted' NOT NULL,
	"namespace" text DEFAULT 'live' NOT NULL,
	"deadline" timestamp with time zone,
	"budget_tokens" integer,
	"budget_usd" numeric(10, 2),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "runs_history" (
	"id" text PRIMARY KEY NOT NULL,
	"workflow_name" text NOT NULL,
	"workflow_version" integer NOT NULL,
	"run_id" text NOT NULL,
	"contract_key" text NOT NULL,
	"check_id" text,
	"passed" boolean,
	"output_shape" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sheets" (
	"id" text PRIMARY KEY NOT NULL,
	"run_id" text,
	"org_id" text,
	"name" text NOT NULL,
	"shape" text NOT NULL,
	"definition_version" integer DEFAULT 1 NOT NULL,
	"parent_row_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "signals" (
	"id" text PRIMARY KEY NOT NULL,
	"contract_id" text,
	"sheet_id" text,
	"worker_id" text NOT NULL,
	"kind" text NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "transitions" (
	"id" text PRIMARY KEY NOT NULL,
	"contract_id" text NOT NULL,
	"seq" integer NOT NULL,
	"from_state" text,
	"to_state" text NOT NULL,
	"actor_id" text NOT NULL,
	"reason" text,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	"prev_hash" text NOT NULL,
	"hash" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "workers" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text,
	"name" text NOT NULL,
	"kind" text NOT NULL,
	"identity" text,
	"slack_user_id" text,
	"places" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"can_touch" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"never_without_human" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"role" text,
	"status" text DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "workflows" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"version" integer NOT NULL,
	"definition" jsonb NOT NULL,
	"pack" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "cells_sheet_row_col" ON "cells" USING btree ("sheet_id","row_id","column_id","recorded_at");--> statement-breakpoint
CREATE INDEX "check_results_contract" ON "check_results" USING btree ("contract_id");--> statement-breakpoint
CREATE UNIQUE INDEX "columns_sheet_name" ON "columns" USING btree ("sheet_id","name");--> statement-breakpoint
CREATE INDEX "contracts_run_state" ON "contracts" USING btree ("run_id","state");--> statement-breakpoint
CREATE UNIQUE INDEX "contracts_run_key" ON "contracts" USING btree ("run_id","key");--> statement-breakpoint
CREATE INDEX "evidence_contract" ON "evidence" USING btree ("contract_id");--> statement-breakpoint
CREATE UNIQUE INDEX "memberships_org_worker" ON "memberships" USING btree ("org_id","worker_id");--> statement-breakpoint
CREATE INDEX "projections_surface_external" ON "projections" USING btree ("surface","external_id");--> statement-breakpoint
CREATE INDEX "records_sheet_kind" ON "records" USING btree ("sheet_id","kind");--> statement-breakpoint
CREATE INDEX "transitions_contract_recorded" ON "transitions" USING btree ("contract_id","recorded_at");--> statement-breakpoint
CREATE UNIQUE INDEX "transitions_contract_seq" ON "transitions" USING btree ("contract_id","seq");--> statement-breakpoint
CREATE UNIQUE INDEX "workers_identity" ON "workers" USING btree ("identity");--> statement-breakpoint
CREATE UNIQUE INDEX "workflows_name_version" ON "workflows" USING btree ("name","version");