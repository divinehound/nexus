import { Controller, Get, Post, Body, Param, Query, UseGuards, Req, BadRequestException } from '@nestjs/common';
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
    @Req() req: { user: { address: string | null } },
    @Body() body: { collectionId: string; tokenId: string; message?: string; imageUrl?: string },
  ) {
    const walletAddress = requireWallet(req.user.address);
    return this.activityService.createFlex(projectId, {
      walletAddress,
      ...body,
    });
  }

  @Post(':activityId/react')
  @UseGuards(AuthGuard('jwt'))
  @ApiBearerAuth()
  @ApiOperation({ summary: 'React to an activity (upvote/fire)' })
  react(
    @Param('activityId') activityId: string,
    @Req() req: { user: { address: string | null } },
  ) {
    return this.activityService.addReaction(activityId, requireWallet(req.user.address));
  }
}

/** Flexes and reactions are tied to a wallet; accounts without one must link it first. */
function requireWallet(address: string | null): string {
  if (!address) {
    throw new BadRequestException({ error: 'WALLET_REQUIRED', message: 'Link a wallet to do this.' });
  }
  return address;
}
