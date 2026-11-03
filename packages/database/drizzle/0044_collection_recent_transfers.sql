-- What the weekly service level check saw: transfers in the last 30 days (capped at 1,000) and the newest one.
ALTER TABLE "collections" ADD COLUMN IF NOT EXISTS "recent_transfers" integer;
--> statement-breakpoint
ALTER TABLE "collections" ADD COLUMN IF NOT EXISTS "last_transfer_at" timestamp with time zone;
