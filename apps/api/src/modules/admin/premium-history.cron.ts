import { Inject, Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { sql } from 'drizzle-orm';
import { type Database } from '@nexus/database';
import { DATABASE_TOKEN } from '../../common/database/database.module';
import { chainIsOn } from '../indexing/chain-switches';
import { HolderHistoryService } from './holder-history.service';

/**
 * Every night at 02:00 UTC, queues a holder history scan for each Premium collection. A scan
 * picks up from the last block it read, so a nightly one reads only the day's new transfers;
 * a Premium collection that was never scanned gets its full history once. Scans run one at a
 * time on the holder history queue, the same as the admin Scan button.
 */
@Injectable()
export class PremiumHistoryCron {
  private readonly logger = new Logger(PremiumHistoryCron.name);

  constructor(
    @Inject(DATABASE_TOKEN) private readonly db: Database,
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
      ...(await this.db.execute<{ id: string }>(sql`
        SELECT c.id FROM collections c
        WHERE c.service_level = 'premium'
          AND c.is_spam IS NOT TRUE
          AND c.verification_status != 'rejected'
          AND ${chainIsOn(sql`c.chain`)}
          -- Scanned in the last 12 hours (by hand, say): leave it until tomorrow.
          AND (c.holder_history_last_scanned_at IS NULL OR c.holder_history_last_scanned_at < now() - interval '12 hours')
        ORDER BY c.holder_history_last_scanned_at ASC NULLS FIRST`)),
    ];
    let queued = 0;
    for (const row of rows) {
      try {
        const res = await this.history.queueCollectionHolderHistoryScan(row.id);
        if (!res.alreadyRunning) queued++;
      } catch (err) {
        this.logger.warn(`Could not queue holder history for ${row.id}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    return queued;
  }
}
