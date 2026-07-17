import { Logger } from '@nestjs/common';
import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Job } from 'bullmq';
import { HOLDER_INDEXING_QUEUE } from '../../common/queue/queues';
import { HolderIndexerService } from './holder-indexer.service';

type HolderIndexingJobData = {
  collectionId: string;
  collectionName?: string;
  maxHolders?: number;
};

/**
 * Indexes one collection's holders per job. The limiter preserves the 1
 * collection/sec pacing the old in-process backlog loop applied to
 * Alchemy/Helius, now enforced across all producers of this queue.
 * Cap-exceeded skips resolve successfully (the collection is marked
 * 'skipped' in the DB); real failures throw so BullMQ retries them.
 */
@Processor(HOLDER_INDEXING_QUEUE, {
  concurrency: 1,
  limiter: { max: 1, duration: 1_000 },
})
export class HolderIndexingProcessor extends WorkerHost {
  private readonly logger = new Logger(HolderIndexingProcessor.name);

  constructor(private readonly holderIndexer: HolderIndexerService) {
    super();
  }

  async process(job: Job<HolderIndexingJobData>) {
    const { collectionId, collectionName, maxHolders } = job.data;
    this.logger.log(`Indexing holders for ${collectionName ?? collectionId}`);

    const result = await this.holderIndexer.indexCollectionHolders(collectionId, { maxHolders });

    if (!result.success && !result.skipped) {
      throw new Error(result.error || `Holder indexing failed for ${collectionId}`);
    }

    return result;
  }
}
