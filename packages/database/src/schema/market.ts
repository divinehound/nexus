import {
  pgTable,
  uuid,
  real,
  integer,
  timestamp,
} from 'drizzle-orm/pg-core';
import { collections } from './projects';

export const marketSnapshots = pgTable('market_snapshots', {
  collectionId: uuid('collection_id')
    .notNull()
    .references(() => collections.id, { onDelete: 'cascade' }),
  timestamp: timestamp('timestamp', { withTimezone: true }).defaultNow().notNull(),
  floorPrice: real('floor_price'),
  volume24h: real('volume_24h'),
  holderCount: integer('holder_count'),
  listedCount: integer('listed_count'),
});
