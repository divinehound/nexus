-- NEXUS initial migration
-- Generated from Drizzle schema definitions

-- Enums
CREATE TYPE "collection_type" AS ENUM ('erc721', 'erc1155', 'spl');
CREATE TYPE "chain" AS ENUM ('ethereum', 'solana');
CREATE TYPE "user_role" AS ENUM ('user', 'admin');
CREATE TYPE "event_type" AS ENUM ('spaces', 'ama', 'mint', 'collab', 'irl', 'other');
CREATE TYPE "event_status" AS ENUM ('upcoming', 'live', 'ended');
CREATE TYPE "event_source" AS ENUM ('auto_twitter', 'manual', 'on_chain');
CREATE TYPE "activity_type" AS ENUM ('sale', 'notable_sale', 'whale_move', 'milestone', 'flex');
CREATE TYPE "wiki_suggestion_status" AS ENUM ('pending', 'approved', 'rejected');
CREATE TYPE "project_owner_role" AS ENUM ('owner', 'editor');

-- Projects & Collections
CREATE TABLE "projects" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "name" varchar(255) NOT NULL,
  "slug" varchar(255) NOT NULL UNIQUE,
  "description" text,
  "image_url" text,
  "banner_url" text,
  "website_url" text,
  "twitter_url" text,
  "twitter_id" varchar(255),
  "discord_url" text,
  "telegram_url" text,
  "deployer_addresses" text[] DEFAULT '{}',
  "health_score" integer,
  "cluster_id" uuid,
  "is_verified" boolean NOT NULL DEFAULT false,
  "created_at" timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE "collections" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "project_id" uuid NOT NULL REFERENCES "projects"("id") ON DELETE CASCADE,
  "contract_address" varchar(255) NOT NULL,
  "chain" "chain" NOT NULL,
  "name" varchar(255) NOT NULL,
  "image_url" text,
  "supply" integer,
  "mint_date" timestamptz,
  "floor_price" real,
  "holder_count" integer,
  "listed_count" integer,
  "collection_type" "collection_type" NOT NULL
);

-- Users & Wallets
CREATE TABLE "users" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "primary_wallet_id" uuid,
  "role" "user_role" NOT NULL DEFAULT 'user',
  "echo_score" integer,
  "cluster_ids" uuid[] DEFAULT '{}',
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "last_active_at" timestamptz
);

CREATE TABLE "wallets" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "address" varchar(255) NOT NULL,
  "chain" "chain" NOT NULL,
  "user_id" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "ens_name" varchar(255),
  "sns_name" varchar(255),
  "last_synced_at" timestamptz
);

CREATE TABLE "holders" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "wallet_address" varchar(255) NOT NULL,
  "collection_id" uuid NOT NULL,
  "chain" "chain" NOT NULL,
  "first_acquired_at" timestamptz NOT NULL DEFAULT now(),
  "quantity" integer NOT NULL DEFAULT 1,
  "is_current" boolean NOT NULL DEFAULT true
);

-- Events
CREATE TABLE "events" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "project_id" uuid NOT NULL REFERENCES "projects"("id") ON DELETE CASCADE,
  "title" varchar(500) NOT NULL,
  "description" text,
  "event_type" "event_type" NOT NULL,
  "start_time" timestamptz NOT NULL,
  "end_time" timestamptz,
  "link" text,
  "source" "event_source" NOT NULL,
  "twitter_space_id" varchar(255),
  "status" "event_status" NOT NULL DEFAULT 'upcoming',
  "submitted_by" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "created_at" timestamptz NOT NULL DEFAULT now()
);

-- Activity Feed
CREATE TABLE "activity_feed" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "project_id" uuid NOT NULL REFERENCES "projects"("id") ON DELETE CASCADE,
  "activity_type" "activity_type" NOT NULL,
  "wallet_address" varchar(255),
  "collection_id" uuid REFERENCES "collections"("id") ON DELETE SET NULL,
  "token_id" varchar(255),
  "price" real,
  "message" text,
  "image_url" text,
  "created_at" timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE "flex_reactions" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "activity_id" uuid NOT NULL REFERENCES "activity_feed"("id") ON DELETE CASCADE,
  "wallet_address" varchar(255) NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now()
);

-- Wiki
CREATE TABLE "project_wiki" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "project_id" uuid NOT NULL UNIQUE REFERENCES "projects"("id") ON DELETE CASCADE,
  "description_md" text,
  "auto_timeline" jsonb DEFAULT '[]',
  "last_edited_by" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "last_edited_at" timestamptz,
  "revision_number" integer NOT NULL DEFAULT 1
);

CREATE TABLE "wiki_suggestions" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "project_id" uuid NOT NULL REFERENCES "projects"("id") ON DELETE CASCADE,
  "submitted_by" uuid NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "field" text NOT NULL,
  "proposed_value" text NOT NULL,
  "status" "wiki_suggestion_status" NOT NULL DEFAULT 'pending',
  "created_at" timestamptz NOT NULL DEFAULT now()
);

-- Market
CREATE TABLE "market_snapshots" (
  "collection_id" uuid NOT NULL REFERENCES "collections"("id") ON DELETE CASCADE,
  "timestamp" timestamptz NOT NULL DEFAULT now(),
  "floor_price" real,
  "volume_24h" real,
  "holder_count" integer,
  "listed_count" integer
);

-- Ownership
CREATE TABLE "project_owners" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "project_id" uuid NOT NULL REFERENCES "projects"("id") ON DELETE CASCADE,
  "user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "role" "project_owner_role" NOT NULL DEFAULT 'editor',
  "assigned_at" timestamptz NOT NULL DEFAULT now()
);

-- Discovery / Affinity
CREATE TABLE "project_affinity" (
  "project_a_id" uuid NOT NULL,
  "project_b_id" uuid NOT NULL,
  "overlap_count" integer NOT NULL DEFAULT 0,
  "overlap_pct" real NOT NULL DEFAULT 0,
  "last_computed_at" timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE "collection_affinity" (
  "collection_a_id" uuid NOT NULL,
  "collection_b_id" uuid NOT NULL,
  "overlap_count" integer NOT NULL DEFAULT 0,
  "overlap_pct" real NOT NULL DEFAULT 0,
  "last_computed_at" timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE "wallet_affinity" (
  "wallet_a_id" uuid NOT NULL,
  "wallet_b_id" uuid NOT NULL,
  "shared_projects" integer NOT NULL DEFAULT 0,
  "affinity_score" real NOT NULL DEFAULT 0,
  "last_computed_at" timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE "clusters" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "name" varchar(255) NOT NULL,
  "color" varchar(7) NOT NULL,
  "project_count" integer NOT NULL DEFAULT 0,
  "holder_count" integer NOT NULL DEFAULT 0,
  "last_computed_at" timestamptz NOT NULL DEFAULT now()
);
