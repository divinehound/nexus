import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { and, asc, desc, eq, gte } from 'drizzle-orm';
import { DATABASE_TOKEN } from '../../common/database/database.module';
import { type Database, collections, marketSnapshots, projects } from '@nexus/database';

const STALE_THRESHOLD_MS = 6 * 60 * 60 * 1000;
const HISTORY_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

@Injectable()
export class CollectionMetricsService {
  constructor(@Inject(DATABASE_TOKEN) private readonly db: Database) {}

  private async setCollectionIndexStatus(
    collectionId: string,
    input: {
      startedAt?: Date | null;
      finishedAt?: Date | null;
      status?: 'queued' | 'running' | 'done' | 'failed' | null;
      error?: string | null;
      jobId?: string | null;
    },
  ) {
    await this.db
      .update(collections)
      .set({
        ...(input.startedAt !== undefined ? { lastIndexStartedAt: input.startedAt } : {}),
        ...(input.finishedAt !== undefined ? { lastIndexFinishedAt: input.finishedAt } : {}),
        ...(input.status !== undefined ? { lastIndexStatus: input.status } : {}),
        ...(input.error !== undefined ? { lastIndexError: input.error } : {}),
        ...(input.jobId !== undefined ? { lastIndexJobId: input.jobId } : {}),
      })
      .where(eq(collections.id, collectionId));
  }

  private async setProjectIndexStatus(
    projectId: string,
    input: {
      startedAt?: Date | null;
      finishedAt?: Date | null;
      status?: 'queued' | 'running' | 'done' | 'failed' | null;
      error?: string | null;
      jobId?: string | null;
    },
  ) {
    await this.db
      .update(projects)
      .set({
        ...(input.startedAt !== undefined ? { lastIndexStartedAt: input.startedAt } : {}),
        ...(input.finishedAt !== undefined ? { lastIndexFinishedAt: input.finishedAt } : {}),
        ...(input.status !== undefined ? { lastIndexStatus: input.status } : {}),
        ...(input.error !== undefined ? { lastIndexError: input.error } : {}),
        ...(input.jobId !== undefined ? { lastIndexJobId: input.jobId } : {}),
      })
      .where(eq(projects.id, projectId));
  }

  async getCollectionStats(collectionId: string) {
    const latest = await this.db.query.marketSnapshots.findFirst({
      where: eq(marketSnapshots.collectionId, collectionId),
      orderBy: [desc(marketSnapshots.timestamp)],
    });

    if (!latest) {
      return {
        collectionId,
        status: 'indexing' as const,
        lastUpdatedAt: null,
        current: null,
        deltas: {},
        history7d: [],
      };
    }

    const dayAgo = new Date(latest.timestamp.getTime() - 24 * 60 * 60 * 1000);

    const previous24h = await this.db.query.marketSnapshots.findFirst({
      where: and(
        eq(marketSnapshots.collectionId, collectionId),
        gte(marketSnapshots.timestamp, dayAgo),
      ),
      orderBy: [asc(marketSnapshots.timestamp)],
    });

    const historySince = new Date(Date.now() - HISTORY_WINDOW_MS);
    const historyRows = await this.db.query.marketSnapshots.findMany({
      where: and(
        eq(marketSnapshots.collectionId, collectionId),
        gte(marketSnapshots.timestamp, historySince),
      ),
      orderBy: [asc(marketSnapshots.timestamp)],
    });

    const floor24hPct = this.computePercentDelta(
      previous24h?.floorPrice ?? null,
      latest.floorPrice ?? null,
    );
    const volume24hPct = this.computePercentDelta(
      previous24h?.volume24h ?? null,
      latest.volume24h ?? null,
    );

    const holders24hDelta =
      previous24h?.holderCount != null && latest.holderCount != null
        ? latest.holderCount - previous24h.holderCount
        : undefined;

    const status =
      Date.now() - latest.timestamp.getTime() > STALE_THRESHOLD_MS ? 'stale' : 'ready';

    return {
      collectionId,
      status,
      lastUpdatedAt: latest.timestamp,
      current: {
        floorPrice: latest.floorPrice,
        listedCount: latest.listedCount,
        holderCount: latest.holderCount,
        volume1h: latest.volume1h,
        volume24h: latest.volume24h,
        volume7d: latest.volume7d,
        sales24h: latest.sales24h,
        uniqueBuyers24h: latest.uniqueBuyers24h,
      },
      deltas: {
        ...(floor24hPct !== undefined ? { floor24hPct } : {}),
        ...(volume24hPct !== undefined ? { volume24hPct } : {}),
        ...(holders24hDelta !== undefined ? { holders24hDelta } : {}),
      },
      history7d: historyRows.map((row) => ({
        timestamp: row.timestamp,
        floorPrice: row.floorPrice,
        volume24h: row.volume24h,
        holderCount: row.holderCount,
      })),
    };
  }

