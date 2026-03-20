CREATE TABLE IF NOT EXISTS "indexing_jobs" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "entity_type" varchar(32) NOT NULL,
  "entity_id" varchar(255) NOT NULL,
  "type" varchar(64) DEFAULT 'metrics_refresh' NOT NULL,
  "status" "wallet_indexing_status" DEFAULT 'queued' NOT NULL,
  "started_at" timestamp with time zone DEFAULT now() NOT NULL,
  "finished_at" timestamp with time zone,
  "triggered_by_user_id" uuid,
  "wallet_id" uuid,
  "retry_of_job_id" uuid,
  "stats_json" jsonb,
  "error" text
);

DO $$ BEGIN
  ALTER TABLE "indexing_jobs"
    ADD CONSTRAINT "indexing_jobs_triggered_by_user_id_users_id_fk"
    FOREIGN KEY ("triggered_by_user_id") REFERENCES "public"."users"("id")
    ON DELETE SET NULL ON UPDATE NO ACTION;
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
  ALTER TABLE "indexing_jobs"
    ADD CONSTRAINT "indexing_jobs_wallet_id_wallets_id_fk"
    FOREIGN KEY ("wallet_id") REFERENCES "public"."wallets"("id")
    ON DELETE SET NULL ON UPDATE NO ACTION;
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

CREATE INDEX IF NOT EXISTS "indexing_jobs_entity_idx" ON "indexing_jobs" ("entity_type", "entity_id");
CREATE INDEX IF NOT EXISTS "indexing_jobs_status_idx" ON "indexing_jobs" ("status");
CREATE INDEX IF NOT EXISTS "indexing_jobs_started_idx" ON "indexing_jobs" ("started_at");
CREATE INDEX IF NOT EXISTS "indexing_jobs_wallet_idx" ON "indexing_jobs" ("wallet_id");
CREATE INDEX IF NOT EXISTS "indexing_jobs_retry_of_idx" ON "indexing_jobs" ("retry_of_job_id");
