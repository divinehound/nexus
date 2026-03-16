import {
  pgTable,
  uuid,
  varchar,
  text,
  real,
  timestamp,
  pgEnum,
} from 'drizzle-orm/pg-core';
import { projects } from './projects';
import { collections } from './projects';

export const activityTypeEnum = pgEnum('activity_type', [
  'sale',
  'notable_sale',
  'whale_move',
  'milestone',
  'flex',
]);

export const activityFeed = pgTable('activity_feed', {
  id: uuid('id').primaryKey().defaultRandom(),
  projectId: uuid('project_id')
    .notNull()
    .references(() => projects.id, { onDelete: 'cascade' }),
  activityType: activityTypeEnum('activity_type').notNull(),
  walletAddress: varchar('wallet_address', { length: 255 }),
  collectionId: uuid('collection_id').references(() => collections.id, { onDelete: 'set null' }),
  tokenId: varchar('token_id', { length: 255 }),
  price: real('price'),
  message: text('message'),
  imageUrl: text('image_url'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
});

export const flexReactions = pgTable('flex_reactions', {
  id: uuid('id').primaryKey().defaultRandom(),
  activityId: uuid('activity_id')
    .notNull()
    .references(() => activityFeed.id, { onDelete: 'cascade' }),
  walletAddress: varchar('wallet_address', { length: 255 }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
});
