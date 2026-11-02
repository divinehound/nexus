-- Which wallets received each collection's tokens, written by the holder analysis sync as it
-- stores transfers. The sync picks the wallets it reads from here (for the collections of
-- projects that are turned on), instead of probing collection_transfers for every wallet.
CREATE TABLE IF NOT EXISTS "holder_analysis_wallets" (
  "collection_id" uuid NOT NULL REFERENCES "collections"("id") ON DELETE CASCADE,
  "chain" "chain" NOT NULL,
  "address" varchar(64) NOT NULL,
  PRIMARY KEY ("collection_id", "address")
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "holder_analysis_wallets_wallet_idx" ON "holder_analysis_wallets" ("chain", "address");
--> statement-breakpoint
INSERT INTO "holder_analysis_wallets" ("collection_id", "chain", "address")
SELECT DISTINCT "collection_id", "chain", "to_address" FROM "collection_transfers"
WHERE "to_address" NOT IN ('0x0000000000000000000000000000000000000000', '0x000000000000000000000000000000000000dead')
ON CONFLICT DO NOTHING;
--> statement-breakpoint
-- Wallets still to be read, found without scanning the table.
CREATE INDEX IF NOT EXISTS "wallet_profiles_info_pending_idx" ON "wallet_profiles" ("chain", "address") WHERE "info_at" IS NULL;
