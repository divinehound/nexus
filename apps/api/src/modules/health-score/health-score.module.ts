import { Module } from '@nestjs/common';
import { HealthScoreService } from './health-score.service';

@Module({
  providers: [HealthScoreService],
  exports: [HealthScoreService],
})
export class HealthScoreModule {}
