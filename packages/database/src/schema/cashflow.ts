import { pgTable, uuid, varchar, timestamp, text, jsonb, uniqueIndex, index } from 'drizzle-orm/pg-core';
import { users } from './users';

/**
 * User overrides for the Money dashboard's transfer pairing: `link` ties two
 * transactions together as one move between the user's own wallets (e.g. a
 * SimpleSwap trip from Ethereum to Solana); `unlink` rejects a pair the
 * automatic bridge matcher proposed.
 */
export const cashflowTxLinks = pgTable(
  'cashflow_tx_links',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .references(() => users.id, { onDelete: 'cascade' })
      .notNull(),
    kind: varchar('kind', { length: 16 }).notNull(), // 'link' | 'unlink'
    fromChain: varchar('from_chain', { length: 32 }).notNull(),
    fromTxHash: varchar('from_tx_hash', { length: 128 }).notNull(),
    toChain: varchar('to_chain', { length: 32 }).notNull(),
    toTxHash: varchar('to_tx_hash', { length: 128 }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex('cashflow_tx_links_unique').on(table.userId, table.fromChain, table.fromTxHash, table.toChain, table.toTxHash),
    index('cashflow_tx_links_user_id_idx').on(table.userId),
  ],
);

/**
 * Addresses a user has tagged as their own account at a centralized exchange,
 * so transfers to/from them count as cashing out / depositing rather than
 * sending money to someone. `chainFamily` is 'evm' (one address across all
 * EVM chains) or 'solana'.
 */
export const cashflowAddressTags = pgTable(
  'cashflow_address_tags',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .references(() => users.id, { onDelete: 'cascade' })
      .notNull(),
    chainFamily: varchar('chain_family', { length: 16 }).notNull(),
    address: varchar('address', { length: 255 }).notNull(),
    exchange: varchar('exchange', { length: 64 }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex('cashflow_address_tags_unique').on(table.userId, table.chainFamily, table.address),
    index('cashflow_address_tags_user_id_idx').on(table.userId),
  ],
);

/**
 * Saved results of the Money dashboard's chain scans, so a page load (or an API
 * restart) rebuilds the report from these instead of rescanning. One row per
 * (kind, chain, address): kind 'activity' holds one wallet's history on one
 * chain, 'relay' one address's Relay bridge records, 'deposits' the exchange
 * deposit addresses detected across all wallets (chain and address '').
 */
export const cashflowScans = pgTable(
  'cashflow_scans',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .references(() => users.id, { onDelete: 'cascade' })
      .notNull(),
    kind: varchar('kind', { length: 16 }).notNull(),
    chain: varchar('chain', { length: 32 }).notNull(),
    address: varchar('address', { length: 255 }).notNull(),
    data: jsonb('data').notNull(),
    scannedAt: timestamp('scanned_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex('cashflow_scans_unique').on(table.userId, table.kind, table.chain, table.address),
  ],
);

/**
 * Whether a scan is running for a user, shared across API instances. A
 * running scan refreshes `heartbeatAt`; one that stops doing so (the instance
 * restarted) is treated as abandoned.
 */
export const cashflowScanState = pgTable('cashflow_scan_state', {
  userId: uuid('user_id')
    .primaryKey()
    .references(() => users.id, { onDelete: 'cascade' }),
  status: varchar('status', { length: 16 }).notNull(), // 'scanning' | 'idle' | 'failed'
  progress: text('progress'),
  error: text('error'),
  startedAt: timestamp('started_at', { withTimezone: true }).defaultNow().notNull(),
  heartbeatAt: timestamp('heartbeat_at', { withTimezone: true }).defaultNow().notNull(),
  /** Bumped whenever saved scan data changes, so other instances drop their cached report. */
  dataVersion: timestamp('data_version', { withTimezone: true }).defaultNow().notNull(),
});

/**
 * Which EVM chains to scan for one of the user's EVM addresses. No row means
 * every supported chain.
 */
export const cashflowWalletChains = pgTable(
  'cashflow_wallet_chains',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .references(() => users.id, { onDelete: 'cascade' })
      .notNull(),
    address: varchar('address', { length: 255 }).notNull(),
    chains: jsonb('chains').$type<string[]>().notNull(),
  },
  (table) => [uniqueIndex('cashflow_wallet_chains_unique').on(table.userId, table.address)],
);

/**
 * Transactions the user marked as read wrong (or missing). Re-importing
 * refetches only these, instead of rescanning whole wallets.
 */
export const cashflowFlags = pgTable(
  'cashflow_flags',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .references(() => users.id, { onDelete: 'cascade' })
      .notNull(),
    chain: varchar('chain', { length: 32 }).notNull(),
    txHash: varchar('tx_hash', { length: 128 }).notNull(),
    note: text('note'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    reimportedAt: timestamp('reimported_at', { withTimezone: true }),
  },
  (table) => [uniqueIndex('cashflow_flags_unique').on(table.userId, table.chain, table.txHash)],
);

/**
 * Names the user gave the people behind transfers, so money sent/received can
 * be totalled per person across all their wallets and exchange accounts.
 * kind 'address': every transfer with an address (`scope` = chain family
 * 'evm' | 'solana', `ref` = address, EVM lowercased). kind 'tx': one transfer
 * (`scope` = chain, `ref` = tx hash, EVM lowercased) — overrides the address's
 * name, e.g. Bob paying from a shared exchange wallet.
 */
export const cashflowContactLabels = pgTable(
  'cashflow_contact_labels',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .references(() => users.id, { onDelete: 'cascade' })
      .notNull(),
    kind: varchar('kind', { length: 8 }).notNull(),
    scope: varchar('scope', { length: 32 }).notNull(),
    ref: varchar('ref', { length: 255 }).notNull(),
    label: varchar('label', { length: 100 }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex('cashflow_contact_labels_unique').on(table.userId, table.kind, table.scope, table.ref),
  ],
);

/** The user's own note on a transaction (EVM hashes lowercased). */
export const cashflowTxNotes = pgTable(
  'cashflow_tx_notes',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .references(() => users.id, { onDelete: 'cascade' })
      .notNull(),
    chain: varchar('chain', { length: 32 }).notNull(),
    txHash: varchar('tx_hash', { length: 128 }).notNull(),
    note: text('note').notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [uniqueIndex('cashflow_tx_notes_unique').on(table.userId, table.chain, table.txHash)],
);

/**
 * Transactions whose assets the user sent away and lost for good (e.g. stuck
 * in a locked escrow); their cost is booked as a realized loss. EVM hashes
 * lowercased.
 */
export const cashflowLostTxs = pgTable(
  'cashflow_lost_txs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .references(() => users.id, { onDelete: 'cascade' })
      .notNull(),
    chain: varchar('chain', { length: 32 }).notNull(),
    txHash: varchar('tx_hash', { length: 128 }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [uniqueIndex('cashflow_lost_txs_unique').on(table.userId, table.chain, table.txHash)],
);
