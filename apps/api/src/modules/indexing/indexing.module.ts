import { Module } from '@nestjs/common';
import { HolderIndexerService } from './holder-indexer.service';
import { HolderSnapshotService } from './holder-snapshot.service';

@Module({
  providers: [HolderIndexerService, HolderSnapshotService],
  exports: [HolderIndexerService, HolderSnapshotService],
})
export class IndexingModule {}
