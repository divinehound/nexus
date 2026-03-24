-- Create table for full collection holder data (no userId requirement)
-- This allows us to index ALL holders from on-chain data regardless of NEXUS accounts

CREATE TABLE IF NOT EXISTS collection_holders (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  collection_id UUID NOT NULL REFERENCES collections(id) ON DELETE CASCADE,
  chain TEXT NOT NULL CHECK (chain IN ('ethereum', 'base', 'abstract', 'apechain', 'polygon', 'solana')),
  address TEXT NOT NULL,
  token_count INTEGER NOT NULL DEFAULT 1,
  first_seen_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  last_seen_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  CONSTRAINT collection_holders_unique UNIQUE (collection_id, address)
);

CREATE INDEX IF NOT EXISTS idx_collection_holders_collection ON collection_holders(collection_id);
CREATE INDEX IF NOT EXISTS idx_collection_holders_address ON collection_holders(address);

COMMENT ON TABLE collection_holders IS 'Full holder data for collections indexed from blockchain, independent of NEXUS user accounts';
COMMENT ON COLUMN collection_holders.collection_id IS 'References the collection';
COMMENT ON COLUMN collection_holders.address IS 'Wallet address (lowercased)';
COMMENT ON COLUMN collection_holders.token_count IS 'Number of tokens held by this address';
