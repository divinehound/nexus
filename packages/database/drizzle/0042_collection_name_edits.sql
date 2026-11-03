-- Set when an admin renames a collection, so metadata refreshes keep the admin's name.
ALTER TABLE "collections" ADD COLUMN IF NOT EXISTS "name_edited_at" timestamp with time zone;
