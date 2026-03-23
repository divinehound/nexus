import { Module } from '@nestjs/common';
import { HolderIndexerService } from './holder-indexer.service';

@Module({
  providers: [HolderIndexerService],
  exports: [HolderIndexerService],
})
export class IndexingModule {}
