CREATE TABLE IF NOT EXISTS "cashflow_lost_txs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
	"chain" varchar(32) NOT NULL,
	"tx_hash" varchar(128) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "cashflow_lost_txs_unique" ON "cashflow_lost_txs" ("user_id", "chain", "tx_hash");
