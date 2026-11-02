-- Nexus collections are erc721 / erc1155 / spl; the holder analysis also follows ERC-20s
-- (e.g. a project's token). The setting overrides the collection's type when set.
ALTER TABLE "holder_analysis_collection_settings" ADD COLUMN IF NOT EXISTS "standard" varchar(8);
