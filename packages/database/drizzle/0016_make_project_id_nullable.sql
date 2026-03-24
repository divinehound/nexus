-- Make project_id nullable to support unmapped collections
ALTER TABLE collections ALTER COLUMN project_id DROP NOT NULL;
