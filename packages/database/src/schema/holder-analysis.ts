import {
  pgTable,
  uuid,
  varchar,
  text,
  boolean,
  integer,
  bigint,
  real,
  doublePrecision,
  numeric,
  timestamp,
  jsonb,
  primaryKey,
  index,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { chainEnum, collections, projects } from './projects';
import { users } from './users';

/**
 * The holder analysis (ported from spooky-bar apps/holder-analysis; plan "merge holder analysis
 * into Nexus", 2026-11-02). Projects opt in with projects.holder_analysis_enabled; only the
 * collections of enabled projects are read from the chain. Addresses lowercased (EVM only for
 * now), times as timestamptz.
 */

/**
 * Every transfer of a collection, one row per token moved: an ERC-1155 batch is one row per
 * token id (token_id '' for ERC-20). `amount` is 1 for ERC-721, the count for ERC-1155 and whole
 * tokens (decimals applied) for ERC-20. tx_from / tx_to / tx_value come from the transaction
 * (NFTs only) and need_tx stays true until they're looked up.
 *
 * Hash-partitioned by collection (migration 0037): every read is "one collection's transfers in
 * order" or "one wallet's", so a collection's rows sit in one partition.
 */
export const collectionTransfers = pgTable(
  'collection_transfers',
  {
    collectionId: uuid('collection_id')
      .notNull()
      .references(() => collections.id, { onDelete: 'cascade' }),
    chain: chainEnum('chain').notNull(),
    blockNumber: bigint('block_number', { mode: 'number' }).notNull(),
    logIndex: integer('log_index').notNull(),
    blockTime: timestamp('block_time', { withTimezone: true }).notNull(),
    txHash: varchar('tx_hash', { length: 128 }).notNull(),
    fromAddress: varchar('from_address', { length: 64 }).notNull(),
    toAddress: varchar('to_address', { length: 64 }).notNull(),
    tokenId: varchar('token_id', { length: 128 }).default('').notNull(),
    amount: doublePrecision('amount').notNull(),
    txFrom: varchar('tx_from', { length: 64 }),
    txTo: varchar('tx_to', { length: 64 }),
    txValueWei: numeric('tx_value_wei', { precision: 78, scale: 0 }),
    needTx: boolean('need_tx').default(false).notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.collectionId, t.txHash, t.logIndex, t.tokenId] }),
    index('collection_transfers_order_idx').on(t.collectionId, t.blockNumber, t.logIndex),
    index('collection_transfers_from_idx').on(t.fromAddress),
    index('collection_transfers_to_idx').on(t.toAddress),
    index('collection_transfers_tx_idx').on(t.txHash),
    index('collection_transfers_need_tx_idx').on(t.collectionId).where(sql`${t.needTx}`),
  ],
);

/** How far each collection's transfers have been read; `live` once caught up with the chain. */
export const collectionTransferSync = pgTable('collection_transfer_sync', {
  collectionId: uuid('collection_id')
    .primaryKey()
    .references(() => collections.id, { onDelete: 'cascade' }),
  lastBlock: bigint('last_block', { mode: 'number' }).default(0).notNull(),
  live: boolean('live').default(false).notNull(),
  syncedAt: timestamp('synced_at', { withTimezone: true }),
  error: text('error'),
  errorAt: timestamp('error_at', { withTimezone: true }),
});

/**
 * How the analysis treats one collection of its project. `short_id` names the collection in CSV
 * columns ("sb_held"); core collections make up a holder's total; staking contracts still count
 * for whoever staked; token_names label ERC-1155 ids.
 */
export const holderAnalysisCollectionSettings = pgTable('holder_analysis_collection_settings', {
  collectionId: uuid('collection_id')
    .primaryKey()
    .references(() => collections.id, { onDelete: 'cascade' }),
  shortId: varchar('short_id', { length: 16 }).notNull(),
  /** erc721 | erc1155 | erc20; null = the collection's own type. */
  standard: varchar('standard', { length: 8 }),
  core: boolean('core').default(true).notNull(),
  decimals: integer('decimals').default(0).notNull(),
  stakingContracts: text('staking_contracts').array().default(sql`'{}'::text[]`).notNull(),
  tokenNames: jsonb('token_names').$type<Record<string, string>>().default({}).notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
});

/**
 * What the sync knows about a wallet on a chain: its first funder, last outgoing activity,
 * delegations (delegate.xyz v1/v2, warm.xyz), ENS and OpenSea names. Shared by every project.
 */
export const walletProfiles = pgTable(
  'wallet_profiles',
  {
    chain: chainEnum('chain').notNull(),
    address: varchar('address', { length: 64 }).notNull(),
    isContract: boolean('is_contract'),
    funder: varchar('funder', { length: 64 }),
    fundedAt: timestamp('funded_at', { withTimezone: true }),
    lastOutAt: timestamp('last_out_at', { withTimezone: true }),
    infoAt: timestamp('info_at', { withTimezone: true }),
    delegations: jsonb('delegations'),
    delegationsAt: timestamp('delegations_at', { withTimezone: true }),
    ens: varchar('ens', { length: 255 }),
    opensea: varchar('opensea', { length: 255 }),
    namesAt: timestamp('names_at', { withTimezone: true }),
  },
  (t) => [primaryKey({ columns: [t.chain, t.address] }), index('wallet_profiles_funder_idx').on(t.chain, t.funder)],
);

