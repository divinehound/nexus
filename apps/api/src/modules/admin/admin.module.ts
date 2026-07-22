import { Module } from '@nestjs/common';
import { AdminController } from './admin.controller';
import { AdminService } from './admin.service';
import { HolderHistoryService } from './holder-history.service';
import { HolderHistoryScanProcessor } from './holder-history-scan.processor';
import { PriceOracleService } from './price-oracle.service';
import { CollectionsModule } from '../collections/collections.module';
import { HoldingsModule } from '../holdings/holdings.module';
import { SearchModule } from '../search/search.module';
import { IndexingModule } from '../indexing/indexing.module';
import { QueueModule } from '../../common/queue/queue.module';

@Module({
  imports: [CollectionsModule, HoldingsModule, SearchModule, IndexingModule, QueueModule],
  controllers: [AdminController],
  providers: [AdminService, HolderHistoryService, HolderHistoryScanProcessor, PriceOracleService],
})
export class AdminModule {}
