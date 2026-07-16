import {
  pgTable,
  uuid,
  varchar,
  integer,
  real,
  timestamp,
  text,
  jsonb,
} from 'drizzle-orm/pg-core';
import { collections } from './projects';

export const projectAffinity = pgTable('project_affinity', {
  projectAId: uuid('project_a_id').notNull(),
  projectBId: uuid('project_b_id').notNull(),
  overlapCount: integer('overlap_count').default(0).notNull(),
  overlapPct: real('overlap_pct').default(0).notNull(),
  lastComputedAt: timestamp('last_computed_at', { withTimezone: true }).defaultNow().notNull(),
});

export const collectionAffinity = pgTable('collection_affinity', {
  collectionAId: uuid('collection_a_id').notNull(),
  collectionBId: uuid('collection_b_id').notNull(),
  overlapCount: integer('overlap_count').default(0).notNull(),
  overlapPct: real('overlap_pct').default(0).notNull(),
  lastComputedAt: timestamp('last_computed_at', { withTimezone: true }).defaultNow().notNull(),
});

export const walletAffinity = pgTable('wallet_affinity', {
  walletAId: uuid('wallet_a_id').notNull(),
  walletBId: uuid('wallet_b_id').notNull(),
  sharedProjects: integer('shared_projects').default(0).notNull(),
  affinityScore: real('affinity_score').default(0).notNull(),
  lastComputedAt: timestamp('last_computed_at', { withTimezone: true }).defaultNow().notNull(),
});

export const clusters = pgTable('clusters', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: varchar('name', { length: 255 }).notNull(),
  color: varchar('color', { length: 7 }).notNull(),
  projectCount: integer('project_count').default(0).notNull(),
  holderCount: integer('holder_count').default(0).notNull(),
  lastComputedAt: timestamp('last_computed_at', { withTimezone: true }).defaultNow().notNull(),
});

/**
 * Resumable checkpoint for collection discovery scans. One row per source
 * collection; deleted when a scan completes successfully, so a surviving row
 * means the last scan was interrupted and can be resumed from the cursor.
 */
export const discoveryCheckpoints = pgTable('discovery_checkpoints', {
  collectionId: uuid('collection_id')
    .primaryKey()
    .references(() => collections.id, { onDelete: 'cascade' }),
  holdersChecked: integer('holders_checked').default(0).notNull(),
  holderCursor: text('holder_cursor'),
  // "chain:address" -> distinct-holder overlap count
  discoveredContracts: jsonb('discovered_contracts').$type<Record<string, number>>().notNull(),
  // "chain:address" keys already present in the collections table
  existingContracts: jsonb('existing_contracts').$type<string[]>().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
});
