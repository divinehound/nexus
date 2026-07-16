import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Param,
  Query,
  Body,
  UseGuards,
  BadRequestException,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { AdminGuard } from '../../common/guards/admin.guard';
import { AdminService } from './admin.service';
import { HolderHistoryService } from './holder-history.service';

@ApiTags('admin')
@ApiBearerAuth()
@UseGuards(AdminGuard)
@Controller('admin')
export class AdminController {
  constructor(
    private readonly adminService: AdminService,
    private readonly holderHistoryService: HolderHistoryService,
  ) {}

  // --- Dashboard ---

  @Get('stats')
  @ApiOperation({ summary: 'Get dashboard statistics' })
  getStats() {
    return this.adminService.getStats();
  }

  // --- Projects ---

  @Get('projects')
  @ApiOperation({ summary: 'List all projects (paginated)' })
  listProjects(@Query('page') page?: string, @Query('limit') limit?: string) {
    return this.adminService.listProjects(
      page ? parseInt(page) : 1,
      limit ? parseInt(limit) : 50,
    );
  }

  @Patch('projects/:id/verify')
  @ApiOperation({ summary: 'Set project verification status' })
  setProjectVerified(
    @Param('id') id: string,
    @Body() body: { isVerified: boolean },
  ) {
    return this.adminService.setProjectVerified(id, body.isVerified);
  }

  @Patch('projects/:id/featured')
  @ApiOperation({ summary: 'Set project featured status' })
  setProjectFeatured(
    @Param('id') id: string,
    @Body() body: { isFeatured: boolean },
  ) {
    if (typeof body?.isFeatured !== 'boolean') {
      throw new BadRequestException('isFeatured must be a boolean');
    }

    return this.adminService.setProjectFeatured(id, body.isFeatured);
  }

  @Delete('projects/:id')
  @ApiOperation({ summary: 'Delete a project' })
  deleteProject(@Param('id') id: string) {
    return this.adminService.deleteProject(id);
  }

  // --- Wiki Suggestions ---

  @Get('wiki/suggestions')
  @ApiOperation({ summary: 'List wiki suggestions' })
  listWikiSuggestions(@Query('status') status?: string) {
    return this.adminService.listWikiSuggestions(status);
  }

  @Patch('wiki/suggestions/:id/approve')
  @ApiOperation({ summary: 'Approve a wiki suggestion (applies it to the wiki)' })
  approveWikiSuggestion(@Param('id') id: string) {
    return this.adminService.approveWikiSuggestion(id);
  }

  @Patch('wiki/suggestions/:id/reject')
  @ApiOperation({ summary: 'Reject a wiki suggestion' })
  rejectWikiSuggestion(@Param('id') id: string) {
    return this.adminService.rejectWikiSuggestion(id);
  }

  // --- Events ---

  @Get('events')
  @ApiOperation({ summary: 'List all events' })
  listEvents(@Query('status') status?: string) {
    return this.adminService.listAllEvents(status);
  }

  @Patch('events/:id/status')
  @ApiOperation({ summary: 'Update event status' })
  updateEventStatus(
    @Param('id') id: string,
    @Body() body: { status: 'upcoming' | 'live' | 'ended' },
  ) {
    return this.adminService.updateEventStatus(id, body.status);
  }

  @Delete('events/:id')
  @ApiOperation({ summary: 'Delete an event' })
  deleteEvent(@Param('id') id: string) {
    return this.adminService.deleteEvent(id);
  }

  // --- Collection Verification / Mapping ---

  @Post('collections/:id/verify')
  @ApiOperation({ summary: 'Mark a collection as verified' })
  verifyCollection(
    @Param('id') id: string,
    @Body() body: { notes?: string; projectId?: string },
  ) {
    return this.adminService.verifyCollection(id, body);
  }

  @Post('collections/:id/reject')
  @ApiOperation({ summary: 'Reject a collection verification request' })
  rejectCollection(@Param('id') id: string, @Body() body: { notes?: string }) {
    return this.adminService.rejectCollection(id, body.notes);
  }

