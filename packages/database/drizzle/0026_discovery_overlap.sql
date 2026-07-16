ALTER TABLE "collections" ADD COLUMN IF NOT EXISTS "discovered_overlap_count" integer;
ALTER TABLE "collections" ADD COLUMN IF NOT EXISTS "discovered_from_collection_id" uuid REFERENCES "collections"("id") ON DELETE SET NULL;
