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
import { users } from './users';

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

export const holderEventTypeEnum = pgEnum('holder_event_type', [
  'join',
  'increase',
  'decrease',
  'exit',
]);

export const spamDetectedByEnum = pgEnum('spam_detected_by', [
  'alchemy',
  'helius',
  'manual',
  'community',
]);

export const spamReportTypeEnum = pgEnum('spam_report_type', [
  'spam',
  'not_spam',
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
    isSpam: boolean('is_spam').default(false),
    spamScore: integer('spam_score').default(0),
    spamReason: text('spam_reason'),
    spamDetectedAt: timestamp('spam_detected_at', { withTimezone: true }),
    spamDetectedBy: spamDetectedByEnum('spam_detected_by'),
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

export const collectionHolders = pgTable(
  'collection_holders',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    collectionId: uuid('collection_id')
      .notNull()
      .references(() => collections.id, { onDelete: 'cascade' }),
    chain: chainEnum('chain').notNull(),
    address: text('address').notNull(),
    tokenCount: integer('token_count').default(1).notNull(),
    firstSeenAt: timestamp('first_seen_at', { withTimezone: true }).defaultNow().notNull(),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex('collection_holders_unique').on(table.collectionId, table.address),
  ],
);

export const collectionHolderHistory = pgTable(
  'collection_holder_history',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    collectionId: uuid('collection_id')
      .notNull()
      .references(() => collections.id, { onDelete: 'cascade' }),
    address: text('address').notNull(),
    tokenCount: integer('token_count').notNull(),
    snapshotDate: timestamp('snapshot_date', { withTimezone: false, mode: 'date' }).notNull(),
    eventType: holderEventTypeEnum('event_type'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex('collection_holder_history_unique').on(
      table.collectionId,
      table.address,
      table.snapshotDate,
    ),
  ],
);

export const collectionDailyMetrics = pgTable(
  'collection_daily_metrics',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    collectionId: uuid('collection_id')
      .notNull()
      .references(() => collections.id, { onDelete: 'cascade' }),
    metricDate: timestamp('metric_date', { withTimezone: false, mode: 'date' }).notNull(),
    holderCount: integer('holder_count').default(0).notNull(),
    newHolders: integer('new_holders').default(0).notNull(),
    exitedHolders: integer('exited_holders').default(0).notNull(),
    totalTokensHeld: integer('total_tokens_held').default(0).notNull(),
    avgTokensPerHolder: numeric('avg_tokens_per_holder', { precision: 10, scale: 2 }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex('collection_daily_metrics_unique').on(table.collectionId, table.metricDate),
  ],
);

export const spamReports = pgTable('spam_reports', {
  id: uuid('id').primaryKey().defaultRandom(),
  collectionId: uuid('collection_id')
    .notNull()
    .references(() => collections.id, { onDelete: 'cascade' }),
  reportedByUserId: uuid('reported_by_user_id').references(() => users.id, { onDelete: 'set null' }),
  reportType: spamReportTypeEnum('report_type').notNull(),
  reason: text('reason'),
  notes: text('notes'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
});

export const spamAllowlist = pgTable('spam_allowlist', {
  id: uuid('id').primaryKey().defaultRandom(),
  collectionId: uuid('collection_id')
    .notNull()
    .references(() => collections.id, { onDelete: 'cascade' }),
  addedByUserId: uuid('added_by_user_id').references(() => users.id, { onDelete: 'set null' }),
  reason: text('reason').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
}, (table) => [
  uniqueIndex('spam_allowlist_collection_unique').on(table.collectionId),
]);

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
