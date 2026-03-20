import { Module } from '@nestjs/common';
import { CollectionsController } from './collections.controller';
import { CollectionsService } from './collections.service';
import { CollectionMetricsService } from './collection-metrics.service';

@Module({
  controllers: [CollectionsController],
  providers: [CollectionsService, CollectionMetricsService],
  exports: [CollectionsService, CollectionMetricsService],
})
export class CollectionsModule {}
