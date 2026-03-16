import { Controller, Get, Post, Body, Param, Query } from '@nestjs/common';
import { ApiTags, ApiOperation } from '@nestjs/swagger';
import { EventsService } from './events.service';

@ApiTags('events')
@Controller('projects/:projectId/events')
export class EventsController {
  constructor(private readonly eventsService: EventsService) {}

  @Get()
  @ApiOperation({ summary: 'Get events for a project' })
  getEvents(
    @Param('projectId') projectId: string,
    @Query('status') status?: string,
  ) {
    return this.eventsService.getByProjectId(projectId, status);
  }

  @Get('live')
  @ApiOperation({ summary: 'Get live events for a project' })
  getLiveEvents(@Param('projectId') projectId: string) {
    return this.eventsService.getLiveEvents(projectId);
  }

  @Post()
  @ApiOperation({ summary: 'Submit a manual event' })
  submitEvent(
    @Param('projectId') projectId: string,
    @Body() body: { title: string; description?: string; eventType: string; startTime: string; link?: string; submittedBy: string },
  ) {
    return this.eventsService.submitEvent(projectId, body);
  }
}
