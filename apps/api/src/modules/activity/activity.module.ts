import { Module } from '@nestjs/common';
import { ActivityController } from './activity.controller';
import { ActivityService } from './activity.service';
import { HolderVerificationService } from './holder-verification.service';

@Module({
  controllers: [ActivityController],
  providers: [ActivityService, HolderVerificationService],
  exports: [ActivityService],
})
export class ActivityModule {}
