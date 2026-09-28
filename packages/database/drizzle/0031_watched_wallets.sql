CREATE TABLE IF NOT EXISTS "watched_wallets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
	"family" varchar(16) NOT NULL,
	"address" varchar(255) NOT NULL,
	"label" varchar(100),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "watched_wallets_user_address_unique" ON "watched_wallets" ("user_id", "family", "address");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "watched_wallets_address_idx" ON "watched_wallets" ("family", "address");
