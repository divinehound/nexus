import { Injectable, Inject } from '@nestjs/common';
import { eq, and, gte, count } from 'drizzle-orm';
import { DATABASE_TOKEN } from '../../common/database/database.module';
import {
  type Database,
  collections,
  activityFeed,
  events,
  projects,
} from '@nexus/database';

@Injectable()
export class HealthScoreService {
  constructor(@Inject(DATABASE_TOKEN) private readonly db: Database) {}

  async computeHealthScore(projectId: string): Promise<number> {
    const scores = await Promise.all([
      this.holderScore(projectId),
      this.listedRatioScore(projectId),
      this.activityScore(projectId),
      this.eventScore(projectId),
    ]);

    // Weighted average: holders 30%, listing ratio 20%, activity 30%, events 20%
    const weights = [30, 20, 30, 20];
    const total = scores.reduce((sum, s, i) => sum + s * weights[i], 0) / 100;
    const finalScore = Math.min(100, Math.max(0, Math.round(total)));

    await this.db
      .update(projects)
      .set({ healthScore: finalScore })
      .where(eq(projects.id, projectId));

    return finalScore;
  }

  private async holderScore(projectId: string): Promise<number> {
    const projectCollections = await this.db.query.collections.findMany({
      where: eq(collections.projectId, projectId),
    });

    if (projectCollections.length === 0) return 0;

    const totalHolders = projectCollections.reduce(
      (sum, c) => sum + (c.holderCount ?? 0),
      0,
    );

    if (totalHolders > 1000) return Math.min(100, 70 + (totalHolders - 1000) / 100);
    if (totalHolders > 100) return 30 + ((totalHolders - 100) / 900) * 40;
    return (totalHolders / 100) * 30;
  }

  private async listedRatioScore(projectId: string): Promise<number> {
    const projectCollections = await this.db.query.collections.findMany({
      where: eq(collections.projectId, projectId),
    });

    if (projectCollections.length === 0) return 0;

    let totalListed = 0;
    let totalSupply = 0;
    for (const c of projectCollections) {
      totalListed += c.listedCount ?? 0;
      totalSupply += c.supply ?? 0;
    }

    if (totalSupply === 0) return 50;

    const listedRatio = totalListed / totalSupply;
    if (listedRatio <= 0.05) return 100;
    if (listedRatio <= 0.2) return 100 - ((listedRatio - 0.05) / 0.15) * 50;
    if (listedRatio <= 0.5) return 50 - ((listedRatio - 0.2) / 0.3) * 50;
    return 0;
  }

  private async activityScore(projectId: string): Promise<number> {
    const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    const result = await this.db
      .select({ count: count() })
      .from(activityFeed)
      .where(
        and(
          eq(activityFeed.projectId, projectId),
          gte(activityFeed.createdAt, weekAgo),
        ),
      );

    const activityCount = result[0]?.count ?? 0;
    if (activityCount >= 100) return 100;
    if (activityCount >= 50) return 80 + ((activityCount - 50) / 50) * 20;
    if (activityCount >= 10) return 50 + ((activityCount - 10) / 40) * 30;
    return (activityCount / 10) * 50;
  }

  private async eventScore(projectId: string): Promise<number> {
    const monthAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const result = await this.db
      .select({ count: count() })
      .from(events)
      .where(
        and(eq(events.projectId, projectId), gte(events.startTime, monthAgo)),
      );

    const eventCount = result[0]?.count ?? 0;
    if (eventCount >= 10) return 100;
    if (eventCount >= 5) return 80 + ((eventCount - 5) / 5) * 20;
    if (eventCount >= 2) return 50 + ((eventCount - 2) / 3) * 30;
    return (eventCount / 2) * 50;
  }
}
