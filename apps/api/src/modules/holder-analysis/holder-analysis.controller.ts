import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Put, Query, Req, Res, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { ProjectOwnerGuard } from '../../common/guards/project-owner.guard';
import { HolderAnalysisService, type Paging } from './holder-analysis.service';
import { HolderAnalysisSyncCron } from './sync.processor';

interface AuthRequest {
  user: { sub: string };
}

const csv = (res: Response, name: string) => {
  res.setHeader('content-type', 'text/csv; charset=utf-8');
  res.setHeader('content-disposition', `attachment; filename="${name.replace(/[^a-z0-9._-]/gi, '-')}"`);
};

/**
 * A project's holder analysis, for its owners and editors (and Nexus admins): the related-wallet
 * groups and everything else here stay with the people who run the collection.
 */
@ApiTags('holder-analysis')
@ApiBearerAuth()
@UseGuards(ProjectOwnerGuard)
@Controller('projects/:projectId/holder-analysis')
export class HolderAnalysisController {
  constructor(
    private readonly analysis: HolderAnalysisService,
    private readonly cron: HolderAnalysisSyncCron,
  ) {}

  @Get()
  @ApiOperation({ summary: 'The latest report: summary, collections, what the analysis is waiting for' })
  overview(@Param('projectId', ParseUUIDPipe) projectId: string, @Req() req: AuthRequest) {
    return this.analysis.overview(projectId, req.user.sub);
  }

  @Post('analyse')
  @ApiOperation({ summary: 'Run the analysis again now (queued; it also runs daily and after new transfers)' })
  async analyse(@Param('projectId', ParseUUIDPipe) projectId: string) {
    await this.analysis.project(projectId);
    return { queued: await this.cron.enqueueAnalysis(projectId) };
  }

  @Get('holders')
  @ApiOperation({ summary: 'Holders: q (search), show (labelled, new30, grouped, dormant, a status), sort, page, perPage' })
  holders(@Param('projectId', ParseUUIDPipe) projectId: string, @Req() req: AuthRequest, @Query() q: Paging & { q?: string; show?: string; sort?: string }) {
    return this.analysis.holders(projectId, req.user.sub, q);
  }

  @Get('side/:collectionId')
  @ApiOperation({ summary: 'Holders of a collection that is not core' })
  side(
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Param('collectionId', ParseUUIDPipe) collectionId: string,
    @Req() req: AuthRequest,
    @Query() q: Paging,
  ) {
    return this.analysis.sideHolders(projectId, collectionId, req.user.sub, q);
  }

  @Get('wallets/:address')
  @ApiOperation({ summary: 'One wallet: holdings, transfers (paged), groups, links, funded wallets, labels' })
  wallet(@Param('projectId', ParseUUIDPipe) projectId: string, @Param('address') address: string, @Req() req: AuthRequest, @Query() q: Paging) {
    return this.analysis.wallet(projectId, address, req.user.sub, q);
  }

  @Put('wallets/:address/label')
  @ApiOperation({ summary: "Save the project's label and note for a wallet (both empty removes them)" })
  saveLabel(@Param('projectId', ParseUUIDPipe) projectId: string, @Param('address') address: string, @Req() req: AuthRequest, @Body() body: { label?: unknown; note?: unknown }) {
    return this.analysis.saveLabel(projectId, address, req.user.sub, body);
  }

  @Post('unlinks')
  @ApiOperation({ summary: 'Mark wallets as not the same person (remove: true takes the mark off); regroups' })
  async unlinks(@Param('projectId', ParseUUIDPipe) projectId: string, @Req() req: AuthRequest, @Body() body: { wallet?: unknown; others?: unknown; remove?: unknown }) {
    const saved = await this.analysis.saveUnlinks(projectId, req.user.sub, body);
    return { ...saved, queued: await this.cron.enqueueAnalysis(projectId) };
  }

  @Get('groups')
  @ApiOperation({ summary: 'Groups of wallets that are likely one person' })
  groups(@Param('projectId', ParseUUIDPipe) projectId: string, @Query() q: Paging) {
    return this.analysis.groups(projectId, q);
  }

  @Get('activity')
  @ApiOperation({ summary: 'The activity feed: kind, collectionId, labelled, page, perPage' })
  activity(@Param('projectId', ParseUUIDPipe) projectId: string, @Req() req: AuthRequest, @Query() q: Paging & { kind?: string; collectionId?: string; labelled?: string }) {
    return this.analysis.activity(projectId, req.user.sub, q);
  }

  @Get('holders.csv')
  async holdersCsv(@Param('projectId', ParseUUIDPipe) projectId: string, @Req() req: AuthRequest, @Res() res: Response) {
    const body = await this.analysis.holdersCsv(projectId, req.user.sub);
    csv(res, 'holders.csv');
    res.send(body);
  }

  @Get('groups.csv')
  async groupsCsv(@Param('projectId', ParseUUIDPipe) projectId: string, @Res() res: Response) {
    const body = await this.analysis.groupsCsv(projectId);
    csv(res, 'wallet-groups.csv');
    res.send(body);
  }

  @Get('links.csv')
  async linksCsv(@Param('projectId', ParseUUIDPipe) projectId: string, @Res() res: Response) {
    const body = await this.analysis.linksCsv(projectId);
    csv(res, 'wallet-links.csv');
    res.send(body);
  }

  @Get('side/:collectionId/holders.csv')
  async sideCsv(@Param('projectId', ParseUUIDPipe) projectId: string, @Param('collectionId', ParseUUIDPipe) collectionId: string, @Res() res: Response) {
    const body = await this.analysis.sideCsv(projectId, collectionId);
    csv(res, `${await this.analysis.shortIdOf(projectId, collectionId)}-holders.csv`);
    res.send(body);
  }

  @Get('collections/:collectionId/transfers.csv')
  async transfersCsv(@Param('projectId', ParseUUIDPipe) projectId: string, @Param('collectionId', ParseUUIDPipe) collectionId: string, @Res() res: Response) {
    // Checked before the headers go out, so a bad id is still a plain 404.
    const name = `${await this.analysis.shortIdOf(projectId, collectionId)}-transfers.csv`;
    let started = false;
    try {
      await this.analysis.transfersCsv(projectId, collectionId, async (chunk) => {
        if (!started) {
          csv(res, name);
          started = true;
        }
        // A download the client gave up on stops here instead of waiting for a 'drain' that never comes.
        if (res.destroyed) throw new Error('client went away');
        if (!res.write(chunk))
          await new Promise<void>((resolve, reject) => {
            const done = () => {
              res.off('drain', done);
              res.off('close', gone);
              resolve();
            };
            const gone = () => {
              res.off('drain', done);
              reject(new Error('client went away'));
            };
            res.once('drain', done);
            res.once('close', gone);
          });
      });
      res.end();
    } catch (err) {
      if (started || res.destroyed) {
        if (!res.destroyed) res.destroy(err as Error);
        return;
      }
      throw err;
    }
  }
}