  @Post('collections/:id/suggest-project')
  @ApiOperation({ summary: 'Suggest a project mapping for a tracked collection' })
  suggestProject(
    @Param('id') id: string,
    @Body() body: { projectId: string; confidence: number; notes?: string },
  ) {
    return this.adminService.suggestProject(id, body);
  }

  @Post('collections/:id/index-holders')
  @ApiOperation({ summary: 'Index all holders for a collection (full data)' })
  indexCollectionHolders(@Param('id') id: string) {
    return this.adminService.indexCollectionHolders(id);
  }

  @Get('collections/:id/holder-history')
  @ApiOperation({ summary: 'Get full holder history summary for a collection' })
  getCollectionHolderHistory(@Param('id') id: string) {
    return this.holderHistoryService.getCollectionHolderHistory(id);
  }

  @Post('collections/:id/holder-history/scan')
  @ApiOperation({ summary: 'Queue transfer history scan for a collection and update holder summaries asynchronously' })
  scanCollectionHolderHistory(
    @Param('id') id: string,
    @Body() body?: { fromBlock?: number },
  ) {
    return this.holderHistoryService.queueCollectionHolderHistoryScan(id, body);
  }

  @Get('collections/:id/holder-history/status')
  @ApiOperation({ summary: 'Get holder history scan job status for a collection' })
  getCollectionHolderHistoryStatus(@Param('id') id: string) {
    return this.holderHistoryService.getCollectionHolderHistoryScanStatus(id);
  }

  @Get('collections/:id/holder-history/reconciliation')
  @ApiOperation({ summary: 'Get Solana holder history reconciliation summary + mismatches' })
  getSolanaReconciliation(@Param('id') id: string, @Query('limit') limit?: string) {
    return this.holderHistoryService.getSolanaReconciliation(id, limit ? parseInt(limit) : 200);
  }

  @Post('collections/:id/holder-history/mark-for-review')
  @ApiOperation({ summary: 'Mark specific Solana signatures for re-parsing on next scan' })
  markSignaturesForReview(
    @Param('id') id: string,
    @Body() body: { signatures: string[] },
  ) {
    return this.holderHistoryService.markSolanaSignaturesForReview(id, body.signatures || []);
  }

  @Get('solana/signatures/:signature/raw')
  @ApiOperation({ summary: 'Get stored raw_data + parsed transfers for a Solana signature' })
  getSolanaSignatureRawData(@Param('signature') signature: string) {
    return this.holderHistoryService.getSolanaSignatureRawData(signature);
  }

  @Post('collections/:id/mark-spam')
  @ApiOperation({ summary: 'Mark a collection as spam' })
  markCollectionAsSpam(@Param('id') id: string, @Body() body: { notes?: string }) {
    return this.adminService.markCollectionAsSpam(id, body.notes);
  }

  @Post('collections/:id/mark-not-spam')
  @ApiOperation({ summary: 'Mark a collection as NOT spam (add to allowlist)' })
  markCollectionAsNotSpam(@Param('id') id: string, @Body() body: { reason?: string }) {
    return this.adminService.markCollectionAsNotSpam(id, body.reason || 'verified_legitimate');
  }

  @Get('collections/:id/check-spam-raw')
  @ApiOperation({ summary: 'Debug: Get raw spam data from Alchemy for a single collection' })
  checkSpamRaw(@Param('id') id: string) {
    return this.adminService.checkSpamRaw(id);
  }

  @Post('collections/bulk-check-spam')
  @ApiOperation({ summary: 'Check all existing collections for spam via Alchemy API (background job)' })
  bulkCheckSpam() {
    // Start background job - don't await (logs handled by SpamCheckerService)
    this.adminService.bulkCheckSpam().catch((err) => {
      console.error(`Bulk spam check failed: ${err.message}`);
    });
    
    // Return immediately
    return {
      status: 'started',
      message: 'Bulk spam check started in background. Check server logs for progress and completion.',
    };
  }

  // --- Users ---

