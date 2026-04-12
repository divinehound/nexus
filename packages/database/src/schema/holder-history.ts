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
  boolean,
  jsonb,
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

export const solanaIndexedMints = pgTable(
  'solana_indexed_mints',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    collectionId: uuid('collection_id')
      .notNull()
      .references(() => collections.id, { onDelete: 'cascade' }),
    mintAddress: varchar('mint_address', { length: 64 }).notNull(),
    currentOwner: varchar('current_owner', { length: 64 }),
    sigCollectionStatus: varchar('sig_collection_status', { length: 16 }).default('pending').notNull(),
    sigCount: integer('sig_count').default(0).notNull(),
    firstMintTime: timestamp('first_mint_time', { withTimezone: true }),
    reconciliationStatus: varchar('reconciliation_status', { length: 16 }).default('pending').notNull(),
    reconciliationNote: text('reconciliation_note'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex('solana_indexed_mints_unique').on(table.collectionId, table.mintAddress),
    index('solana_indexed_mints_status_idx').on(table.collectionId, table.sigCollectionStatus),
  ],
);

export const solanaRawSignatures = pgTable(
  'solana_raw_signatures',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    collectionId: uuid('collection_id')
      .notNull()
      .references(() => collections.id, { onDelete: 'cascade' }),
    mintAddress: varchar('mint_address', { length: 64 }).notNull(),
    signature: varchar('signature', { length: 128 }).notNull(),
    parsed: boolean('parsed').default(false).notNull(),
    blockTime: timestamp('block_time', { withTimezone: true }),
    slot: bigint('slot', { mode: 'number' }),
    parseStatus: varchar('parse_status', { length: 16 }).default('pending').notNull(),
    rawData: jsonb('raw_data'),
    transfersFound: integer('transfers_found').default(0).notNull(),
    lastParsedAt: timestamp('last_parsed_at', { withTimezone: true }),
    errorMessage: text('error_message'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex('solana_raw_signatures_sig_unique').on(table.signature),
    index('solana_raw_signatures_parsed_idx').on(table.collectionId, table.parsed),
    index('solana_raw_signatures_parse_status_idx').on(table.collectionId, table.parseStatus),
  ],
);

export const solanaParsedTransfers = pgTable(
  'solana_parsed_transfers',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    collectionId: uuid('collection_id')
      .notNull()
      .references(() => collections.id, { onDelete: 'cascade' }),
    signature: varchar('signature', { length: 128 }).notNull(),
    mintAddress: varchar('mint_address', { length: 64 }).notNull(),
    fromWallet: varchar('from_wallet', { length: 64 }),
    toWallet: varchar('to_wallet', { length: 64 }),
    blockTime: timestamp('block_time', { withTimezone: true }).notNull(),
    slot: bigint('slot', { mode: 'number' }).notNull(),
    instructionOrder: integer('instruction_order').default(0).notNull(),
    parserName: varchar('parser_name', { length: 64 }).notNull(),
    programId: varchar('program_id', { length: 64 }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex('solana_parsed_transfers_unique').on(
      table.signature,
      table.mintAddress,
      table.fromWallet,
      table.toWallet,
      table.parserName,
    ),
    index('solana_parsed_transfers_collection_time_idx').on(
      table.collectionId,
      table.blockTime,
      table.slot,
      table.instructionOrder,
    ),
    index('solana_parsed_transfers_mint_idx').on(
      table.collectionId,
      table.mintAddress,
      table.blockTime,
    ),
  ],
);
