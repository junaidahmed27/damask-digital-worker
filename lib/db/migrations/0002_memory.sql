CREATE TABLE "chunks" (
	"id" text PRIMARY KEY NOT NULL,
	"event_id" text NOT NULL,
	"ordinal" integer NOT NULL,
	"text" text NOT NULL,
	"span_start" integer NOT NULL,
	"span_end" integer NOT NULL,
	"entity_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"scope" text DEFAULT 'org' NOT NULL,
	"embedding" jsonb DEFAULT '[]'::jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "classifications" (
	"id" text PRIMARY KEY NOT NULL,
	"event_id" text NOT NULL,
	"doc_type" text NOT NULL,
	"sensitivity" text DEFAULT 'normal' NOT NULL,
	"confidence" numeric(4, 3) NOT NULL,
	"candidate_deals" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"needs_review" boolean DEFAULT false NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "decision_records" (
	"id" text PRIMARY KEY NOT NULL,
	"entity_id" text NOT NULL,
	"outcome" text NOT NULL,
	"rationale" text NOT NULL,
	"decided_by" text,
	"decided_at" timestamp with time zone,
	"source_event_id" text NOT NULL,
	"span_start" integer NOT NULL,
	"span_end" integer NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "entities" (
	"id" text PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"name" text NOT NULL,
	"identifiers" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"aliases" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"scope" text DEFAULT 'org' NOT NULL,
	"born_from" text DEFAULT 'identifier' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "entity_links" (
	"id" text PRIMARY KEY NOT NULL,
	"event_id" text NOT NULL,
	"entity_id" text,
	"method" text NOT NULL,
	"confidence" numeric(4, 3) NOT NULL,
	"evidence" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"quarantined" boolean DEFAULT false NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "facts" (
	"id" text PRIMARY KEY NOT NULL,
	"entity_id" text NOT NULL,
	"attribute" text NOT NULL,
	"value" jsonb NOT NULL,
	"value_type" text NOT NULL,
	"unit" text,
	"valid_from" timestamp with time zone,
	"valid_to" timestamp with time zone,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	"superseded_at" timestamp with time zone,
	"source_event_id" text NOT NULL,
	"span_start" integer NOT NULL,
	"span_end" integer NOT NULL,
	"confidence" numeric(4, 3) NOT NULL,
	"scope" text DEFAULT 'org' NOT NULL
);
--> statement-breakpoint
CREATE TABLE "parsed_text" (
	"id" text PRIMARY KEY NOT NULL,
	"event_id" text NOT NULL,
	"text" text NOT NULL,
	"characters" integer DEFAULT 0 NOT NULL,
	"lines" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"parser" text NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "source_events" (
	"id" text PRIMARY KEY NOT NULL,
	"source" text NOT NULL,
	"source_id" text NOT NULL,
	"content_hash" text NOT NULL,
	"kind" text NOT NULL,
	"occurred_at" timestamp with time zone,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	"blob_ref" text,
	"bytes" integer DEFAULT 0 NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"scope" text DEFAULT 'org' NOT NULL
);
--> statement-breakpoint
CREATE INDEX "chunks_event_ordinal" ON "chunks" USING btree ("event_id","ordinal");--> statement-breakpoint
CREATE INDEX "entities_kind_name" ON "entities" USING btree ("kind","name");--> statement-breakpoint
CREATE INDEX "entity_links_event" ON "entity_links" USING btree ("event_id");--> statement-breakpoint
CREATE UNIQUE INDEX "entity_links_event_entity" ON "entity_links" USING btree ("event_id","entity_id");--> statement-breakpoint
CREATE INDEX "facts_entity_attribute" ON "facts" USING btree ("entity_id","attribute");--> statement-breakpoint
CREATE INDEX "facts_source" ON "facts" USING btree ("source_event_id");--> statement-breakpoint
CREATE UNIQUE INDEX "source_events_source_id" ON "source_events" USING btree ("source","source_id","content_hash");