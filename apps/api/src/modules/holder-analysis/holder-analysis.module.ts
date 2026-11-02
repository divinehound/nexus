import { Module } from '@nestjs/common';
import { QueueModule } from '../../common/queue/queue.module';
import { HolderAnalysisAdminController } from './holder-analysis-admin.controller';
import { HolderAnalysisAdminService } from './holder-analysis-admin.service';
import { HolderAnalysisSyncCron, HolderAnalysisSyncProcessor } from './sync.processor';
import { HolderAnalysisSyncService } from './sync.service';

/** The holder analysis: projects opt in; a sync every 10 minutes reads their collections' transfers and wallets. */
@Module({
  imports: [QueueModule],
  controllers: [HolderAnalysisAdminController],
  providers: [HolderAnalysisSyncService, HolderAnalysisSyncCron, HolderAnalysisSyncProcessor, HolderAnalysisAdminService],
  exports: [HolderAnalysisSyncService],
})
export class HolderAnalysisModule {}
