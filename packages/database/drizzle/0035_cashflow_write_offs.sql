CREATE TABLE IF NOT EXISTS "cashflow_write_offs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
	"asset_key" varchar(300) NOT NULL,
	"token_id" varchar(200) DEFAULT '' NOT NULL,
	"lost_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "cashflow_write_offs_unique" ON "cashflow_write_offs" ("user_id", "asset_key", "token_id");
