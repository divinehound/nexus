ALTER TABLE "wallets"
  ADD COLUMN IF NOT EXISTS "last_index_started_at" timestamp with time zone,
  ADD COLUMN IF NOT EXISTS "last_index_finished_at" timestamp with time zone,
  ADD COLUMN IF NOT EXISTS "last_index_status" varchar(16),
  ADD COLUMN IF NOT EXISTS "last_index_error" text,
  ADD COLUMN IF NOT EXISTS "last_index_job_id" varchar(64);

ALTER TABLE "collections"
  ADD COLUMN IF NOT EXISTS "last_index_started_at" timestamp with time zone,
  ADD COLUMN IF NOT EXISTS "last_index_finished_at" timestamp with time zone,
  ADD COLUMN IF NOT EXISTS "last_index_status" varchar(16),
  ADD COLUMN IF NOT EXISTS "last_index_error" text,
  ADD COLUMN IF NOT EXISTS "last_index_job_id" varchar(64);

ALTER TABLE "projects"
  ADD COLUMN IF NOT EXISTS "last_index_started_at" timestamp with time zone,
  ADD COLUMN IF NOT EXISTS "last_index_finished_at" timestamp with time zone,
  ADD COLUMN IF NOT EXISTS "last_index_status" varchar(16),
  ADD COLUMN IF NOT EXISTS "last_index_error" text,
  ADD COLUMN IF NOT EXISTS "last_index_job_id" varchar(64);
