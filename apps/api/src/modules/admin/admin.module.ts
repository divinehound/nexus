import { Module } from '@nestjs/common';
import { AdminController } from './admin.controller';
import { AdminService } from './admin.service';
import { CollectionsModule } from '../collections/collections.module';
import { HoldingsModule } from '../holdings/holdings.module';

@Module({
  imports: [CollectionsModule, HoldingsModule],
  controllers: [AdminController],
  providers: [AdminService],
})
export class AdminModule {}
