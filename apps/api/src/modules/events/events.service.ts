import { Injectable, Inject } from '@nestjs/common';
import { eq, and } from 'drizzle-orm';
import { DATABASE_TOKEN } from '../../common/database/database.module';
import { type Database, events } from '@nexus/database';

@Injectable()
export class EventsService {
  constructor(@Inject(DATABASE_TOKEN) private readonly db: Database) {}

  async getByProjectId(projectId: string, status?: string) {
    if (status) {
      return this.db.query.events.findMany({
        where: and(eq(events.projectId, projectId), eq(events.status, status as 'upcoming' | 'live' | 'ended')),
        orderBy: (events, { asc }) => [asc(events.startTime)],
      });
    }
    return this.db.query.events.findMany({
      where: eq(events.projectId, projectId),
      orderBy: (events, { asc }) => [asc(events.startTime)],
    });
  }

  async getLiveEvents(projectId: string) {
    return this.db.query.events.findMany({
      where: and(eq(events.projectId, projectId), eq(events.status, 'live')),
    });
  }

  async submitEvent(
    projectId: string,
    data: { title: string; description?: string; eventType: string; startTime: string; link?: string; submittedBy: string },
  ) {
    const [event] = await this.db
      .insert(events)
      .values({
        projectId,
        title: data.title,
        description: data.description ?? null,
        eventType: data.eventType as 'spaces' | 'ama' | 'mint' | 'collab' | 'irl' | 'other',
        startTime: new Date(data.startTime),
        link: data.link ?? null,
        source: 'manual',
        submittedBy: data.submittedBy,
      })
      .returning();
    return event;
  }
}
