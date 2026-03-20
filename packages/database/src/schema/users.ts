import {
  pgTable,
  uuid,
  varchar,
  integer,
  boolean,
  timestamp,
  pgEnum,
  text,
  uniqueIndex,
  index,
} from 'drizzle-orm/pg-core';
import { chainEnum } from './projects';

export const userRoleEnum = pgEnum('user_role', ['user', 'admin']);

export const users = pgTable('users', {
  id: uuid('id').primaryKey().defaultRandom(),
  primaryWalletId: uuid('primary_wallet_id'),
  role: userRoleEnum('role').default('user').notNull(),
  displayName: varchar('display_name', { length: 255 }),
  avatarUrl: text('avatar_url'),
  bio: text('bio'),
  echoScore: integer('echo_score'),
  clusterIds: uuid('cluster_ids').array().default([]),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  lastActiveAt: timestamp('last_active_at', { withTimezone: true }),
});

export const wallets = pgTable(
  'wallets',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    address: varchar('address', { length: 255 }).notNull(),
    chain: chainEnum('chain').notNull(),
    userId: uuid('user_id').references(() => users.id, { onDelete: 'set null' }),
    isPrimary: boolean('is_primary').default(false).notNull(),
    ensName: varchar('ens_name', { length: 255 }),
    snsName: varchar('sns_name', { length: 255 }),
    lastSyncedAt: timestamp('last_synced_at', { withTimezone: true }),
  },
  (table) => [
    uniqueIndex('wallets_chain_address_unique').on(table.chain, table.address),
    index('wallets_user_id_idx').on(table.userId),
  ],
);

export const walletChallengePurposeEnum = pgEnum('wallet_challenge_purpose', [
  'link_wallet',
  'move_wallet',
]);

export const walletLinkChallenges = pgTable(
  'wallet_link_challenges',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    chain: chainEnum('chain').notNull(),
    address: varchar('address', { length: 255 }).notNull(),
    purpose: walletChallengePurposeEnum('purpose').notNull(),
    nonce: varchar('nonce', { length: 255 }).notNull(),
    message: text('message').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    usedAt: timestamp('used_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [index('wallet_link_challenges_lookup_idx').on(table.userId, table.chain, table.address)],
);

export const walletMoveConfirmations = pgTable(
  'wallet_move_confirmations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    walletId: uuid('wallet_id')
      .notNull()
      .references(() => wallets.id, { onDelete: 'cascade' }),
    fromUserId: uuid('from_user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    toUserId: uuid('to_user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    chain: chainEnum('chain').notNull(),
    address: varchar('address', { length: 255 }).notNull(),
    token: varchar('token', { length: 255 }).notNull().unique(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    usedAt: timestamp('used_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [index('wallet_move_confirmations_lookup_idx').on(table.toUserId, table.chain, table.address)],
);

export const walletOwnershipMoves = pgTable('wallet_ownership_moves', {
  id: uuid('id').primaryKey().defaultRandom(),
  walletId: uuid('wallet_id')
    .notNull()
    .references(() => wallets.id, { onDelete: 'cascade' }),
  fromUserId: uuid('from_user_id').references(() => users.id, { onDelete: 'set null' }),
  toUserId: uuid('to_user_id').references(() => users.id, { onDelete: 'set null' }),
  chain: chainEnum('chain').notNull(),
  address: varchar('address', { length: 255 }).notNull(),
  reason: varchar('reason', { length: 255 }),
  movedAt: timestamp('moved_at', { withTimezone: true }).defaultNow().notNull(),
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
