-- Make activity_feed support collection-level activity
ALTER TABLE activity_feed ALTER COLUMN project_id DROP NOT NULL;

-- Add constraint: must have project_id OR collection_id
ALTER TABLE activity_feed ADD CONSTRAINT activity_feed_has_project_or_collection 
  CHECK (project_id IS NOT NULL OR collection_id IS NOT NULL);

-- Add index for collection activity lookups
CREATE INDEX IF NOT EXISTS idx_activity_feed_collection_id ON activity_feed(collection_id, created_at DESC);
