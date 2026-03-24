-- Add metadata fields to collections (social links, description)
ALTER TABLE collections ADD COLUMN IF NOT EXISTS description TEXT;
ALTER TABLE collections ADD COLUMN IF NOT EXISTS discord_url TEXT;
ALTER TABLE collections ADD COLUMN IF NOT EXISTS twitter_url TEXT;
ALTER TABLE collections ADD COLUMN IF NOT EXISTS website_url TEXT;
ALTER TABLE collections ADD COLUMN IF NOT EXISTS telegram_url TEXT;
ALTER TABLE collections ADD COLUMN IF NOT EXISTS external_url TEXT;

-- Enable pg_trgm extension for fuzzy text search (idempotent)
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- Add index for searching by name (fuzzy matching)
CREATE INDEX IF NOT EXISTS idx_collections_name_trgm ON collections USING gin (name gin_trgm_ops);
