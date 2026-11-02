import { BadRequestException, Body, Controller, Get, Param, ParseUUIDPipe, Patch, Post, Put, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { AdminGuard } from '../../common/guards/admin.guard';
import { type CollectionSettingsInput, HolderAnalysisAdminService } from './holder-analysis-admin.service';
import { HolderAnalysisImportService, type ImportInput } from './import.service';
import { HolderAnalysisSyncCron } from './sync.processor';

@ApiTags('admin')
@ApiBearerAuth()
@UseGuards(AdminGuard)
@Controller('admin/holder-analysis')
export class HolderAnalysisAdminController {
  constructor(
    private readonly admin: HolderAnalysisAdminService,
    private readonly cron: HolderAnalysisSyncCron,
    private readonly importer: HolderAnalysisImportService,
  ) {}

  @Get('projects/:id')
  @ApiOperation({ summary: "A project's holder analysis: on or off, collection settings, sync progress" })
  status(@Param('id', ParseUUIDPipe) id: string) {
    return this.admin.status(id);
  }

  @Patch('projects/:id')
  @ApiOperation({ summary: 'Turn the holder analysis on or off for a project (off by default)' })
  setEnabled(@Param('id', ParseUUIDPipe) id: string, @Body() body: { enabled?: unknown }) {
    if (typeof body?.enabled !== 'boolean') throw new BadRequestException('Send { enabled: true | false }');
    return this.admin.setEnabled(id, body.enabled);
  }

  @Put('collections/:id/settings')
  @ApiOperation({ summary: "Save how the analysis treats a collection (short id, core, standard, staking contracts…)" })
  saveSettings(@Param('id', ParseUUIDPipe) id: string, @Body() body: CollectionSettingsInput) {
    return this.admin.saveSettings(id, body ?? {});
  }

  @Post('projects/:id/import')
  @ApiOperation({ summary: "Bring over the old holder analysis app's collection settings, wallet labels and notes, and unlinks (rows from its D1)" })
  async import(@Param('id', ParseUUIDPipe) id: string, @Req() req: { user: { sub: string } }, @Body() body: ImportInput) {
    const result = await this.importer.import(id, req.user.sub, body ?? {});
    return { ...result, queued: await this.cron.enqueueAnalysis(id) };
  }

  @Post('sync')
  @ApiOperation({ summary: 'Run the holder analysis sync now (it also runs every 10 minutes)' })
  async syncNow() {
    return { queued: await this.cron.enqueue() };
  }
}
