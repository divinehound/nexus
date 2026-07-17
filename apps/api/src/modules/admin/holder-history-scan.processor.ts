import { Logger } from '@nestjs/common';
import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Job } from 'bullmq';
import { HOLDER_HISTORY_SCAN_QUEUE } from '../../common/queue/queues';
import { HolderHistoryService } from './holder-history.service';

type HolderHistoryScanJobData = {
  collectionId: string;
  fromBlock?: number;
};

/**
 * Runs holder-history scans (EVM transfer backfill / Solana hybrid scan) one
 * at a time — they are the heaviest external-API workloads in the system.
 * The scan itself checkpoints progress in the DB, so a scan that dies with
 * the process resumes from its last checkpoint when re-queued.
 */
@Processor(HOLDER_HISTORY_SCAN_QUEUE, { concurrency: 1 })
export class HolderHistoryScanProcessor extends WorkerHost {
  private readonly logger = new Logger(HolderHistoryScanProcessor.name);

  constructor(private readonly holderHistoryService: HolderHistoryService) {
    super();
  }

  async process(job: Job<HolderHistoryScanJobData>): Promise<void> {
    const { collectionId, fromBlock } = job.data;
    this.logger.log(`Starting holder history scan for ${collectionId} from block ${fromBlock ?? 0}`);
    await this.holderHistoryService.runCollectionHolderHistoryScan(collectionId, fromBlock);
  }
}
