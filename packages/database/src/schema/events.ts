import {
  pgTable,
  uuid,
  varchar,
  text,
  timestamp,
  pgEnum,
} from 'drizzle-orm/pg-core';
import { projects } from './projects';
import { users } from './users';

export const eventTypeEnum = pgEnum('event_type', [
  'spaces',
  'ama',
  'mint',
  'collab',
  'irl',
  'other',
]);

export const eventStatusEnum = pgEnum('event_status', ['upcoming', 'live', 'ended']);

export const eventSourceEnum = pgEnum('event_source', [
  'auto_twitter',
  'manual',
  'on_chain',
]);

export const events = pgTable('events', {
  id: uuid('id').primaryKey().defaultRandom(),
  projectId: uuid('project_id')
    .notNull()
    .references(() => projects.id, { onDelete: 'cascade' }),
  title: varchar('title', { length: 500 }).notNull(),
  description: text('description'),
  eventType: eventTypeEnum('event_type').notNull(),
  startTime: timestamp('start_time', { withTimezone: true }).notNull(),
  endTime: timestamp('end_time', { withTimezone: true }),
  link: text('link'),
  source: eventSourceEnum('source').notNull(),
  twitterSpaceId: varchar('twitter_space_id', { length: 255 }),
  status: eventStatusEnum('status').default('upcoming').notNull(),
  submittedBy: uuid('submitted_by').references(() => users.id, { onDelete: 'set null' }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
});
