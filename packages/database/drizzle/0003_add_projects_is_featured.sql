ALTER TABLE "projects"
ADD COLUMN IF NOT EXISTS "is_featured" boolean NOT NULL DEFAULT false;
