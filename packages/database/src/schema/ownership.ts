import {
  pgTable,
  uuid,
  timestamp,
  pgEnum,
} from 'drizzle-orm/pg-core';
import { projects } from './projects';
import { users } from './users';

export const projectOwnerRoleEnum = pgEnum('project_owner_role', [
  'owner',
  'editor',
]);

export const projectOwners = pgTable('project_owners', {
  id: uuid('id').primaryKey().defaultRandom(),
  projectId: uuid('project_id')
    .notNull()
    .references(() => projects.id, { onDelete: 'cascade' }),
  userId: uuid('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  role: projectOwnerRoleEnum('role').default('editor').notNull(),
  assignedAt: timestamp('assigned_at', { withTimezone: true }).defaultNow().notNull(),
});
