-- Collection metrics pipeline v1

ALTER TABLE "market_snapshots"
  ADD COLUMN IF NOT EXISTS "volume_1h" real,
  ADD COLUMN IF NOT EXISTS "volume_7d" real,
  ADD COLUMN IF NOT EXISTS "sales_24h" integer,
  ADD COLUMN IF NOT EXISTS "unique_buyers_24h" integer;

CREATE INDEX IF NOT EXISTS "market_snapshots_collection_time_idx"
  ON "market_snapshots" ("collection_id", "timestamp");
