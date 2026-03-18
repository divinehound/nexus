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
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
});

export const collections = pgTable('collections', {
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
});
