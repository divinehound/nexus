-- Add metadata fields to collections (social links, description)
ALTER TABLE collections ADD COLUMN description TEXT;
ALTER TABLE collections ADD COLUMN discord_url TEXT;
ALTER TABLE collections ADD COLUMN twitter_url TEXT;
ALTER TABLE collections ADD COLUMN website_url TEXT;
ALTER TABLE collections ADD COLUMN telegram_url TEXT;
ALTER TABLE collections ADD COLUMN external_url TEXT;

-- Add index for searching by name
CREATE INDEX IF NOT EXISTS idx_collections_name_trgm ON collections USING gin (name gin_trgm_ops);
