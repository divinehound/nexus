import { Module } from '@nestjs/common';
import { AdminController } from './admin.controller';
import { AdminService } from './admin.service';
import { CollectionsModule } from '../collections/collections.module';
import { HoldingsModule } from '../holdings/holdings.module';
import { SearchModule } from '../search/search.module';

@Module({
  imports: [CollectionsModule, HoldingsModule, SearchModule],
  controllers: [AdminController],
  providers: [AdminService],
})
export class AdminModule {}
