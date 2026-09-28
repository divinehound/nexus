CREATE TABLE IF NOT EXISTS "cashflow_scans" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
	"kind" varchar(16) NOT NULL,
	"chain" varchar(32) NOT NULL,
	"address" varchar(255) NOT NULL,
	"data" jsonb NOT NULL,
	"scanned_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "cashflow_scans_unique" ON "cashflow_scans" ("user_id", "kind", "chain", "address");--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "cashflow_scan_state" (
	"user_id" uuid PRIMARY KEY NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
	"status" varchar(16) NOT NULL,
	"progress" text,
	"error" text,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"heartbeat_at" timestamp with time zone DEFAULT now() NOT NULL,
	"data_version" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "cashflow_wallet_chains" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
	"address" varchar(255) NOT NULL,
	"chains" jsonb NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "cashflow_wallet_chains_unique" ON "cashflow_wallet_chains" ("user_id", "address");--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "cashflow_flags" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
	"chain" varchar(32) NOT NULL,
	"tx_hash" varchar(128) NOT NULL,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"reimported_at" timestamp with time zone
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "cashflow_flags_unique" ON "cashflow_flags" ("user_id", "chain", "tx_hash");
