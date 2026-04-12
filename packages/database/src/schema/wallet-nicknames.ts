import {
  pgTable,
  uuid,
  varchar,
  timestamp,
  uniqueIndex,
  index,
} from 'drizzle-orm/pg-core';
import { users } from './users';

export const walletNicknames = pgTable(
  'wallet_nicknames',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .references(() => users.id, { onDelete: 'cascade' })
      .notNull(),
    address: varchar('address', { length: 255 }).notNull(),
    nickname: varchar('nickname', { length: 100 }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex('wallet_nicknames_user_address_unique').on(
      table.userId,
      table.address,
    ),
    index('wallet_nicknames_user_id_idx').on(table.userId),
  ],
);
