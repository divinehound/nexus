-- Collection intake + unverified tracking

CREATE TYPE "verification_status" AS ENUM (
  'tracked_unverified',
  'pending_claim',
  'verified',
  'rejected'
);

CREATE TYPE "mapping_status" AS ENUM (
  'unmapped',
  'suggested',
  'mapped',
  'rejected'
);

CREATE TYPE "collection_intake_source" AS ENUM (
  'search',
  'manual',
  'subagent',
  'api'
);

CREATE TYPE "collection_intake_status" AS ENUM (
  'queued',
  'ingested',
  'failed'
);

ALTER TABLE "collections"
  ADD COLUMN "verification_status" "verification_status" NOT NULL DEFAULT 'tracked_unverified',
  ADD COLUMN "mapping_status" "mapping_status" NOT NULL DEFAULT 'unmapped',
  ADD COLUMN "proposed_project_id" uuid REFERENCES "projects"("id") ON DELETE SET NULL,
  ADD COLUMN "mapping_confidence" numeric(4, 3),
  ADD COLUMN "verification_notes" text,
  ADD COLUMN "first_seen_at" timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN "last_seen_at" timestamptz NOT NULL DEFAULT now();

CREATE UNIQUE INDEX "collections_chain_contract_unique"
  ON "collections" ("chain", "contract_address");

CREATE TABLE "collection_intake_requests" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "chain" "chain" NOT NULL,
  "contract_address" varchar(255) NOT NULL,
  "requested_by_user_id" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "source" "collection_intake_source" NOT NULL,
  "status" "collection_intake_status" NOT NULL DEFAULT 'queued',
  "error_message" text,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "processed_at" timestamptz
);
