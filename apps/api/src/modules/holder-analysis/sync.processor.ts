import { Injectable, Logger } from '@nestjs/common';
import { InjectQueue, Processor, WorkerHost } from '@nestjs/bullmq';
import { Cron, CronExpression } from '@nestjs/schedule';
import { Job, Queue } from 'bullmq';
import { HOLDER_ANALYSIS_SYNC_QUEUE } from '../../common/queue/queues';
import { HolderAnalysisSyncService, type SyncLog } from './sync.service';

/** One sync job at a time across every API instance: a run started while another is going is dropped. */
const SYNC_JOB_ID = 'holder-analysis-sync';

/** Queues a sync every 10 minutes; the run does nothing when no project has the analysis turned on. */
@Injectable()
export class HolderAnalysisSyncCron {
  constructor(@InjectQueue(HOLDER_ANALYSIS_SYNC_QUEUE) private readonly queue: Queue) {}

  @Cron(CronExpression.EVERY_10_MINUTES)
  async tick() {
    await this.enqueue();
  }

  /** Returns false when a run is already queued or going (the new one is then dropped). */
  async enqueue(): Promise<boolean> {
    const busy = (await this.queue.getActiveCount()) + (await this.queue.getWaitingCount()) > 0;
    await this.queue.add('sync', {}, { deduplication: { id: SYNC_JOB_ID }, attempts: 1 });
    return !busy;
  }
}

@Processor(HOLDER_ANALYSIS_SYNC_QUEUE, { concurrency: 1 })
export class HolderAnalysisSyncProcessor extends WorkerHost {
  private readonly logger = new Logger(HolderAnalysisSyncProcessor.name);

  constructor(private readonly sync: HolderAnalysisSyncService) {
    super();
  }

  async process(_job: Job): Promise<SyncLog> {
    const started = Date.now();
    const log = await this.sync.runSync();
    if (log.calls || log.errors.length)
      this.logger.log(
        `Holder analysis sync: ${log.calls} calls, ${log.transfers} transfers, ${log.txs} txs, ${log.wallets} wallets, ` +
          `${log.delegations} delegations, ${log.refreshed} refreshed, ${log.names} names, ${log.usage} usage in ${Date.now() - started} ms` +
          (log.errors.length ? `; ${log.errors.join('; ')}` : ''),
      );
    return log;
  }
}
