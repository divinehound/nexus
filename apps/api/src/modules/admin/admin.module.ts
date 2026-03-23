import { Module } from '@nestjs/common';
import { AdminController } from './admin.controller';
import { AdminService } from './admin.service';
import { CollectionsModule } from '../collections/collections.module';
import { HoldingsModule } from '../holdings/holdings.module';
import { SearchModule } from '../search/search.module';
import { IndexingModule } from '../indexing/indexing.module';

@Module({
  imports: [CollectionsModule, HoldingsModule, SearchModule, IndexingModule],
  controllers: [AdminController],
  providers: [AdminService],
})
export class AdminModule {}
