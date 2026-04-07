-- Add admin holder history scan checkpoint fields and detailed per-transfer history

DO $$ BEGIN
  CREATE TYPE holder_transfer_direction AS ENUM ('in', 'out');
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

ALTER TABLE collections
  ADD COLUMN IF NOT EXISTS holder_history_last_checked_block BIGINT,
  ADD COLUMN IF NOT EXISTS holder_history_last_scanned_at TIMESTAMP WITH TIME ZONE;

CREATE TABLE IF NOT EXISTS collection_holder_summaries (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  collection_id UUID NOT NULL REFERENCES collections(id) ON DELETE CASCADE,
  chain chain NOT NULL,
  address TEXT NOT NULL,
  current_balance INTEGER NOT NULL DEFAULT 0,
  first_received_at TIMESTAMP WITH TIME ZONE,
  first_received_block BIGINT,
  last_received_at TIMESTAMP WITH TIME ZONE,
  last_received_block BIGINT,
  total_received_count INTEGER NOT NULL DEFAULT 0,
  total_sent_count INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  CONSTRAINT collection_holder_summaries_unique UNIQUE (collection_id, address)
);

CREATE INDEX IF NOT EXISTS idx_collection_holder_summaries_balance
  ON collection_holder_summaries(collection_id, current_balance DESC, address);

CREATE TABLE IF NOT EXISTS collection_holder_balance_history (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  collection_id UUID NOT NULL REFERENCES collections(id) ON DELETE CASCADE,
  chain chain NOT NULL,
  address TEXT NOT NULL,
  block_number BIGINT NOT NULL,
  block_timestamp TIMESTAMP WITH TIME ZONE NOT NULL,
  transaction_hash VARCHAR(255) NOT NULL,
  log_index INTEGER NOT NULL,
  token_id VARCHAR(255) NOT NULL,
  direction holder_transfer_direction NOT NULL,
  balance_after INTEGER NOT NULL,
  counterparty_address TEXT,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  CONSTRAINT collection_holder_balance_history_unique UNIQUE (collection_id, transaction_hash, log_index, address)
);

CREATE INDEX IF NOT EXISTS idx_collection_holder_balance_history_wallet
  ON collection_holder_balance_history(collection_id, address, block_number ASC, log_index ASC);
