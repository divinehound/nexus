import { Module } from '@nestjs/common';
import { HoldingsService } from './holdings.service';
import { BlockchainIndexerService } from './blockchain-indexer.service';
import { SearchModule } from '../search/search.module';

@Module({
  imports: [SearchModule],
  providers: [HoldingsService, BlockchainIndexerService],
  exports: [HoldingsService],
})
export class HoldingsModule {}
