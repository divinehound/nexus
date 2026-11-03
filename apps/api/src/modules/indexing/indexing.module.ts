import { Module } from '@nestjs/common';
import { HolderIndexerService } from './holder-indexer.service';
import { HolderIndexingProcessor } from './holder-indexing.processor';
import { HolderSnapshotService } from './holder-snapshot.service';
import { SpamCheckerService } from './spam-checker.service';
import { CollectionDiscoveryService } from './collection-discovery.service';
import { CollectionDiscoveryProcessor } from './collection-discovery.processor';
import { RetentionCron } from './retention.cron';
import { CollectionRefreshCron } from './collection-refresh.cron';
import { ServiceLevelCheckCron, ServiceLevelCheckProcessor, ServiceLevelCheckService } from './service-level-check';
import { SearchModule } from '../search/search.module';
import { QueueModule } from '../../common/queue/queue.module';

@Module({
  imports: [SearchModule, QueueModule],
  providers: [
    HolderIndexerService,
    HolderIndexingProcessor,
    HolderSnapshotService,
    SpamCheckerService,
    CollectionDiscoveryService,
    CollectionDiscoveryProcessor,
    RetentionCron,
    CollectionRefreshCron,
    ServiceLevelCheckService,
    ServiceLevelCheckCron,
    ServiceLevelCheckProcessor,
  ],
  exports: [ServiceLevelCheckCron, HolderIndexerService, HolderSnapshotService, SpamCheckerService, CollectionDiscoveryService, QueueModule],
})
export class IndexingModule {}
