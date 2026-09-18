CREATE TABLE "cell_comments" (
	"id" text PRIMARY KEY NOT NULL,
	"sheet_id" text NOT NULL,
	"row_id" text NOT NULL,
	"column_id" text,
	"parent_id" text,
	"body" text NOT NULL,
	"author_id" text NOT NULL,
	"mirrored_to" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "cell_comments_sheet_row" ON "cell_comments" USING btree ("sheet_id","row_id");