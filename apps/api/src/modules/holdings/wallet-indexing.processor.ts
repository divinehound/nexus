import { Logger } from '@nestjs/common';
import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Job } from 'bullmq';
import { WALLET_INDEXING_QUEUE } from '../../common/queue/queues';
import { HoldingsService } from './holdings.service';

const CONCURRENCY = parseInt(process.env.WALLET_INDEXING_CONCURRENCY || '2', 10);

/**
 * Executes wallet holdings-refresh jobs. Each job references a row in
 * wallet_indexing_jobs by id; runIndexingJob keeps that row (and the wallet's
 * index-status columns) in sync, so the admin UI keeps working unchanged.
 * Throwing here lets BullMQ apply the retry/backoff policy set at enqueue.
 */
@Processor(WALLET_INDEXING_QUEUE, { concurrency: CONCURRENCY })
export class WalletIndexingProcessor extends WorkerHost {
  private readonly logger = new Logger(WalletIndexingProcessor.name);

  constructor(private readonly holdingsService: HoldingsService) {
    super();
  }

  async process(job: Job<{ jobId: string }>): Promise<void> {
    this.logger.log(
      `Running wallet indexing job ${job.data.jobId} (attempt ${job.attemptsMade + 1})`,
    );
    await this.holdingsService.runIndexingJob(job.data.jobId);
  }
}
