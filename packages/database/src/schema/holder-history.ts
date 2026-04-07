import {
  pgTable,
  uuid,
  timestamp,
  text,
  integer,
  bigint,
  varchar,
  uniqueIndex,
  index,
  pgEnum,
} from 'drizzle-orm/pg-core';
import { collections, chainEnum } from './projects';

export const holderTransferDirectionEnum = pgEnum('holder_transfer_direction', ['in', 'out']);

export const collectionHolderSummaries = pgTable(
  'collection_holder_summaries',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    collectionId: uuid('collection_id')
      .notNull()
      .references(() => collections.id, { onDelete: 'cascade' }),
    chain: chainEnum('chain').notNull(),
    address: text('address').notNull(),
    currentBalance: integer('current_balance').default(0).notNull(),
    firstReceivedAt: timestamp('first_received_at', { withTimezone: true }),
    firstReceivedBlock: bigint('first_received_block', { mode: 'number' }),
    lastReceivedAt: timestamp('last_received_at', { withTimezone: true }),
    lastReceivedBlock: bigint('last_received_block', { mode: 'number' }),
    totalReceivedCount: integer('total_received_count').default(0).notNull(),
    totalSentCount: integer('total_sent_count').default(0).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex('collection_holder_summaries_unique').on(table.collectionId, table.address),
    index('collection_holder_summaries_balance_idx').on(table.collectionId, table.currentBalance),
  ],
);

export const collectionHolderBalanceHistory = pgTable(
  'collection_holder_balance_history',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    collectionId: uuid('collection_id')
      .notNull()
      .references(() => collections.id, { onDelete: 'cascade' }),
    chain: chainEnum('chain').notNull(),
    address: text('address').notNull(),
    blockNumber: bigint('block_number', { mode: 'number' }).notNull(),
    blockTimestamp: timestamp('block_timestamp', { withTimezone: true }).notNull(),
    transactionHash: varchar('transaction_hash', { length: 255 }).notNull(),
    logIndex: integer('log_index').notNull(),
    tokenId: varchar('token_id', { length: 255 }).notNull(),
    direction: holderTransferDirectionEnum('direction').notNull(),
    balanceAfter: integer('balance_after').notNull(),
    counterpartyAddress: text('counterparty_address'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex('collection_holder_balance_history_unique').on(
      table.collectionId,
      table.transactionHash,
      table.logIndex,
      table.address,
    ),
    index('collection_holder_balance_history_wallet_idx').on(table.collectionId, table.address, table.blockNumber),
  ],
);
