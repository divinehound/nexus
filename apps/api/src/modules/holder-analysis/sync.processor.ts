import { Injectable, Logger } from '@nestjs/common';
import { InjectQueue, Processor, WorkerHost } from '@nestjs/bullmq';
import { Cron, CronExpression } from '@nestjs/schedule';
import { Job, Queue } from 'bullmq';
import { HOLDER_ANALYSIS_SYNC_QUEUE } from '../../common/queue/queues';
import { HolderAnalysisReportService } from './report.service';
import { HolderAnalysisSyncService } from './sync.service';

/**
 * Every holder analysis job goes through one queue with concurrency 1, so a sync and an analysis
 * never write at once: 'sync' (every 10 minutes, then analyses projects whose report is out of
 * date), 'analyse-all' (daily) and 'analyse' (one project, on demand).
 */
type JobData = { projectId?: string };

@Injectable()
export class HolderAnalysisSyncCron {
  constructor(@InjectQueue(HOLDER_ANALYSIS_SYNC_QUEUE) private readonly queue: Queue) {}

  @Cron(CronExpression.EVERY_10_MINUTES)
  async tick() {
    await this.enqueue();
  }

  /** Daily, after the night's transfers: every project again, so statuses age even without new transfers. */
  @Cron('30 5 * * *', { timeZone: 'UTC' })
  async daily() {
    await this.queue.add('analyse-all', {}, { deduplication: { id: 'holder-analysis-daily' }, attempts: 1 });
  }

  /** Queues a sync; false when one is already queued or going (the new one is then dropped). */
  async enqueue(): Promise<boolean> {
    const busy = await this.isQueued('sync');
    await this.queue.add('sync', {}, { deduplication: { id: 'holder-analysis-sync' }, attempts: 1 });
    return !busy;
  }

  /**
   * Queues one project's analysis; false when one is already waiting (it will see the latest
   * labels and unlinks). One that's already running may have read them before a change, so it
   * doesn't count.
   */
  async enqueueAnalysis(projectId: string): Promise<boolean> {
    if (await this.isQueued('analyse', projectId, ['waiting', 'delayed', 'prioritized'])) return false;
    await this.queue.add('analyse', { projectId }, { attempts: 1 });
    return true;
  }

  private async isQueued(name: string, projectId?: string, states: ('active' | 'waiting' | 'delayed' | 'prioritized')[] = ['active', 'waiting', 'delayed', 'prioritized']) {
    const jobs = await this.queue.getJobs(states);
    return jobs.some((j) => j?.name === name && (projectId === undefined || (j.data as JobData)?.projectId === projectId));
  }
}

// analyze() runs on the event loop and can hold it for a while on a big project, which stops the
// job's lock being renewed: a long lock keeps the job from being taken for stalled meanwhile.
@Processor(HOLDER_ANALYSIS_SYNC_QUEUE, { concurrency: 1, lockDuration: 10 * 60_000 })
export class HolderAnalysisSyncProcessor extends WorkerHost {
  private readonly logger = new Logger(HolderAnalysisSyncProcessor.name);

  constructor(
    private readonly sync: HolderAnalysisSyncService,
    private readonly reports: HolderAnalysisReportService,
  ) {
    super();
  }

  async process(job: Job<JobData>): Promise<unknown> {
    if (job.name === 'analyse' && job.data.projectId) {
      const out = await this.reports.analyseOne(job.data.projectId);
      this.logger.log(`Holder analysis of ${job.data.projectId}: ${JSON.stringify(out)}`);
      return out;
    }
    if (job.name === 'analyse-all') {
      const out = await this.reports.analyseDue({ changedOnly: false });
      if (Object.keys(out).length) this.logger.log(`Daily holder analysis: ${JSON.stringify(out)}`);
      return out;
    }
    const started = Date.now();
    const log = await this.sync.runSync();
    if (log.calls || log.errors.length)
      this.logger.log(
        `Holder analysis sync: ${log.calls} calls, ${log.transfers} transfers, ${log.txs} txs, ${log.wallets} wallets, ` +
          `${log.delegations} delegations, ${log.refreshed} refreshed, ${log.names} names, ${log.usage} usage in ${Date.now() - started} ms` +
          (log.errors.length ? `; ${log.errors.join('; ')}` : ''),
      );
    // A project turned on, changed, or with new transfers doesn't wait for the daily run.
    const analysed = await this.reports.analyseDue({ changedOnly: true });
    if (Object.keys(analysed).length) this.logger.log(`Holder analysis: ${JSON.stringify(analysed)}`);
    return { sync: log, analysed };
  }
}
