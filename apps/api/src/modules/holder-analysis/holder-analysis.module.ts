import { Module } from '@nestjs/common';
import { QueueModule } from '../../common/queue/queue.module';
import { HolderAnalysisAdminController } from './holder-analysis-admin.controller';
import { HolderAnalysisAdminService } from './holder-analysis-admin.service';
import { HolderAnalysisImportService } from './import.service';
import { HolderAnalysisController } from './holder-analysis.controller';
import { HolderAnalysisService } from './holder-analysis.service';
import { HolderAnalysisReportService } from './report.service';
import { HolderAnalysisSyncCron, HolderAnalysisSyncProcessor } from './sync.processor';
import { HolderAnalysisSyncService } from './sync.service';

/**
 * The holder analysis: projects opt in; a sync every 10 minutes reads their collections' transfers
 * and wallets, and the analysis runs after new transfers and daily. Its reports are for the
 * project's owners and editors.
 */
@Module({
  imports: [QueueModule],
  controllers: [HolderAnalysisAdminController, HolderAnalysisController],
  providers: [
    HolderAnalysisSyncService,
    HolderAnalysisReportService,
    HolderAnalysisService,
    HolderAnalysisSyncCron,
    HolderAnalysisSyncProcessor,
    HolderAnalysisAdminService,
    HolderAnalysisImportService,
  ],
  exports: [HolderAnalysisSyncService],
})
export class HolderAnalysisModule {}
