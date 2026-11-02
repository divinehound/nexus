-- Holder analysis, ported from spooky-bar apps/holder-analysis (plan: merge holder analysis into
-- Nexus, 2026-11-02). Opt-in per project; only enabled projects' collections are synced.

ALTER TABLE "projects" ADD COLUMN IF NOT EXISTS "holder_analysis_enabled" boolean DEFAULT false NOT NULL;
--> statement-breakpoint

-- One row per token moved. Hash-partitioned by collection: reads are one collection's transfers in
-- order, or one wallet's, so a collection's rows stay in one partition.
CREATE TABLE IF NOT EXISTS "collection_transfers" (
	"collection_id" uuid NOT NULL REFERENCES "collections"("id") ON DELETE CASCADE,
	"chain" "chain" NOT NULL,
	"block_number" bigint NOT NULL,
	"log_index" integer NOT NULL,
	"block_time" timestamp with time zone NOT NULL,
	"tx_hash" varchar(128) NOT NULL,
	"from_address" varchar(64) NOT NULL,
	"to_address" varchar(64) NOT NULL,
	"token_id" varchar(128) DEFAULT '' NOT NULL,
	"amount" double precision NOT NULL,
	"tx_from" varchar(64),
	"tx_to" varchar(64),
	"tx_value_wei" numeric(78, 0),
	"need_tx" boolean DEFAULT false NOT NULL,
	PRIMARY KEY ("collection_id", "tx_hash", "log_index", "token_id")
) PARTITION BY HASH ("collection_id");
--> statement-breakpoint
DO $$
BEGIN
	FOR i IN 0..15 LOOP
		EXECUTE format(
			'CREATE TABLE IF NOT EXISTS %I PARTITION OF "collection_transfers" FOR VALUES WITH (MODULUS 16, REMAINDER %s)',
			'collection_transfers_p' || i, i
		);
	END LOOP;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "collection_transfers_order_idx" ON "collection_transfers" ("collection_id", "block_number", "log_index");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "collection_transfers_from_idx" ON "collection_transfers" ("from_address");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "collection_transfers_to_idx" ON "collection_transfers" ("to_address");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "collection_transfers_tx_idx" ON "collection_transfers" ("tx_hash");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "collection_transfers_need_tx_idx" ON "collection_transfers" ("collection_id") WHERE "need_tx";
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "collection_transfer_sync" (
	"collection_id" uuid PRIMARY KEY NOT NULL REFERENCES "collections"("id") ON DELETE CASCADE,
	"last_block" bigint DEFAULT 0 NOT NULL,
	"live" boolean DEFAULT false NOT NULL,
	"synced_at" timestamp with time zone,
	"error" text,
	"error_at" timestamp with time zone
);
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "holder_analysis_collection_settings" (
	"collection_id" uuid PRIMARY KEY NOT NULL REFERENCES "collections"("id") ON DELETE CASCADE,
	"short_id" varchar(16) NOT NULL,
	"core" boolean DEFAULT true NOT NULL,
	"decimals" integer DEFAULT 0 NOT NULL,
	"staking_contracts" text[] DEFAULT '{}'::text[] NOT NULL,
	"token_names" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "wallet_profiles" (
	"chain" "chain" NOT NULL,
	"address" varchar(64) NOT NULL,
	"is_contract" boolean,
	"funder" varchar(64),
	"funded_at" timestamp with time zone,
	"last_out_at" timestamp with time zone,
	"info_at" timestamp with time zone,
	"delegations" jsonb,
	"delegations_at" timestamp with time zone,
	"ens" varchar(255),
	"opensea" varchar(255),
	"names_at" timestamp with time zone,
	PRIMARY KEY ("chain", "address")
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "wallet_profiles_funder_idx" ON "wallet_profiles" ("chain", "funder");
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "holder_usage" (
	"project_id" uuid NOT NULL REFERENCES "projects"("id") ON DELETE CASCADE,
	"address" varchar(64) NOT NULL,
	"data" jsonb NOT NULL,
	"fetched_at" timestamp with time zone DEFAULT now() NOT NULL,
	PRIMARY KEY ("project_id", "address")
);
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "holder_reports" (
	"project_id" uuid PRIMARY KEY NOT NULL REFERENCES "projects"("id") ON DELETE CASCADE,
	"summary" jsonb NOT NULL,
	"analysis_version" integer NOT NULL,
	"block" bigint,
	"duration_ms" integer,
	"analysed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "holder_report_holders" (
	"project_id" uuid NOT NULL REFERENCES "projects"("id") ON DELETE CASCADE,
	"address" varchar(64) NOT NULL,
	"rank" integer NOT NULL,
	"first_at" timestamp with time zone,
	"data" jsonb NOT NULL,
	PRIMARY KEY ("project_id", "address")
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "holder_report_holders_rank_idx" ON "holder_report_holders" ("project_id", "rank");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "holder_report_holders_address_idx" ON "holder_report_holders" ("address");
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "holder_report_side_holders" (
	"project_id" uuid NOT NULL REFERENCES "projects"("id") ON DELETE CASCADE,
	"collection_id" uuid NOT NULL REFERENCES "collections"("id") ON DELETE CASCADE,
	"address" varchar(64) NOT NULL,
	"rank" integer NOT NULL,
	"data" jsonb NOT NULL,
	PRIMARY KEY ("project_id", "collection_id", "address")
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "holder_report_side_holders_rank_idx" ON "holder_report_side_holders" ("project_id", "collection_id", "rank");
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "holder_wallet_groups" (
	"project_id" uuid NOT NULL REFERENCES "projects"("id") ON DELETE CASCADE,
	"rank" integer NOT NULL,
	"data" jsonb NOT NULL,
	PRIMARY KEY ("project_id", "rank")
);
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "holder_wallet_links" (
	"project_id" uuid NOT NULL REFERENCES "projects"("id") ON DELETE CASCADE,
	"a" varchar(64) NOT NULL,
	"b" varchar(64) NOT NULL,
	"score" real NOT NULL,
	"evidence" text NOT NULL,
	PRIMARY KEY ("project_id", "a", "b")
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "holder_wallet_links_b_idx" ON "holder_wallet_links" ("project_id", "b");
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "holder_activity" (
	"project_id" uuid NOT NULL REFERENCES "projects"("id") ON DELETE CASCADE,
	"at" timestamp with time zone NOT NULL,
	"collection_id" uuid NOT NULL REFERENCES "collections"("id") ON DELETE CASCADE,
	"address" varchar(64) NOT NULL,
	"kind" varchar(16) NOT NULL,
	"amount" double precision NOT NULL,
	"tx_hash" varchar(128) NOT NULL,
	"eth" double precision DEFAULT 0 NOT NULL,
	"flag" varchar(16) DEFAULT '' NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "holder_activity_at_idx" ON "holder_activity" ("project_id", "at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "holder_activity_address_idx" ON "holder_activity" ("project_id", "address");
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "holder_wallet_labels" (
	"project_id" uuid NOT NULL REFERENCES "projects"("id") ON DELETE CASCADE,
	"address" varchar(64) NOT NULL,
	"label" varchar(100) DEFAULT '' NOT NULL,
	"note" text DEFAULT '' NOT NULL,
	"updated_by" uuid REFERENCES "users"("id") ON DELETE SET NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	PRIMARY KEY ("project_id", "address")
);
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "holder_wallet_unlinks" (
	"project_id" uuid NOT NULL REFERENCES "projects"("id") ON DELETE CASCADE,
	"a" varchar(64) NOT NULL,
	"b" varchar(64) NOT NULL,
	"created_by" uuid REFERENCES "users"("id") ON DELETE SET NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	PRIMARY KEY ("project_id", "a", "b")
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "holder_wallet_unlinks_b_idx" ON "holder_wallet_unlinks" ("project_id", "b");
