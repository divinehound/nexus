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
 * An EVM scan saves its checkpoint (the last block read) only when it
 * finishes: one that dies part way starts again from the previous
 * checkpoint, or from block 0 (a full rebuild) if it never finished.
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
