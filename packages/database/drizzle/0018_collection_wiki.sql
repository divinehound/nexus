-- Collection-level wiki (parallel to project_wiki)
CREATE TABLE collection_wiki (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  collection_id UUID NOT NULL REFERENCES collections(id) ON DELETE CASCADE,
  content TEXT NOT NULL DEFAULT '',
  last_edited_by UUID REFERENCES users(id) ON DELETE SET NULL,
  last_edited_at TIMESTAMP WITH TIME ZONE DEFAULT NOW() NOT NULL,
  version INTEGER DEFAULT 1 NOT NULL,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW() NOT NULL,
  UNIQUE(collection_id)
);

-- Index for lookups
CREATE INDEX idx_collection_wiki_collection_id ON collection_wiki(collection_id);
CREATE INDEX idx_collection_wiki_last_edited_at ON collection_wiki(last_edited_at DESC);
