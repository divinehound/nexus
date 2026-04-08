CREATE TABLE IF NOT EXISTS "solana_indexed_mints" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"collection_id" uuid NOT NULL,
	"mint_address" varchar(64) NOT NULL,
	"current_owner" varchar(64),
	"sig_collection_status" varchar(16) DEFAULT 'pending' NOT NULL,
	"sig_count" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "solana_raw_signatures" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"collection_id" uuid NOT NULL,
	"mint_address" varchar(64) NOT NULL,
	"signature" varchar(128) NOT NULL,
	"parsed" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "solana_indexed_mints" ADD CONSTRAINT "solana_indexed_mints_collection_id_collections_id_fk" FOREIGN KEY ("collection_id") REFERENCES "public"."collections"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "solana_raw_signatures" ADD CONSTRAINT "solana_raw_signatures_collection_id_collections_id_fk" FOREIGN KEY ("collection_id") REFERENCES "public"."collections"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "solana_indexed_mints_unique" ON "solana_indexed_mints" USING btree ("collection_id","mint_address");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "solana_indexed_mints_status_idx" ON "solana_indexed_mints" USING btree ("collection_id","sig_collection_status");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "solana_raw_signatures_sig_unique" ON "solana_raw_signatures" USING btree ("signature");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "solana_raw_signatures_parsed_idx" ON "solana_raw_signatures" USING btree ("collection_id","parsed");
