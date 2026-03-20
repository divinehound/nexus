ALTER TABLE "wallet_indexing_jobs"
  ADD COLUMN IF NOT EXISTS "type" varchar(64) NOT NULL DEFAULT 'holdings_refresh',
  ADD COLUMN IF NOT EXISTS "retry_of_job_id" uuid;

CREATE INDEX IF NOT EXISTS "wallet_indexing_jobs_retry_of_idx"
  ON "wallet_indexing_jobs" ("retry_of_job_id");