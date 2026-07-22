ALTER TABLE "collection_holder_balance_history" ADD COLUMN IF NOT EXISTS "price_native" real;--> statement-breakpoint
ALTER TABLE "collection_holder_balance_history" ADD COLUMN IF NOT EXISTS "price_usd" real;--> statement-breakpoint
ALTER TABLE "solana_parsed_transfers" ADD COLUMN IF NOT EXISTS "price_lamports" bigint;--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "collection_holder_pnl" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"collection_id" uuid NOT NULL,
	"chain" "chain" NOT NULL,
	"address" text NOT NULL,
	"native_symbol" varchar(16) NOT NULL,
	"buy_count" integer DEFAULT 0 NOT NULL,
	"sell_count" integer DEFAULT 0 NOT NULL,
	"realized_pnl_native" real DEFAULT 0 NOT NULL,
	"realized_pnl_usd" real DEFAULT 0 NOT NULL,
	"unrealized_pnl_native" real DEFAULT 0 NOT NULL,
	"unrealized_pnl_usd" real DEFAULT 0 NOT NULL,
	"total_bought_native" real DEFAULT 0 NOT NULL,
	"total_sold_native" real DEFAULT 0 NOT NULL,
	"cost_basis_remaining_native" real DEFAULT 0 NOT NULL,
	"avg_hold_time_seconds" bigint,
	"computed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "token_price_daily" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"symbol" varchar(16) NOT NULL,
	"date" date NOT NULL,
	"usd_price" real NOT NULL,
	"source" varchar(32) DEFAULT 'coingecko' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "collection_holder_pnl" ADD CONSTRAINT "collection_holder_pnl_collection_id_collections_id_fk" FOREIGN KEY ("collection_id") REFERENCES "public"."collections"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "collection_holder_pnl_unique" ON "collection_holder_pnl" USING btree ("collection_id","address");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "collection_holder_pnl_realized_idx" ON "collection_holder_pnl" USING btree ("collection_id","realized_pnl_native");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "token_price_daily_unique" ON "token_price_daily" USING btree ("symbol","date");
