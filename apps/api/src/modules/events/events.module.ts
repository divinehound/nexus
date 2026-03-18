import { Module } from '@nestjs/common';
import { EventsController } from './events.controller';
import { EventsService } from './events.service';
import { TwitterSpacesCron } from './twitter-spaces.cron';

@Module({
  controllers: [EventsController],
  providers: [EventsService, TwitterSpacesCron],
  exports: [EventsService],
})
export class EventsModule {}
