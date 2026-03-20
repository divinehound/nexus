-- User Identity v1

ALTER TABLE "users"
  ADD COLUMN IF NOT EXISTS "display_name" varchar(255),
  ADD COLUMN IF NOT EXISTS "avatar_url" text,
  ADD COLUMN IF NOT EXISTS "bio" text;

ALTER TABLE "wallets"
  ADD COLUMN IF NOT EXISTS "is_primary" boolean NOT NULL DEFAULT false;

UPDATE "wallets"
SET "is_primary" = true
WHERE "id" IN (
  SELECT "primary_wallet_id" FROM "users" WHERE "primary_wallet_id" IS NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS "wallets_chain_address_unique"
  ON "wallets" ("chain", "address");

CREATE INDEX IF NOT EXISTS "wallets_user_id_idx"
  ON "wallets" ("user_id");

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'wallet_challenge_purpose') THEN
    CREATE TYPE "wallet_challenge_purpose" AS ENUM ('link_wallet', 'move_wallet');
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS "wallet_link_challenges" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "chain" "chain" NOT NULL,
  "address" varchar(255) NOT NULL,
  "purpose" "wallet_challenge_purpose" NOT NULL,
  "nonce" varchar(255) NOT NULL,
  "message" text NOT NULL,
  "expires_at" timestamptz NOT NULL,
  "used_at" timestamptz,
  "created_at" timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "wallet_link_challenges_lookup_idx"
  ON "wallet_link_challenges" ("user_id", "chain", "address");

CREATE TABLE IF NOT EXISTS "wallet_move_confirmations" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "wallet_id" uuid NOT NULL REFERENCES "wallets"("id") ON DELETE CASCADE,
  "from_user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "to_user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "chain" "chain" NOT NULL,
  "address" varchar(255) NOT NULL,
  "token" varchar(255) NOT NULL UNIQUE,
  "expires_at" timestamptz NOT NULL,
  "used_at" timestamptz,
  "created_at" timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "wallet_move_confirmations_lookup_idx"
  ON "wallet_move_confirmations" ("to_user_id", "chain", "address");

CREATE TABLE IF NOT EXISTS "wallet_ownership_moves" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "wallet_id" uuid NOT NULL REFERENCES "wallets"("id") ON DELETE CASCADE,
  "from_user_id" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "to_user_id" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "chain" "chain" NOT NULL,
  "address" varchar(255) NOT NULL,
  "reason" varchar(255),
  "moved_at" timestamptz NOT NULL DEFAULT now()
);
