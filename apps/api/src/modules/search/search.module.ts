import { Module } from '@nestjs/common';
import { SearchController } from './search.controller';
import { SearchService } from './search.service';
import { BlockchainLookupService } from './blockchain-lookup.service';
import { CollectionImportService } from './collection-import.service';

@Module({
  controllers: [SearchController],
  providers: [SearchService, BlockchainLookupService, CollectionImportService],
  exports: [SearchService, BlockchainLookupService, CollectionImportService],
})
export class SearchModule {}