  @Get('users')
  @ApiOperation({ summary: 'List all users (paginated)' })
  listUsers(@Query('page') page?: string, @Query('limit') limit?: string) {
    return this.adminService.listUsers(
      page ? parseInt(page) : 1,
      limit ? parseInt(limit) : 50,
    );
  }

  @Patch('users/:id/role')
  @ApiOperation({ summary: 'Set user role' })
  setUserRole(
    @Param('id') id: string,
    @Body() body: { role: 'user' | 'admin' },
  ) {
    return this.adminService.setUserRole(id, body.role);
  }

  // --- Project Ownership ---

  @Get('projects/:id/owners')
  @ApiOperation({ summary: 'Get owners for a project' })
  getProjectOwners(@Param('id') id: string) {
    return this.adminService.getProjectOwners(id);
  }

  @Post('projects/:id/owners')
  @ApiOperation({ summary: 'Add an owner to a project' })
  addProjectOwner(
    @Param('id') id: string,
    @Body() body: { userId: string; role?: 'owner' | 'editor' },
  ) {
    return this.adminService.addProjectOwner(id, body.userId, body.role);
  }

  @Delete('projects/:id/owners/:userId')
  @ApiOperation({ summary: 'Remove an owner from a project' })
  removeProjectOwner(
    @Param('id') id: string,
    @Param('userId') userId: string,
  ) {
    return this.adminService.removeProjectOwner(id, userId);
  }

  @Post('metrics/refresh')
  @ApiOperation({ summary: 'Run one manual refresh cycle for collection metrics' })
  refreshMetrics() {
    return this.adminService.refreshCollectionMetrics();
  }

  @Get('indexing/jobs')
  @ApiOperation({ summary: 'List indexing jobs (paginated)' })
  listIndexingJobs(
    @Query('status') status?: 'queued' | 'running' | 'completed' | 'failed',
    @Query('walletId') walletId?: string,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
  ) {
    return this.adminService.listIndexingJobs({
      status,
      walletId,
      page: page ? Number(page) : 1,
      limit: limit ? Number(limit) : 20,
    });
  }

  @Get('indexing/jobs/:id')
  @ApiOperation({ summary: 'Get indexing job details' })
  getIndexingJob(@Param('id') id: string) {
    return this.adminService.getIndexingJob(id);
  }

  @Post('indexing/jobs/:id/retry')
  @ApiOperation({ summary: 'Retry an indexing job' })
  retryIndexingJob(@Param('id') id: string) {
    return this.adminService.retryIndexingJob(id);
  }

  @Get('indexing/status/wallet/:walletIdOrAddress')
  @ApiOperation({ summary: 'Get indexing status for a wallet (by ID or address)' })
  getWalletIndexStatus(@Param('walletIdOrAddress') walletIdOrAddress: string) {
    return this.adminService.getWalletIndexStatus(walletIdOrAddress);
  }

  @Get('indexing/status/collection/:idOrContract')
  @ApiOperation({ summary: 'Get indexing status for a collection by id or contract' })
  getCollectionIndexStatus(@Param('idOrContract') idOrContract: string) {
    return this.adminService.getCollectionIndexStatus(idOrContract);
  }

  @Get('indexing/status/project/:idOrSlug')
  @ApiOperation({ summary: 'Get indexing status for a project by id or slug' })
  getProjectIndexStatus(@Param('idOrSlug') idOrSlug: string) {
    return this.adminService.getProjectIndexStatus(idOrSlug);
  }

  @Post('indexing/collection/:id/refresh')
  @ApiOperation({ summary: 'Manually trigger indexing refresh for a collection' })
  refreshCollectionIndexing(@Param('id') id: string) {
    return this.adminService.refreshCollectionIndexing(id);
  }

  @Post('indexing/project/:id/refresh')
  @ApiOperation({ summary: 'Manually trigger indexing refresh for a project' })
  refreshProjectIndexing(@Param('id') id: string) {
    return this.adminService.refreshProjectIndexing(id);
  }

