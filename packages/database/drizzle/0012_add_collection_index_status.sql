-- Add index_status to collections table to track data completeness
-- This tells us whether holder data is from NEXUS users only, sampled, or fully indexed

ALTER TABLE collections 
ADD COLUMN index_status TEXT DEFAULT 'nexus_only' CHECK (index_status IN ('nexus_only', 'sampled', 'full'));

COMMENT ON COLUMN collections.index_status IS 'Data completeness: nexus_only (only signed-in users), sampled (partial holders), full (all holders indexed)';

-- Update existing verified collections to mark for full indexing
UPDATE collections 
SET index_status = 'nexus_only'
WHERE index_status IS NULL;
