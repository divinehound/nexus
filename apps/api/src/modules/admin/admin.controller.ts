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

@ApiTags('admin')
@ApiBearerAuth()
@UseGuards(AdminGuard)
@Controller('admin')
export class AdminController {
  constructor(private readonly adminService: AdminService) {}

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

  @Get('indexing/status/wallet/:walletId')
  @ApiOperation({ summary: 'Get indexing status for a wallet' })
  getWalletIndexStatus(@Param('walletId') walletId: string) {
    return this.adminService.getWalletIndexStatus(walletId);
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

  @Post('indexing/wallet/:walletId/refresh')
  @ApiOperation({ summary: 'Manually trigger holdings indexing refresh for a wallet' })
  refreshWalletIndexing(@Param('walletId') walletId: string) {
    return this.adminService.refreshWalletIndexing(walletId);
  }
}