/** Etherscan activity of a project's holder before / after they first got its tokens (the outlook). */
export const holderUsage = pgTable(
  'holder_usage',
  {
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    address: varchar('address', { length: 64 }).notNull(),
    data: jsonb('data').notNull(),
    fetchedAt: timestamp('fetched_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [primaryKey({ columns: [t.projectId, t.address] })],
);

/** The latest analysis of a project: its summary, and the newest block it saw. */
export const holderReports = pgTable('holder_reports', {
  projectId: uuid('project_id')
    .primaryKey()
    .references(() => projects.id, { onDelete: 'cascade' }),
  summary: jsonb('summary').notNull(),
  analysisVersion: integer('analysis_version').notNull(),
  block: bigint('block', { mode: 'number' }),
  durationMs: integer('duration_ms'),
  analysedAt: timestamp('analysed_at', { withTimezone: true }).defaultNow().notNull(),
});

/** One row per holder of the project's core collections in the latest analysis. */
export const holderReportHolders = pgTable(
  'holder_report_holders',
  {
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    address: varchar('address', { length: 64 }).notNull(),
    rank: integer('rank').notNull(),
    firstAt: timestamp('first_at', { withTimezone: true }),
    data: jsonb('data').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.projectId, t.address] }),
    index('holder_report_holders_rank_idx').on(t.projectId, t.rank),
    index('holder_report_holders_address_idx').on(t.address),
  ],
);

/** Holders of each non-core collection in the latest analysis. */
export const holderReportSideHolders = pgTable(
  'holder_report_side_holders',
  {
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    collectionId: uuid('collection_id')
      .notNull()
      .references(() => collections.id, { onDelete: 'cascade' }),
    address: varchar('address', { length: 64 }).notNull(),
    rank: integer('rank').notNull(),
    data: jsonb('data').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.projectId, t.collectionId, t.address] }),
    index('holder_report_side_holders_rank_idx').on(t.projectId, t.collectionId, t.rank),
  ],
);

/** Groups of wallets that are likely one person (collection admins only). */
export const holderWalletGroups = pgTable(
  'holder_wallet_groups',
  {
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    rank: integer('rank').notNull(),
    data: jsonb('data').notNull(),
  },
  (t) => [primaryKey({ columns: [t.projectId, t.rank] })],
);

/** The scored evidence between two wallets (a < b) behind the groups. */
export const holderWalletLinks = pgTable(
  'holder_wallet_links',
  {
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    a: varchar('a', { length: 64 }).notNull(),
    b: varchar('b', { length: 64 }).notNull(),
    score: real('score').notNull(),
    evidence: text('evidence').notNull(),
  },
  (t) => [primaryKey({ columns: [t.projectId, t.a, t.b] }), index('holder_wallet_links_b_idx').on(t.projectId, t.b)],
);

/**
 * What each transaction did to each wallet in the project's core collections over the last year
 * (replaced by every analysis). kind: minted, bought, sold, received, sent, burned; flag: new,
 * returned, exited or ''.
 */
export const holderActivity = pgTable(
  'holder_activity',
  {
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    at: timestamp('at', { withTimezone: true }).notNull(),
    collectionId: uuid('collection_id')
      .notNull()
      .references(() => collections.id, { onDelete: 'cascade' }),
    address: varchar('address', { length: 64 }).notNull(),
    kind: varchar('kind', { length: 16 }).notNull(),
    amount: doublePrecision('amount').notNull(),
    txHash: varchar('tx_hash', { length: 128 }).notNull(),
    eth: doublePrecision('eth').default(0).notNull(),
    flag: varchar('flag', { length: 16 }).default('').notNull(),
  },
  (t) => [
    index('holder_activity_at_idx').on(t.projectId, t.at),
    index('holder_activity_address_idx').on(t.projectId, t.address),
  ],
);

/** A project's own label and note for a wallet, shared by that project's admins. */
export const holderWalletLabels = pgTable(
  'holder_wallet_labels',
  {
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    address: varchar('address', { length: 64 }).notNull(),
    label: varchar('label', { length: 100 }).default('').notNull(),
    note: text('note').default('').notNull(),
    updatedBy: uuid('updated_by').references(() => users.id, { onDelete: 'set null' }),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [primaryKey({ columns: [t.projectId, t.address] })],
);

/** Two wallets (a < b) a project's admins know are not one person: never put in one group. */
export const holderWalletUnlinks = pgTable(
  'holder_wallet_unlinks',
  {
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    a: varchar('a', { length: 64 }).notNull(),
    b: varchar('b', { length: 64 }).notNull(),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [primaryKey({ columns: [t.projectId, t.a, t.b] }), index('holder_wallet_unlinks_b_idx').on(t.projectId, t.b)],
);
