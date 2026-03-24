import { Module } from '@nestjs/common';
import { HolderIndexerService } from './holder-indexer.service';
import { HolderSnapshotService } from './holder-snapshot.service';
import { SpamCheckerService } from './spam-checker.service';
import { CollectionDiscoveryService } from './collection-discovery.service';
import { SearchModule } from '../search/search.module';

@Module({
  imports: [SearchModule],
  providers: [HolderIndexerService, HolderSnapshotService, SpamCheckerService, CollectionDiscoveryService],
  exports: [HolderIndexerService, HolderSnapshotService, SpamCheckerService, CollectionDiscoveryService],
})
export class IndexingModule {}
