import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import {
  COLLECTION_DISCOVERY_QUEUE,
  HOLDER_HISTORY_SCAN_QUEUE,
  HOLDER_INDEXING_QUEUE,
  WALLET_INDEXING_QUEUE,
} from './queues';

/**
 * Registers all BullMQ queues and re-exports them so any feature module can
 * inject a producer via @InjectQueue(...). The Redis connection itself is
 * configured once in AppModule via BullModule.forRootAsync.
 */
@Module({
  imports: [
    BullModule.registerQueue(
      { name: WALLET_INDEXING_QUEUE },
      { name: HOLDER_INDEXING_QUEUE },
      { name: COLLECTION_DISCOVERY_QUEUE },
      { name: HOLDER_HISTORY_SCAN_QUEUE },
    ),
  ],
  exports: [BullModule],
})
export class QueueModule {}