  async refreshTrackedCollectionsMetrics() {
    const trackedCollections = await this.db.query.collections.findMany();

    let refreshed = 0;
    for (const collection of trackedCollections) {
      await this.refreshCollectionMetricsNow(collection.id);
      refreshed += 1;
    }

    return {
      refreshed,
      totalTracked: trackedCollections.length,
      timestamp: new Date().toISOString(),
    };
  }

  async refreshCollectionMetricsNow(collectionId: string) {
    const collection = await this.db.query.collections.findFirst({ where: eq(collections.id, collectionId) });
    if (!collection) throw new NotFoundException('Collection not found');

    const jobId = randomUUID();
    const startedAt = new Date();

    await this.setCollectionIndexStatus(collectionId, {
      startedAt,
      finishedAt: null,
      status: 'running',
      error: null,
      jobId,
    });

    try {
      const generated = this.generateDeterministicSnapshot(collection.id, {
        floorPrice: collection.floorPrice,
        holderCount: collection.holderCount,
        listedCount: collection.listedCount,
      });

      const now = new Date();
      await this.db.insert(marketSnapshots).values({
        collectionId: collection.id,
        timestamp: now,
        floorPrice: generated.floorPrice,
        listedCount: generated.listedCount,
        holderCount: generated.holderCount,
        volume1h: generated.volume1h,
        volume24h: generated.volume24h,
        volume7d: generated.volume7d,
        sales24h: generated.sales24h,
        uniqueBuyers24h: generated.uniqueBuyers24h,
      });

      await this.setCollectionIndexStatus(collectionId, {
        finishedAt: now,
        status: 'done',
        error: null,
        jobId,
      });

      return { queued: true, jobId, entityType: 'collection' as const, entityId: collectionId };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown indexing error';
      const finishedAt = new Date();
      await this.setCollectionIndexStatus(collectionId, {
        finishedAt,
        status: 'failed',
        error: message,
        jobId,
      });
      throw error;
    }
  }

  async refreshProjectMetricsNow(projectId: string) {
    const project = await this.db.query.projects.findFirst({ where: eq(projects.id, projectId) });
    if (!project) throw new NotFoundException('Project not found');

    const projectJobId = randomUUID();
    const startedAt = new Date();
    await this.setProjectIndexStatus(projectId, {
      startedAt,
      finishedAt: null,
      status: 'running',
      error: null,
      jobId: projectJobId,
    });

    try {
      const projectCollections = await this.db.query.collections.findMany({ where: eq(collections.projectId, projectId) });

      for (const collection of projectCollections) {
        await this.refreshCollectionMetricsNow(collection.id);
      }

      const finishedAt = new Date();
      await this.setProjectIndexStatus(projectId, {
        finishedAt,
        status: 'done',
        error: null,
        jobId: projectJobId,
      });

      return { queued: true, jobId: projectJobId, entityType: 'project' as const, entityId: projectId };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown indexing error';
      const finishedAt = new Date();
      await this.setProjectIndexStatus(projectId, {
        finishedAt,
        status: 'failed',
        error: message,
        jobId: projectJobId,
      });
      throw error;
    }
  }

  private generateDeterministicSnapshot(
    collectionId: string,
    base: {
      floorPrice: number | null;
      holderCount: number | null;
      listedCount: number | null;
    },
  ) {
    const hourBucket = Math.floor(Date.now() / (60 * 60 * 1000));
    const seed = this.hash(`${collectionId}:${hourBucket}`);

    const floorBase = base.floorPrice ?? ((seed % 8000) + 1000) / 10_000;
    const holderBase = base.holderCount ?? 100 + (seed % 2_500);
    const listedBase = base.listedCount ?? Math.max(5, Math.floor(holderBase * 0.06));

    const floorPrice = Number((floorBase * (0.985 + (seed % 30) / 1000)).toFixed(6));
    const holderCount = Math.max(1, holderBase + ((seed % 17) - 8));
    const listedCount = Math.max(0, listedBase + ((seed % 9) - 4));

    const volume24h = Number((floorPrice * Math.max(5, listedCount) * (1.2 + (seed % 11) / 10)).toFixed(4));
    const volume1h = Number((volume24h / (18 + (seed % 12))).toFixed(4));
    const volume7d = Number((volume24h * (5.4 + (seed % 9) / 10)).toFixed(4));
    const sales24h = Math.max(1, Math.round(listedCount * (0.18 + (seed % 14) / 100)));
    const uniqueBuyers24h = Math.max(1, Math.min(sales24h, Math.round(sales24h * (0.62 + (seed % 21) / 100))));

    return {
      floorPrice,
      holderCount,
      listedCount,
      volume1h,
      volume24h,
      volume7d,
      sales24h,
      uniqueBuyers24h,
    };
  }

  private hash(input: string): number {
    let hash = 0;
    for (let i = 0; i < input.length; i += 1) {
      hash = (hash << 5) - hash + input.charCodeAt(i);
      hash |= 0;
    }
    return Math.abs(hash);
  }

  private computePercentDelta(previous: number | null, current: number | null) {
    if (previous === null || current === null || previous === 0) {
      return undefined;
    }

    return Number((((current - previous) / previous) * 100).toFixed(2));
  }
}