  @Post('indexing/wallet/:walletIdOrAddress/refresh')
  @ApiOperation({ summary: 'Manually trigger holdings indexing refresh for a wallet (by ID or address)' })
  refreshWalletIndexing(@Param('walletIdOrAddress') walletIdOrAddress: string) {
    return this.adminService.refreshWalletIndexing(walletIdOrAddress);
  }

  @Get('collections/search')
  @ApiOperation({ summary: 'Search/filter collections' })
  searchCollections(
    @Query('q') query?: string,
    @Query('limit') limit?: string,
    @Query('page') page?: string,
    @Query('hasProject') hasProject?: string,
    @Query('verified') verified?: string,
    @Query('indexed') indexed?: string,
    @Query('spam') spam?: string,
    @Query('chain') chain?: string,
  ) {
    return this.adminService.searchCollections({
      query,
      limit: limit ? parseInt(limit) : 100,
      page: page ? parseInt(page) : 1,
      hasProject: hasProject === 'true' ? true : hasProject === 'false' ? false : undefined,
      verified: verified === 'true' ? true : verified === 'false' ? false : undefined,
      indexed: indexed === 'true',
      spam: spam === 'true' ? true : spam === 'false' ? false : undefined,
      chain,
    });
  }

  @Post('collections/:id/enrich')
  @ApiOperation({ summary: 'Re-fetch blockchain metadata for a collection' })
  enrichCollection(@Param('id') id: string) {
    return this.adminService.enrichCollection(id);
  }

  @Post('collections/bulk-enrich')
  @ApiOperation({ summary: 'Re-fetch blockchain metadata for multiple collections (background job)' })
  bulkEnrichCollections(@Body() body: { collectionIds: string[] }) {
    const { collectionIds } = body;
    
    // Start background job - don't await
    this.adminService.bulkEnrichCollections(collectionIds).catch((err) => {
      console.error(`Bulk enrich failed: ${err.message}`);
    });
    
    // Return immediately
    return {
      status: 'started',
      count: collectionIds.length,
      message: `Bulk metadata refresh started for ${collectionIds.length} collection(s). Check server logs for progress.`,
    };
  }

  @Post('collections/:id/discover')
  @ApiOperation({ summary: 'Discover new collections from this collection\'s holders (async)' })
  discoverCollections(
    @Param('id') id: string,
    @Body() body?: { maxHolders?: number; maxCollectionsPerHolder?: number; maxNewContracts?: number; minHolderOverlap?: number; fresh?: boolean; autoIndexTop?: number }
  ) {
    return this.adminService.discoverCollections(id, body);
  }

  @Patch('collections/:id/update')
  @ApiOperation({ summary: 'Update collection metadata (description, social links)' })
  updateCollection(
    @Param('id') id: string,
    @Body() body: {
      name?: string;
      description?: string;
      discordUrl?: string;
      twitterUrl?: string;
      websiteUrl?: string;
      telegramUrl?: string;
      externalUrl?: string;
    }
  ) {
    return this.adminService.updateCollection(id, body);
  }

  @Patch('collections/:id/link-project')
  @ApiOperation({ summary: 'Link/unlink collection to a project' })
  linkCollectionToProject(
    @Param('id') id: string,
    @Body() body: { projectId: string | null }
  ) {
    return this.adminService.linkCollectionToProject(id, body.projectId);
  }

  @Post('collections/bulk-link-project')
  @ApiOperation({ summary: 'Link multiple collections to a project' })
  bulkLinkProject(
    @Body() body: { collectionIds: string[]; projectId: string }
  ) {
    return this.adminService.bulkLinkProject(body.collectionIds, body.projectId);
  }

  @Post('collections/bulk-verify')
  @ApiOperation({ summary: 'Verify multiple collections' })
  bulkVerify(@Body() body: { collectionIds: string[] }) {
    return this.adminService.bulkVerify(body.collectionIds);
  }

  @Post('collections/bulk-mark-spam')
  @ApiOperation({ summary: 'Mark multiple collections as spam' })
  bulkMarkSpam(@Body() body: { collectionIds: string[] }) {
    return this.adminService.bulkMarkSpam(body.collectionIds);
  }
}
