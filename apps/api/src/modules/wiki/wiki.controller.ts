import { Controller, Get, Post, Body, Param } from '@nestjs/common';
import { ApiTags, ApiOperation } from '@nestjs/swagger';
import { WikiService } from './wiki.service';

@ApiTags('wiki')
@Controller('projects/:projectId/wiki')
export class WikiController {
  constructor(private readonly wikiService: WikiService) {}

  @Get()
  @ApiOperation({ summary: 'Get wiki for a project' })
  getWiki(@Param('projectId') projectId: string) {
    return this.wikiService.getByProjectId(projectId);
  }

  @Post('suggest')
  @ApiOperation({ summary: 'Submit a wiki edit suggestion' })
  suggestEdit(
    @Param('projectId') projectId: string,
    @Body() body: { field: string; proposedValue: string; submittedBy: string },
  ) {
    return this.wikiService.submitSuggestion(projectId, body);
  }
}
