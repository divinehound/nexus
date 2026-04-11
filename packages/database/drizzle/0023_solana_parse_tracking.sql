ALTER TABLE "solana_raw_signatures" ADD COLUMN "block_time" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "solana_raw_signatures" ADD COLUMN "slot" bigint;
--> statement-breakpoint
ALTER TABLE "solana_raw_signatures" ADD COLUMN "parse_status" varchar(16) DEFAULT 'pending' NOT NULL;
--> statement-breakpoint
ALTER TABLE "solana_raw_signatures" ADD COLUMN "raw_data" jsonb;
--> statement-breakpoint
ALTER TABLE "solana_raw_signatures" ADD COLUMN "transfers_found" integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE "solana_raw_signatures" ADD COLUMN "last_parsed_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "solana_raw_signatures" ADD COLUMN "error_message" text;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "solana_raw_signatures_parse_status_idx" ON "solana_raw_signatures" USING btree ("collection_id","parse_status");
--> statement-breakpoint
ALTER TABLE "solana_indexed_mints" ADD COLUMN "reconciliation_status" varchar(16) DEFAULT 'pending' NOT NULL;
--> statement-breakpoint
ALTER TABLE "solana_indexed_mints" ADD COLUMN "reconciliation_note" text;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "solana_parsed_transfers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"collection_id" uuid NOT NULL,
	"signature" varchar(128) NOT NULL,
	"mint_address" varchar(64) NOT NULL,
	"from_wallet" varchar(64),
	"to_wallet" varchar(64),
	"block_time" timestamp with time zone NOT NULL,
	"slot" bigint NOT NULL,
	"parser_name" varchar(64) NOT NULL,
	"program_id" varchar(64),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "solana_parsed_transfers" ADD CONSTRAINT "solana_parsed_transfers_collection_id_collections_id_fk" FOREIGN KEY ("collection_id") REFERENCES "public"."collections"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "solana_parsed_transfers_unique" ON "solana_parsed_transfers" USING btree ("signature","mint_address","from_wallet","to_wallet","parser_name");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "solana_parsed_transfers_collection_time_idx" ON "solana_parsed_transfers" USING btree ("collection_id","block_time","slot");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "solana_parsed_transfers_mint_idx" ON "solana_parsed_transfers" USING btree ("collection_id","mint_address","block_time");
