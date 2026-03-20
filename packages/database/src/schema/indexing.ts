import { index, jsonb, pgTable, text, timestamp, uuid, varchar } from 'drizzle-orm/pg-core';
import { users, wallets, walletIndexingStatusEnum } from './users';

export const indexingJobs = pgTable(
  'indexing_jobs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    entityType: varchar('entity_type', { length: 32 }).notNull(),
    entityId: varchar('entity_id', { length: 255 }).notNull(),
    type: varchar('type', { length: 64 }).default('metrics_refresh').notNull(),
    status: walletIndexingStatusEnum('status').default('queued').notNull(),
    startedAt: timestamp('started_at', { withTimezone: true }).defaultNow().notNull(),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
    triggeredByUserId: uuid('triggered_by_user_id').references(() => users.id, { onDelete: 'set null' }),
    walletId: uuid('wallet_id').references(() => wallets.id, { onDelete: 'set null' }),
    retryOfJobId: uuid('retry_of_job_id'),
    statsJson: jsonb('stats_json').$type<Record<string, unknown>>(),
    error: text('error'),
  },
  (table) => [
    index('indexing_jobs_entity_idx').on(table.entityType, table.entityId),
    index('indexing_jobs_status_idx').on(table.status),
    index('indexing_jobs_started_idx').on(table.startedAt),
    index('indexing_jobs_wallet_idx').on(table.walletId),
    index('indexing_jobs_retry_of_idx').on(table.retryOfJobId),
  ],
);
