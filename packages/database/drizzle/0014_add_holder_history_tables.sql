-- Add historical tracking for collection holders
-- Enables community growth analytics, retention tracking, and timeline features

-- Track individual holder changes over time
CREATE TABLE collection_holder_history (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  collection_id UUID NOT NULL REFERENCES collections(id) ON DELETE CASCADE,
  address TEXT NOT NULL,
  token_count INTEGER NOT NULL,
  snapshot_date DATE NOT NULL,
  event_type TEXT CHECK (event_type IN ('join', 'increase', 'decrease', 'exit')),
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  CONSTRAINT collection_holder_history_unique UNIQUE (collection_id, address, snapshot_date)
);

CREATE INDEX idx_holder_history_collection ON collection_holder_history(collection_id, snapshot_date DESC);
CREATE INDEX idx_holder_history_address ON collection_holder_history(address);
CREATE INDEX idx_holder_history_event ON collection_holder_history(collection_id, event_type, snapshot_date);

COMMENT ON TABLE collection_holder_history IS 'Daily snapshots of holder token counts for historical analysis';
COMMENT ON COLUMN collection_holder_history.event_type IS 'Change type: join (new holder), increase (bought more), decrease (sold some), exit (sold all)';

-- Aggregate daily metrics per collection
CREATE TABLE collection_daily_metrics (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  collection_id UUID NOT NULL REFERENCES collections(id) ON DELETE CASCADE,
  metric_date DATE NOT NULL,
  holder_count INTEGER NOT NULL DEFAULT 0,
  new_holders INTEGER NOT NULL DEFAULT 0,
  exited_holders INTEGER NOT NULL DEFAULT 0,
  total_tokens_held INTEGER NOT NULL DEFAULT 0,
  avg_tokens_per_holder NUMERIC(10,2),
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  CONSTRAINT collection_daily_metrics_unique UNIQUE (collection_id, metric_date)
);

CREATE INDEX idx_daily_metrics_collection ON collection_daily_metrics(collection_id, metric_date DESC);

COMMENT ON TABLE collection_daily_metrics IS 'Daily aggregate metrics for collection holder analytics';
COMMENT ON COLUMN collection_daily_metrics.new_holders IS 'Number of addresses that joined this day (first token received)';
COMMENT ON COLUMN collection_daily_metrics.exited_holders IS 'Number of addresses that exited this day (sold all tokens)';
