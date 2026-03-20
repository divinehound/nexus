-- Wallet Holdings Tiering v1

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'tracking_tier') THEN
    CREATE TYPE "tracking_tier" AS ENUM ('active', 'lightweight', 'suppressed');
  END IF;
END $$;

ALTER TABLE "collections"
  ADD COLUMN IF NOT EXISTS "tracking_tier" "tracking_tier" NOT NULL DEFAULT 'lightweight',
  ADD COLUMN IF NOT EXISTS "quality_score" numeric(5, 2),
  ADD COLUMN IF NOT EXISTS "quality_reason" text;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'wallet_indexing_status') THEN
    CREATE TYPE "wallet_indexing_status" AS ENUM ('queued', 'running', 'completed', 'failed');
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS "wallet_holdings_snapshots" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "wallet_id" uuid NOT NULL REFERENCES "wallets"("id") ON DELETE CASCADE,
  "chain" "chain" NOT NULL,
  "contract_address" varchar(255) NOT NULL,
  "token_count" integer NOT NULL DEFAULT 0,
  "first_seen_at" timestamptz NOT NULL DEFAULT now(),
  "last_seen_at" timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS "wallet_holdings_wallet_contract_unique"
  ON "wallet_holdings_snapshots" ("wallet_id", "chain", "contract_address");

CREATE INDEX IF NOT EXISTS "wallet_holdings_user_wallet_idx"
  ON "wallet_holdings_snapshots" ("user_id", "wallet_id");

CREATE INDEX IF NOT EXISTS "wallet_holdings_contract_idx"
  ON "wallet_holdings_snapshots" ("chain", "contract_address");

CREATE TABLE IF NOT EXISTS "wallet_indexing_jobs" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "wallet_id" uuid NOT NULL REFERENCES "wallets"("id") ON DELETE CASCADE,
  "status" "wallet_indexing_status" NOT NULL DEFAULT 'queued',
  "started_at" timestamptz NOT NULL DEFAULT now(),
  "finished_at" timestamptz,
  "stats_json" jsonb,
  "error" text
);

CREATE INDEX IF NOT EXISTS "wallet_indexing_jobs_user_wallet_idx"
  ON "wallet_indexing_jobs" ("user_id", "wallet_id");

CREATE INDEX IF NOT EXISTS "wallet_indexing_jobs_wallet_status_idx"
  ON "wallet_indexing_jobs" ("wallet_id", "status");

CREATE INDEX IF NOT EXISTS "wallet_indexing_jobs_started_idx"
  ON "wallet_indexing_jobs" ("started_at");
