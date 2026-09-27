import { pgTable, uuid, varchar, timestamp, uniqueIndex, index } from 'drizzle-orm/pg-core';
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
