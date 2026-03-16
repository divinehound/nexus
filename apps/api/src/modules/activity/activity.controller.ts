import { Controller, Get, Post, Body, Param, Query } from '@nestjs/common';
import { ApiTags, ApiOperation } from '@nestjs/swagger';
import { ActivityService } from './activity.service';

@ApiTags('activity')
@Controller('projects/:projectId/activity')
export class ActivityController {
  constructor(private readonly activityService: ActivityService) {}

  @Get()
  @ApiOperation({ summary: 'Get activity feed for a project' })
  getActivity(
    @Param('projectId') projectId: string,
    @Query('page') page?: number,
    @Query('limit') limit?: number,
  ) {
    return this.activityService.getByProjectId(projectId, page, limit);
  }

  @Post('flex')
  @ApiOperation({ summary: 'Post a flex (verified holder purchase share)' })
  postFlex(
    @Param('projectId') projectId: string,
    @Body() body: { walletAddress: string; collectionId: string; tokenId: string; message?: string; imageUrl?: string },
  ) {
    return this.activityService.createFlex(projectId, body);
  }

  @Post(':activityId/react')
  @ApiOperation({ summary: 'React to an activity (upvote/fire)' })
  react(
    @Param('activityId') activityId: string,
    @Body() body: { walletAddress: string },
  ) {
    return this.activityService.addReaction(activityId, body.walletAddress);
  }
}
