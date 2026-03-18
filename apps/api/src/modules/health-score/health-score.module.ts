import { Module } from '@nestjs/common';
import { HealthScoreService } from './health-score.service';
import { HealthScoreCron } from './health-score.cron';

@Module({
  providers: [HealthScoreService, HealthScoreCron],
  exports: [HealthScoreService],
})
export class HealthScoreModule {}
