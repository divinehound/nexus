import {
  pgTable,
  uuid,
  varchar,
  text,
  boolean,
  integer,
  real,
  timestamp,
  pgEnum,
  numeric,
  uniqueIndex,
} from 'drizzle-orm/pg-core';

export const collectionTypeEnum = pgEnum('collection_type', [
  'erc721',
  'erc1155',
  'spl',
]);

export const chainEnum = pgEnum('chain', [
  'ethereum',
  'base',
  'abstract',
  'apechain',
  'polygon',
  'solana',
]);

export const verificationStatusEnum = pgEnum('verification_status', [
  'tracked_unverified',
  'pending_claim',
  'verified',
  'rejected',
]);

export const mappingStatusEnum = pgEnum('mapping_status', [
  'unmapped',
  'suggested',
  'mapped',
  'rejected',
]);

export const intakeSourceEnum = pgEnum('collection_intake_source', [
  'search',
  'manual',
  'subagent',
  'api',
]);

export const intakeStatusEnum = pgEnum('collection_intake_status', [
  'queued',
  'ingested',
  'failed',
]);

export const trackingTierEnum = pgEnum('tracking_tier', [
  'active',
  'lightweight',
  'suppressed',
]);

export const indexStatusEnum = pgEnum('index_status', [
  'nexus_only',
  'sampled',
  'full',
]);

export const projects = pgTable('projects', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: varchar('name', { length: 255 }).notNull(),
  slug: varchar('slug', { length: 255 }).notNull().unique(),
  description: text('description'),
  imageUrl: text('image_url'),
  bannerUrl: text('banner_url'),
  websiteUrl: text('website_url'),
  twitterUrl: text('twitter_url'),
  twitterId: varchar('twitter_id', { length: 255 }),
  discordUrl: text('discord_url'),
  telegramUrl: text('telegram_url'),
  deployerAddresses: text('deployer_addresses').array().default([]),
  healthScore: integer('health_score'),
  clusterId: uuid('cluster_id'),
  isVerified: boolean('is_verified').default(false).notNull(),
  isFeatured: boolean('is_featured').default(false).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  lastIndexStartedAt: timestamp('last_index_started_at', { withTimezone: true }),
  lastIndexFinishedAt: timestamp('last_index_finished_at', { withTimezone: true }),
  lastIndexStatus: varchar('last_index_status', { length: 16 }),
  lastIndexError: text('last_index_error'),
  lastIndexJobId: varchar('last_index_job_id', { length: 64 }),
});

export const collections = pgTable(
  'collections',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    contractAddress: varchar('contract_address', { length: 255 }).notNull(),
    chain: chainEnum('chain').notNull(),
    name: varchar('name', { length: 255 }).notNull(),
    imageUrl: text('image_url'),
    supply: integer('supply'),
    mintDate: timestamp('mint_date', { withTimezone: true }),
    floorPrice: real('floor_price'),
    holderCount: integer('holder_count'),
    listedCount: integer('listed_count'),
    collectionType: collectionTypeEnum('collection_type').notNull(),
    verificationStatus: verificationStatusEnum('verification_status')
      .default('tracked_unverified')
      .notNull(),
    mappingStatus: mappingStatusEnum('mapping_status').default('unmapped').notNull(),
    proposedProjectId: uuid('proposed_project_id').references(() => projects.id, {
      onDelete: 'set null',
    }),
    mappingConfidence: numeric('mapping_confidence', { precision: 4, scale: 3 }),
    verificationNotes: text('verification_notes'),
    trackingTier: trackingTierEnum('tracking_tier').default('lightweight').notNull(),
    indexStatus: indexStatusEnum('index_status').default('nexus_only').notNull(),
    qualityScore: numeric('quality_score', { precision: 5, scale: 2 }),
    qualityReason: text('quality_reason'),
    firstSeenAt: timestamp('first_seen_at', { withTimezone: true }).defaultNow().notNull(),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).defaultNow().notNull(),
    lastIndexStartedAt: timestamp('last_index_started_at', { withTimezone: true }),
    lastIndexFinishedAt: timestamp('last_index_finished_at', { withTimezone: true }),
    lastIndexStatus: varchar('last_index_status', { length: 16 }),
    lastIndexError: text('last_index_error'),
    lastIndexJobId: varchar('last_index_job_id', { length: 64 }),
  },
  (table) => [
    uniqueIndex('collections_chain_contract_unique').on(
      table.chain,
      table.contractAddress,
    ),
  ],
);

export const collectionIntakeRequests = pgTable('collection_intake_requests', {
  id: uuid('id').primaryKey().defaultRandom(),
  chain: chainEnum('chain').notNull(),
  contractAddress: varchar('contract_address', { length: 255 }).notNull(),
  requestedByUserId: uuid('requested_by_user_id'),
  source: intakeSourceEnum('source').notNull(),
  status: intakeStatusEnum('status').default('queued').notNull(),
  errorMessage: text('error_message'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  processedAt: timestamp('processed_at', { withTimezone: true }),
});
