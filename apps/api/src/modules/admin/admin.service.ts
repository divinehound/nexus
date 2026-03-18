import { Injectable, Inject, NotFoundException } from '@nestjs/common';
import { eq, and, count, sql, desc } from 'drizzle-orm';
import { DATABASE_TOKEN } from '../../common/database/database.module';
import {
  type Database,
  projects,
  users,
  wikiSuggestions,
  projectWiki,
  events,
  projectOwners,
} from '@nexus/database';

@Injectable()
export class AdminService {
  constructor(@Inject(DATABASE_TOKEN) private readonly db: Database) {}

  // --- Dashboard Stats ---

  async getStats() {
    const [[projectCount], [userCount], [pendingSuggestions], [eventCount]] =
      await Promise.all([
        this.db.select({ value: count() }).from(projects),
        this.db.select({ value: count() }).from(users),
        this.db
          .select({ value: count() })
          .from(wikiSuggestions)
          .where(eq(wikiSuggestions.status, 'pending')),
        this.db.select({ value: count() }).from(events),
      ]);

    return {
      projects: projectCount.value,
      users: userCount.value,
      pendingWikiSuggestions: pendingSuggestions.value,
      events: eventCount.value,
    };
  }

  // --- Project Management ---

  async listProjects(page = 1, limit = 50) {
    const offset = (page - 1) * limit;
    const items = await this.db.query.projects.findMany({
      limit,
      offset,
      with: { collections: true },
      orderBy: (projects, { desc }) => [desc(projects.createdAt)],
    });
    const [[total]] = await Promise.all([
      this.db.select({ value: count() }).from(projects),
    ]);
    return { items, total: total.value, page, limit };
  }

  async setProjectVerified(projectId: string, isVerified: boolean) {
    const [updated] = await this.db
      .update(projects)
      .set({ isVerified })
      .where(eq(projects.id, projectId))
      .returning();
    if (!updated) throw new NotFoundException('Project not found');
    return updated;
  }

  async deleteProject(projectId: string) {
    const [deleted] = await this.db
      .delete(projects)
      .where(eq(projects.id, projectId))
      .returning();
    if (!deleted) throw new NotFoundException('Project not found');
    return { deleted: true };
  }

  // --- Wiki Suggestions ---

  async listWikiSuggestions(status?: string) {
    if (status) {
      return this.db.query.wikiSuggestions.findMany({
        where: eq(
          wikiSuggestions.status,
          status as 'pending' | 'approved' | 'rejected',
        ),
        orderBy: [desc(wikiSuggestions.createdAt)],
      });
    }
    return this.db.query.wikiSuggestions.findMany({
      orderBy: [desc(wikiSuggestions.createdAt)],
    });
  }

  async approveWikiSuggestion(suggestionId: string) {
    const suggestion = await this.db.query.wikiSuggestions.findFirst({
      where: eq(wikiSuggestions.id, suggestionId),
    });
    if (!suggestion) throw new NotFoundException('Suggestion not found');

    // Apply the suggestion to the wiki
    const existingWiki = await this.db.query.projectWiki.findFirst({
      where: eq(projectWiki.projectId, suggestion.projectId),
    });

    if (existingWiki) {
      await this.db
        .update(projectWiki)
        .set({
          [suggestion.field]: suggestion.proposedValue,
          lastEditedBy: suggestion.submittedBy,
          lastEditedAt: new Date(),
          revisionNumber: sql`${projectWiki.revisionNumber} + 1`,
        })
        .where(eq(projectWiki.id, existingWiki.id));
    } else {
      await this.db.insert(projectWiki).values({
        projectId: suggestion.projectId,
        [suggestion.field]: suggestion.proposedValue,
        lastEditedBy: suggestion.submittedBy,
        lastEditedAt: new Date(),
      });
    }

    // Mark suggestion as approved
    const [updated] = await this.db
      .update(wikiSuggestions)
      .set({ status: 'approved' })
      .where(eq(wikiSuggestions.id, suggestionId))
      .returning();

    return updated;
  }

  async rejectWikiSuggestion(suggestionId: string) {
    const [updated] = await this.db
      .update(wikiSuggestions)
      .set({ status: 'rejected' })
      .where(eq(wikiSuggestions.id, suggestionId))
      .returning();
    if (!updated) throw new NotFoundException('Suggestion not found');
    return updated;
  }

  // --- Event Management ---

  async listAllEvents(status?: string) {
    if (status) {
      return this.db.query.events.findMany({
        where: eq(events.status, status as 'upcoming' | 'live' | 'ended'),
        orderBy: [desc(events.createdAt)],
      });
    }
    return this.db.query.events.findMany({
      orderBy: [desc(events.createdAt)],
    });
  }

  async deleteEvent(eventId: string) {
    const [deleted] = await this.db
      .delete(events)
      .where(eq(events.id, eventId))
      .returning();
    if (!deleted) throw new NotFoundException('Event not found');
    return { deleted: true };
  }

  async updateEventStatus(
    eventId: string,
    status: 'upcoming' | 'live' | 'ended',
  ) {
    const [updated] = await this.db
      .update(events)
      .set({ status })
      .where(eq(events.id, eventId))
      .returning();
    if (!updated) throw new NotFoundException('Event not found');
    return updated;
  }

  // --- User Management ---

  async listUsers(page = 1, limit = 50) {
    const offset = (page - 1) * limit;
    const items = await this.db.query.users.findMany({
      limit,
      offset,
      orderBy: (users, { desc }) => [desc(users.createdAt)],
    });
    const [[total]] = await Promise.all([
      this.db.select({ value: count() }).from(users),
    ]);
    return { items, total: total.value, page, limit };
  }

  async setUserRole(userId: string, role: 'user' | 'admin') {
    const [updated] = await this.db
      .update(users)
      .set({ role })
      .where(eq(users.id, userId))
      .returning();
    if (!updated) throw new NotFoundException('User not found');
    return updated;
  }

  // --- Project Ownership ---

  async getProjectOwners(projectId: string) {
    return this.db.query.projectOwners.findMany({
      where: eq(projectOwners.projectId, projectId),
      with: { user: true },
    });
  }

  async addProjectOwner(
    projectId: string,
    userId: string,
    role: 'owner' | 'editor' = 'editor',
  ) {
    // Verify project & user exist
    const project = await this.db.query.projects.findFirst({
      where: eq(projects.id, projectId),
    });
    if (!project) throw new NotFoundException('Project not found');

    const user = await this.db.query.users.findFirst({
      where: eq(users.id, userId),
    });
    if (!user) throw new NotFoundException('User not found');

    // Check if already exists
    const existing = await this.db.query.projectOwners.findFirst({
      where: and(
        eq(projectOwners.projectId, projectId),
        eq(projectOwners.userId, userId),
      ),
    });

    if (existing) {
      // Update role
      const [updated] = await this.db
        .update(projectOwners)
        .set({ role })
        .where(eq(projectOwners.id, existing.id))
        .returning();
      return updated;
    }

    const [created] = await this.db
      .insert(projectOwners)
      .values({ projectId, userId, role })
      .returning();
    return created;
  }

  async removeProjectOwner(projectId: string, userId: string) {
    const [deleted] = await this.db
      .delete(projectOwners)
      .where(
        and(
          eq(projectOwners.projectId, projectId),
          eq(projectOwners.userId, userId),
        ),
      )
      .returning();
    if (!deleted) throw new NotFoundException('Ownership record not found');
    return { deleted: true };
  }
}
