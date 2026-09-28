CREATE TABLE IF NOT EXISTS "cashflow_contact_labels" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
	"kind" varchar(8) NOT NULL,
	"scope" varchar(32) NOT NULL,
	"ref" varchar(255) NOT NULL,
	"label" varchar(100) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "cashflow_contact_labels_unique" ON "cashflow_contact_labels" ("user_id", "kind", "scope", "ref");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "cashflow_tx_notes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
	"chain" varchar(32) NOT NULL,
	"tx_hash" varchar(128) NOT NULL,
	"note" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "cashflow_tx_notes_unique" ON "cashflow_tx_notes" ("user_id", "chain", "tx_hash");
