import { Injectable, Logger, Inject } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { ConfigService } from '@nestjs/config';
import { eq, and, isNotNull } from 'drizzle-orm';
import { DATABASE_TOKEN } from '../../common/database/database.module';
import { type Database, projects, events } from '@nexus/database';

interface TwitterSpaceResponse {
  data?: {
    id: string;
    state: 'live' | 'scheduled' | 'ended';
    title: string;
    scheduled_start?: string;
    started_at?: string;
  }[];
}

@Injectable()
export class TwitterSpacesCron {
  private readonly logger = new Logger(TwitterSpacesCron.name);

  constructor(
    @Inject(DATABASE_TOKEN) private readonly db: Database,
    private readonly config: ConfigService,
  ) {}

  @Cron(CronExpression.EVERY_5_MINUTES)
  async pollLiveSpaces() {
    const bearerToken = this.config.get<string>('twitter.bearerToken');
    if (!bearerToken) {
      this.logger.warn('TWITTER_BEARER_TOKEN not set — skipping spaces poll');
      return;
    }

    // Get all projects that have a Twitter ID
    const projectsWithTwitter = await this.db.query.projects.findMany({
      where: isNotNull(projects.twitterId),
    });

    if (projectsWithTwitter.length === 0) return;

    for (const project of projectsWithTwitter) {
      try {
        await this.checkSpacesForProject(project, bearerToken);
      } catch (err) {
        this.logger.error(
          `Failed to poll spaces for ${project.slug}: ${err}`,
        );
      }
    }
  }

  private async checkSpacesForProject(
    project: { id: string; twitterId: string | null; slug: string },
    bearerToken: string,
  ) {
    if (!project.twitterId) return;

    const url = `https://api.twitter.com/2/spaces/by/creator_ids?user_ids=${project.twitterId}&space.fields=title,state,scheduled_start,started_at`;

    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${bearerToken}` },
    });

    if (!res.ok) {
      this.logger.warn(`Twitter API ${res.status} for ${project.slug}`);
      return;
    }

    const body = (await res.json()) as TwitterSpaceResponse;
    if (!body.data?.length) return;

    for (const space of body.data) {
      // Skip already-tracked spaces
      const existing = await this.db.query.events.findFirst({
        where: and(
          eq(events.projectId, project.id),
          eq(events.twitterSpaceId, space.id),
        ),
      });

      if (existing) {
        // Update status if changed
        const newStatus =
          space.state === 'live'
            ? 'live'
            : space.state === 'ended'
              ? 'ended'
              : 'upcoming';
        if (existing.status !== newStatus) {
          await this.db
            .update(events)
            .set({ status: newStatus })
            .where(eq(events.id, existing.id));
          this.logger.log(
            `Updated space ${space.id} status → ${newStatus}`,
          );
        }
        continue;
      }

      // Insert new space event
      await this.db.insert(events).values({
        projectId: project.id,
        title: space.title || 'Twitter Space',
        eventType: 'spaces',
        startTime: new Date(space.started_at ?? space.scheduled_start ?? Date.now()),
        source: 'auto_twitter',
        twitterSpaceId: space.id,
        link: `https://twitter.com/i/spaces/${space.id}`,
        status: space.state === 'live' ? 'live' : 'upcoming',
      });

      this.logger.log(
        `Discovered new space "${space.title}" for ${project.slug}`,
      );
    }
  }
}
