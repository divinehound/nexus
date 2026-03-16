import {
  pgTable,
  uuid,
  text,
  jsonb,
  integer,
  timestamp,
  pgEnum,
} from 'drizzle-orm/pg-core';
import { projects } from './projects';
import { users } from './users';

export const wikiSuggestionStatusEnum = pgEnum('wiki_suggestion_status', [
  'pending',
  'approved',
  'rejected',
]);

export const projectWiki = pgTable('project_wiki', {
  id: uuid('id').primaryKey().defaultRandom(),
  projectId: uuid('project_id')
    .notNull()
    .references(() => projects.id, { onDelete: 'cascade' })
    .unique(),
  descriptionMd: text('description_md'),
  autoTimeline: jsonb('auto_timeline').default([]),
  lastEditedBy: uuid('last_edited_by').references(() => users.id, { onDelete: 'set null' }),
  lastEditedAt: timestamp('last_edited_at', { withTimezone: true }),
  revisionNumber: integer('revision_number').default(1).notNull(),
});

export const wikiSuggestions = pgTable('wiki_suggestions', {
  id: uuid('id').primaryKey().defaultRandom(),
  projectId: uuid('project_id')
    .notNull()
    .references(() => projects.id, { onDelete: 'cascade' }),
  submittedBy: uuid('submitted_by')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  field: text('field').notNull(),
  proposedValue: text('proposed_value').notNull(),
  status: wikiSuggestionStatusEnum('status').default('pending').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
});
