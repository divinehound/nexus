import { Module } from '@nestjs/common';
import { HolderIndexerService } from './holder-indexer.service';
import { HolderSnapshotService } from './holder-snapshot.service';
import { SpamCheckerService } from './spam-checker.service';

@Module({
  providers: [HolderIndexerService, HolderSnapshotService, SpamCheckerService],
  exports: [HolderIndexerService, HolderSnapshotService, SpamCheckerService],
})
export class IndexingModule {}
