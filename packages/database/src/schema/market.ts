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
  listedCount: integer('listed_count'),
  holderCount: integer('holder_count'),
  volume1h: real('volume_1h'),
  volume24h: real('volume_24h'),
  volume7d: real('volume_7d'),
  sales24h: integer('sales_24h'),
  uniqueBuyers24h: integer('unique_buyers_24h'),
});
