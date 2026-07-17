import { Logger } from '@nestjs/common';
import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Job } from 'bullmq';
import { COLLECTION_DISCOVERY_QUEUE } from '../../common/queue/queues';
import { CollectionDiscoveryService, DiscoveryOptions } from './collection-discovery.service';

type CollectionDiscoveryJobData = {
  collectionId: string;
  options?: DiscoveryOptions;
};

/**
 * Runs holder-graph discovery for one source collection per job. Discovery is
 * the heaviest external-API consumer (one call per holder), so concurrency
 * stays at 1; the service's own checkpointing handles resume after a crash.
 */
@Processor(COLLECTION_DISCOVERY_QUEUE, { concurrency: 1 })
export class CollectionDiscoveryProcessor extends WorkerHost {
  private readonly logger = new Logger(CollectionDiscoveryProcessor.name);

  constructor(private readonly collectionDiscovery: CollectionDiscoveryService) {
    super();
  }

  async process(job: Job<CollectionDiscoveryJobData>): Promise<void> {
    const { collectionId, options } = job.data;
    this.logger.log(`Running collection discovery for ${collectionId}`);
    await this.collectionDiscovery.discoverFromCollection(collectionId, options);
  }
}
