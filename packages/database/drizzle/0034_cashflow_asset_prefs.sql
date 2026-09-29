CREATE TABLE IF NOT EXISTS "cashflow_asset_prefs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
	"asset_key" varchar(300) NOT NULL,
	"pref" varchar(8) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "cashflow_asset_prefs_unique" ON "cashflow_asset_prefs" ("user_id", "asset_key");
