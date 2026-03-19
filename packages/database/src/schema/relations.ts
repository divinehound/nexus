import { relations } from 'drizzle-orm';
import {
  projects,
  collections,
  collectionIntakeRequests,
} from './projects';
import { users, wallets, holders } from './users';
import { projectWiki, wikiSuggestions } from './wiki';
import { events } from './events';
import { activityFeed, flexReactions } from './activity';
import { marketSnapshots } from './market';
import { projectOwners } from './ownership';

export const projectsRelations = relations(projects, ({ many, one }) => ({
  collections: many(collections, { relationName: 'primary_project' }),
  wiki: one(projectWiki),
  events: many(events),
  activityFeed: many(activityFeed),
  owners: many(projectOwners),
  proposedCollections: many(collections, { relationName: 'proposed_project' }),
}));

export const collectionsRelations = relations(collections, ({ one, many }) => ({
  project: one(projects, {
    fields: [collections.projectId],
    references: [projects.id],
    relationName: 'primary_project',
  }),
  proposedProject: one(projects, {
    fields: [collections.proposedProjectId],
    references: [projects.id],
    relationName: 'proposed_project',
  }),
  marketSnapshots: many(marketSnapshots),
}));

export const collectionIntakeRequestsRelations = relations(
  collectionIntakeRequests,
  ({ one }) => ({
    requestedByUser: one(users, {
      fields: [collectionIntakeRequests.requestedByUserId],
      references: [users.id],
    }),
  }),
);

export const usersRelations = relations(users, ({ many }) => ({
  wallets: many(wallets),
  wikiSuggestions: many(wikiSuggestions),
  ownedProjects: many(projectOwners),
  collectionIntakeRequests: many(collectionIntakeRequests),
}));

export const walletsRelations = relations(wallets, ({ one }) => ({
  user: one(users, {
    fields: [wallets.userId],
    references: [users.id],
  }),
}));

export const projectWikiRelations = relations(projectWiki, ({ one }) => ({
  project: one(projects, {
    fields: [projectWiki.projectId],
    references: [projects.id],
  }),
}));

export const eventsRelations = relations(events, ({ one }) => ({
  project: one(projects, {
    fields: [events.projectId],
    references: [projects.id],
  }),
}));

export const activityFeedRelations = relations(activityFeed, ({ one, many }) => ({
  project: one(projects, {
    fields: [activityFeed.projectId],
    references: [projects.id],
  }),
  collection: one(collections, {
    fields: [activityFeed.collectionId],
    references: [collections.id],
  }),
  reactions: many(flexReactions),
}));

export const flexReactionsRelations = relations(flexReactions, ({ one }) => ({
  activity: one(activityFeed, {
    fields: [flexReactions.activityId],
    references: [activityFeed.id],
  }),
}));

export const projectOwnersRelations = relations(projectOwners, ({ one }) => ({
  project: one(projects, {
    fields: [projectOwners.projectId],
    references: [projects.id],
  }),
  user: one(users, {
    fields: [projectOwners.userId],
    references: [users.id],
  }),
}));

export const marketSnapshotsRelations = relations(marketSnapshots, ({ one }) => ({
  collection: one(collections, {
    fields: [marketSnapshots.collectionId],
    references: [collections.id],
  }),
}));
