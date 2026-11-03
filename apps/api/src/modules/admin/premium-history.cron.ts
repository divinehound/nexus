import { Inject, Injectable, Logger } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Cron } from '@nestjs/schedule';
import { Queue } from 'bullmq';
import { sql } from 'drizzle-orm';
import { type Database } from '@nexus/database';
import { DATABASE_TOKEN } from '../../common/database/database.module';
import { HOLDER_HISTORY_SCAN_QUEUE } from '../../common/queue/queues';
import { chainIsOn } from '../indexing/chain-switches';
import { HolderHistoryService } from './holder-history.service';

/** Most Premium collections queued per night, as a cost backstop. */
const MAX_PER_RUN = Number(process.env.PREMIUM_HISTORY_MAX_PER_RUN) || 25;
/** Failed incremental scans in a row before the nightly run stops retrying (an admin Scan resets it). */
const MAX_FAILURES = 3;
/** BullMQ runs lower numbers first and unprioritised jobs before any: admin Scans go ahead of these. */
const NIGHTLY_PRIORITY = 10;

/**
 * Every night at 02:00 UTC, queues a holder history scan for each Premium EVM collection.
 * A scan picks up from the last block it read, so a nightly one reads only the day's new
 * transfers; a Premium collection never scanned gets its full history once.
 *
 * Left out:
 * - Solana: its scan revisits every mint and rebuilds all history each time;
 * - ERC-1155: the EVM scan reads ERC-721 transfers only;
 * - a first full scan that failed (retrying would wipe and restart it every night; an admin
 *   can run it by hand), and incremental scans that failed 3 nights running.
 *
 * Every API instance runs this; the queue's per-collection deduplication keeps one job each.
 */
@Injectable()
export class PremiumHistoryCron {
  private readonly logger = new Logger(PremiumHistoryCron.name);

  constructor(
    @Inject(DATABASE_TOKEN) private readonly db: Database,
    @InjectQueue(HOLDER_HISTORY_SCAN_QUEUE) private readonly queue: Queue,
    private readonly history: HolderHistoryService,
  ) {}

  @Cron('0 2 * * *', { timeZone: 'UTC' })
  async nightly() {
    try {
      const queued = await this.queueDue();
      if (queued) this.logger.log(`Queued nightly holder history scans for ${queued} Premium collections`);
    } catch (err) {
      this.logger.error(`Premium holder history run failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  async queueDue(): Promise<number> {
    const rows = [
      ...(await this.db.execute<{ id: string; from_block: number }>(sql`
        SELECT c.id, coalesce(c.holder_history_last_checked_block + 1, 0)::bigint AS from_block
        FROM collections c
        WHERE c.service_level = 'premium'
          AND c.chain <> 'solana'
          AND c.collection_type <> 'erc1155'
          AND c.is_spam IS NOT TRUE
          AND c.verification_status != 'rejected'
          AND ${chainIsOn(sql`c.chain`)}
          -- Scanned in the last 12 hours (by hand, say): leave it until tomorrow.
          AND (c.holder_history_last_scanned_at IS NULL OR c.holder_history_last_scanned_at < now() - interval '12 hours')
          -- (status is NULL until the first scan: IS DISTINCT FROM keeps those in)
          AND NOT (c.holder_history_status IS NOT DISTINCT FROM 'failed'
                   AND (c.holder_history_last_checked_block IS NULL OR c.holder_history_failures >= ${MAX_FAILURES}))
        ORDER BY c.holder_history_last_scanned_at ASC NULLS FIRST
        LIMIT ${MAX_PER_RUN}`)),
    ];
    let queued = 0;
    for (const row of rows) {
      try {
        if (await this.history.hasLiveScan(row.id)) continue;
        await this.queue.add(
          'scan',
          { collectionId: row.id, fromBlock: Number(row.from_block) },
          { deduplication: { id: row.id }, priority: NIGHTLY_PRIORITY },
        );
        queued++;
      } catch (err) {
        this.logger.warn(`Could not queue holder history for ${row.id}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    return queued;
  }
}
