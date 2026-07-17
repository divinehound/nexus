import { Module } from '@nestjs/common';
import { HoldingsService } from './holdings.service';
import { BlockchainIndexerService } from './blockchain-indexer.service';
import { WalletIndexingProcessor } from './wallet-indexing.processor';
import { SearchModule } from '../search/search.module';
import { QueueModule } from '../../common/queue/queue.module';

@Module({
  imports: [SearchModule, QueueModule],
  providers: [HoldingsService, BlockchainIndexerService, WalletIndexingProcessor],
  exports: [HoldingsService],
})
export class HoldingsModule {}
