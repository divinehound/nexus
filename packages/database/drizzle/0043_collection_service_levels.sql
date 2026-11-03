-- How often Nexus refreshes each collection's holders. Everything starts dormant
-- (nothing automatic), so turning this on spends no Alchemy calls until an admin
-- or the weekly check gives a collection a level.
DO $$ BEGIN
  CREATE TYPE "service_level" AS ENUM ('dormant', 'slow', 'active', 'hot', 'premium');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint
ALTER TABLE "collections" ADD COLUMN IF NOT EXISTS "service_level" "service_level" DEFAULT 'dormant' NOT NULL;
--> statement-breakpoint
ALTER TABLE "collections" ADD COLUMN IF NOT EXISTS "service_level_pinned" boolean DEFAULT false NOT NULL;
--> statement-breakpoint
ALTER TABLE "collections" ADD COLUMN IF NOT EXISTS "service_level_reason" text;
--> statement-breakpoint
ALTER TABLE "collections" ADD COLUMN IF NOT EXISTS "service_level_checked_at" timestamp with time zone;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "collections_service_level_idx" ON "collections" ("service_level") WHERE "service_level" <> 'dormant';
--> statement-breakpoint
-- Chains an admin has switched off (no row = on).
CREATE TABLE IF NOT EXISTS "chain_settings" (
  "chain" "chain" PRIMARY KEY NOT NULL,
  "enabled" boolean DEFAULT true NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
