import {
  pgTable,
  uuid,
  timestamp,
  text,
  integer,
  bigint,
  real,
  varchar,
  date,
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
    // Sale price attributed to this transfer, in the chain's native token
    // (SOL/ETH/…) and in USD at the transfer's block time. Null when the
    // transfer carried no price (airdrop, mint, wallet-to-wallet move, or a
    // marketplace sale we couldn't recover a price for).
    priceNative: real('price_native'),
    priceUsd: real('price_usd'),
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
    // Sale/mint price in lamports, extracted from the Helius NFT event when the
    // transfer represents a marketplace sale or a priced mint. Null otherwise.
    priceLamports: bigint('price_lamports', { mode: 'number' }),
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

/**
 * Per-wallet realized/unrealized PnL for a collection, computed when a full
 * holder transfer history finishes processing. One row per (collection, wallet).
 *
 * All *Native amounts are in the collection chain's native token (SOL/ETH/…),
 * identified by `nativeSymbol`. USD amounts are valued at each transfer's
 * historical daily rate; unrealized USD is marked against the current spot rate.
 */
export const collectionHolderPnl = pgTable(
  'collection_holder_pnl',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    collectionId: uuid('collection_id')
      .notNull()
      .references(() => collections.id, { onDelete: 'cascade' }),
    chain: chainEnum('chain').notNull(),
    address: text('address').notNull(),
    nativeSymbol: varchar('native_symbol', { length: 16 }).notNull(),
    // Counts of priced acquisitions/dispositions (a real price was paid/received).
    buyCount: integer('buy_count').default(0).notNull(),
    sellCount: integer('sell_count').default(0).notNull(),
    realizedPnlNative: real('realized_pnl_native').default(0).notNull(),
    realizedPnlUsd: real('realized_pnl_usd').default(0).notNull(),
    unrealizedPnlNative: real('unrealized_pnl_native').default(0).notNull(),
    unrealizedPnlUsd: real('unrealized_pnl_usd').default(0).notNull(),
    totalBoughtNative: real('total_bought_native').default(0).notNull(),
    totalSoldNative: real('total_sold_native').default(0).notNull(),
    // Native cost basis of tokens the wallet still holds.
    costBasisRemainingNative: real('cost_basis_remaining_native').default(0).notNull(),
    // Average hold time (seconds) across tokens the wallet has bought and sold.
    avgHoldTimeSeconds: bigint('avg_hold_time_seconds', { mode: 'number' }),
    computedAt: timestamp('computed_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex('collection_holder_pnl_unique').on(table.collectionId, table.address),
    index('collection_holder_pnl_realized_idx').on(table.collectionId, table.realizedPnlNative),
  ],
);

/**
 * Cache of daily USD prices for native tokens (SOL, ETH, …). Populated from an
 * external historical-price API and reused across scans so PnL USD valuation is
 * both accurate (rate at the transfer date) and cheap (no repeated fetches).
 */
export const tokenPriceDaily = pgTable(
  'token_price_daily',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    symbol: varchar('symbol', { length: 16 }).notNull(),
    date: date('date').notNull(),
    usdPrice: real('usd_price').notNull(),
    source: varchar('source', { length: 32 }).default('coingecko').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [uniqueIndex('token_price_daily_unique').on(table.symbol, table.date)],
);
