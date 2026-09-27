CREATE TABLE IF NOT EXISTS "cashflow_tx_links" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
	"kind" varchar(16) NOT NULL,
	"from_chain" varchar(32) NOT NULL,
	"from_tx_hash" varchar(128) NOT NULL,
	"to_chain" varchar(32) NOT NULL,
	"to_tx_hash" varchar(128) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "cashflow_tx_links_unique" ON "cashflow_tx_links" ("user_id", "from_chain", "from_tx_hash", "to_chain", "to_tx_hash");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "cashflow_tx_links_user_id_idx" ON "cashflow_tx_links" ("user_id");--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "cashflow_address_tags" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
	"chain_family" varchar(16) NOT NULL,
	"address" varchar(255) NOT NULL,
	"exchange" varchar(64) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "cashflow_address_tags_unique" ON "cashflow_address_tags" ("user_id", "chain_family", "address");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "cashflow_address_tags_user_id_idx" ON "cashflow_address_tags" ("user_id");
