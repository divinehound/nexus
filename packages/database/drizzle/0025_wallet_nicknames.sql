CREATE TABLE IF NOT EXISTS "wallet_nicknames" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "address" varchar(255) NOT NULL,
  "nickname" varchar(100) NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS "wallet_nicknames_user_address_unique" ON "wallet_nicknames" ("user_id", "address");
CREATE INDEX IF NOT EXISTS "wallet_nicknames_user_id_idx" ON "wallet_nicknames" ("user_id");
