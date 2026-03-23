-- Spam management system for collections
-- Handles automatic detection, manual reporting, and allowlisting

-- Add spam fields to collections table
ALTER TABLE collections 
ADD COLUMN is_spam BOOLEAN DEFAULT FALSE,
ADD COLUMN spam_score INTEGER DEFAULT 0 CHECK (spam_score >= 0 AND spam_score <= 100),
ADD COLUMN spam_reason TEXT,
ADD COLUMN spam_detected_at TIMESTAMP WITH TIME ZONE,
ADD COLUMN spam_detected_by TEXT CHECK (spam_detected_by IN ('alchemy', 'helius', 'manual', 'community'));

-- Track spam reports from users
CREATE TABLE spam_reports (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  collection_id UUID NOT NULL REFERENCES collections(id) ON DELETE CASCADE,
  reported_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  report_type TEXT NOT NULL CHECK (report_type IN ('spam', 'not_spam')),
  reason TEXT,
  notes TEXT,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_spam_reports_collection ON spam_reports(collection_id);
CREATE INDEX idx_spam_reports_type ON spam_reports(report_type, created_at DESC);

-- Track spam allowlist (verified legitimate projects flagged as spam)
CREATE TABLE spam_allowlist (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  collection_id UUID NOT NULL REFERENCES collections(id) ON DELETE CASCADE,
  added_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  reason TEXT NOT NULL,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  UNIQUE(collection_id)
);

CREATE INDEX idx_spam_allowlist_collection ON spam_allowlist(collection_id);

COMMENT ON COLUMN collections.is_spam IS 'Whether this collection is confirmed spam (manual or high-confidence automatic)';
COMMENT ON COLUMN collections.spam_score IS '0-100: likelihood of spam (0=clean, 100=definite spam)';
COMMENT ON COLUMN collections.spam_reason IS 'Why flagged: airdrop, phishing, free_mint, etc';
COMMENT ON COLUMN collections.spam_detected_by IS 'Source: alchemy (API flag), helius (API flag), manual (admin), community (reports)';

COMMENT ON TABLE spam_reports IS 'User reports of spam (or false positives)';
COMMENT ON TABLE spam_allowlist IS 'Collections marked as NOT spam despite automatic detection';
