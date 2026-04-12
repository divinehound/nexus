ALTER TABLE "solana_parsed_transfers" ADD COLUMN "instruction_order" integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
DROP INDEX IF EXISTS "solana_parsed_transfers_collection_time_idx";
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "solana_parsed_transfers_collection_time_idx" ON "solana_parsed_transfers" USING btree ("collection_id","block_time","slot","instruction_order");
