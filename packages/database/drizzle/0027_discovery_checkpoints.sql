CREATE TABLE IF NOT EXISTS "discovery_checkpoints" (
  "collection_id" uuid PRIMARY KEY REFERENCES "collections"("id") ON DELETE CASCADE,
  "holders_checked" integer DEFAULT 0 NOT NULL,
  "holder_cursor" text,
  "discovered_contracts" jsonb NOT NULL,
  "existing_contracts" jsonb NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
