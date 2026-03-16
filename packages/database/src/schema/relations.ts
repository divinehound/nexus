import { relations } from 'drizzle-orm';
import { projects, collections } from './projects';
import { users, wallets, holders } from './users';
import { projectWiki, wikiSuggestions } from './wiki';
import { events } from './events';
import { activityFeed, flexReactions } from './activity';
import { marketSnapshots } from './market';

export const projectsRelations = relations(projects, ({ many, one }) => ({
  collections: many(collections),
  wiki: one(projectWiki),
  events: many(events),
  activityFeed: many(activityFeed),
}));

export const collectionsRelations = relations(collections, ({ one, many }) => ({
  project: one(projects, {
    fields: [collections.projectId],
    references: [projects.id],
  }),
  marketSnapshots: many(marketSnapshots),
}));

export const usersRelations = relations(users, ({ many }) => ({
  wallets: many(wallets),
  wikiSuggestions: many(wikiSuggestions),
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

export const marketSnapshotsRelations = relations(marketSnapshots, ({ one }) => ({
  collection: one(collections, {
    fields: [marketSnapshots.collectionId],
    references: [collections.id],
  }),
}));
