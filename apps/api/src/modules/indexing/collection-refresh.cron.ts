import { Inject, Injectable, Logger } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Cron, CronExpression } from '@nestjs/schedule';
import { Queue } from 'bullmq';
import { sql } from 'drizzle-orm';
import { type Database, serviceLevelEnum } from '@nexus/database';
import { DATABASE_TOKEN } from '../../common/database/database.module';
import { HOLDER_INDEXING_QUEUE } from '../../common/queue/queues';
import { chainIsOn } from './chain-switches';

export type ServiceLevel = (typeof serviceLevelEnum.enumValues)[number];
export const SERVICE_LEVELS = serviceLevelEnum.enumValues;

/** How long a collection's holder snapshot stays fresh at each level; dormant is never refreshed on its own. */
export const REFRESH_HOURS: Record<ServiceLevel, number | null> = {
  dormant: null,
  slow: 24 * 7,
  active: 24,
  hot: 6,
  premium: 1,
};

/** Most collections queued per hourly run, so one run can't spend a day's Alchemy budget. */
const MAX_PER_RUN = Number(process.env.COLLECTION_REFRESH_MAX_PER_RUN) || 100;
const HOLDER_CAP = 50000;

/**
 * Every hour, queues a holder snapshot for each collection whose service level says it is
 * due, most valuable level first and the stalest first within a level. Jobs go on the
 * holder indexing queue, so they share its 1/sec pacing with the admin backlog.
 */
@Injectable()
export class CollectionRefreshCron {
  private readonly logger = new Logger(CollectionRefreshCron.name);

  constructor(
    @Inject(DATABASE_TOKEN) private readonly db: Database,
    @InjectQueue(HOLDER_INDEXING_QUEUE) private readonly queue: Queue,
  ) {}

  @Cron(CronExpression.EVERY_HOUR)
  async run() {
    try {
      const queued = await this.queueDue();
      if (queued) this.logger.log(`Queued holder refreshes for ${queued} collections`);
    } catch (err) {
      this.logger.error(`Collection refresh failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  async queueDue(): Promise<number> {
    // A backlog run or the last hour's refreshes still waiting: skip this run rather than pile up.
    // A long backlog run therefore holds refreshes (premium too) until it drains.
    const counts = await this.queue.getJobCounts('waiting', 'delayed');
    if ((counts.waiting ?? 0) + (counts.delayed ?? 0) > 0) {
      this.logger.log('Holder indexing queue still busy; skipping this refresh run');
      return 0;
    }

    const due = sql.join(
      (Object.entries(REFRESH_HOURS) as [ServiceLevel, number | null][])
        .filter(([, hours]) => hours !== null)
        .map(
          ([level, hours]) =>
            sql`(c.service_level = ${level} AND (c.last_index_finished_at IS NULL OR c.last_index_finished_at < now() - make_interval(hours => ${hours})))`,
        ),
      sql` OR `,
    );
    const rows = [
      ...(await this.db.execute<{ id: string; name: string }>(sql`
        SELECT c.id, c.name
        FROM collections c
        WHERE c.service_level <> 'dormant'
          AND c.is_spam IS NOT TRUE
          AND c.verification_status != 'rejected'
          AND ${chainIsOn(sql`c.chain`)}
          -- Suppressed (spam-like) collections only refresh when an admin pinned a level.
          AND (c.service_level_pinned OR c.tracking_tier != 'suppressed')
          AND (${due})
          -- Over the holder cap last time: it would be skipped again, so leave it (the admin page shows "skipped").
          AND c.last_index_status IS DISTINCT FROM 'skipped'
        ORDER BY array_position(ARRAY['premium', 'hot', 'active', 'slow']::text[], c.service_level::text),
                 c.last_index_finished_at ASC NULLS FIRST
        LIMIT ${MAX_PER_RUN}
      `)),
    ];
    if (!rows.length) return 0;

    await this.queue.addBulk(
      rows.map((row) => ({
        name: 'refresh-holders',
        data: { collectionId: row.id, collectionName: row.name, maxHolders: HOLDER_CAP },
        opts: {
          // One refresh per collection in the queue at a time.
          jobId: `refresh-${row.id}`,
          attempts: 2,
          backoff: { type: 'exponential' as const, delay: 10_000 },
          removeOnComplete: true,
          removeOnFail: true,
        },
      })),
    );
    return rows.length;
  }
}
