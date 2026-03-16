import {
  pgTable,
  uuid,
  varchar,
  integer,
  boolean,
  timestamp,
} from 'drizzle-orm/pg-core';
import { chainEnum } from './projects';

export const users = pgTable('users', {
  id: uuid('id').primaryKey().defaultRandom(),
  primaryWalletId: uuid('primary_wallet_id'),
  echoScore: integer('echo_score'),
  clusterIds: uuid('cluster_ids').array().default([]),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  lastActiveAt: timestamp('last_active_at', { withTimezone: true }),
});

export const wallets = pgTable('wallets', {
  id: uuid('id').primaryKey().defaultRandom(),
  address: varchar('address', { length: 255 }).notNull(),
  chain: chainEnum('chain').notNull(),
  userId: uuid('user_id').references(() => users.id, { onDelete: 'set null' }),
  ensName: varchar('ens_name', { length: 255 }),
  snsName: varchar('sns_name', { length: 255 }),
  lastSyncedAt: timestamp('last_synced_at', { withTimezone: true }),
});

export const holders = pgTable('holders', {
  id: uuid('id').primaryKey().defaultRandom(),
  walletAddress: varchar('wallet_address', { length: 255 }).notNull(),
  collectionId: uuid('collection_id').notNull(),
  chain: chainEnum('chain').notNull(),
  firstAcquiredAt: timestamp('first_acquired_at', { withTimezone: true }).defaultNow().notNull(),
  quantity: integer('quantity').default(1).notNull(),
  isCurrent: boolean('is_current').default(true).notNull(),
});
