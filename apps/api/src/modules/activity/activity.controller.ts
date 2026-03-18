import { Controller, Get, Post, Body, Param, Query, UseGuards, Req } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { AuthGuard } from '@nestjs/passport';
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
  @UseGuards(AuthGuard('jwt'))
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Post a flex (verified holder purchase share)' })
  postFlex(
    @Param('projectId') projectId: string,
    @Req() req: { user: { address: string } },
    @Body() body: { collectionId: string; tokenId: string; message?: string; imageUrl?: string },
  ) {
    return this.activityService.createFlex(projectId, {
      walletAddress: req.user.address,
      ...body,
    });
  }

  @Post(':activityId/react')
  @UseGuards(AuthGuard('jwt'))
  @ApiBearerAuth()
  @ApiOperation({ summary: 'React to an activity (upvote/fire)' })
  react(
    @Param('activityId') activityId: string,
    @Req() req: { user: { address: string } },
  ) {
    return this.activityService.addReaction(activityId, req.user.address);
  }
}
