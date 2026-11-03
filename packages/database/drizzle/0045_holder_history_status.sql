-- Holder history scans get their own status, so they no longer write over the holder snapshot's last_index_* fields.
ALTER TABLE "collections" ADD COLUMN IF NOT EXISTS "holder_history_status" varchar(16);
--> statement-breakpoint
ALTER TABLE "collections" ADD COLUMN IF NOT EXISTS "holder_history_error" text;
--> statement-breakpoint
ALTER TABLE "collections" ADD COLUMN IF NOT EXISTS "holder_history_failures" integer DEFAULT 0 NOT NULL;
