import { Controller, Get, Param, Query } from '@nestjs/common';
import { ApiTags, ApiOperation } from '@nestjs/swagger';
import { ProjectsService } from './projects.service';

@ApiTags('projects')
@Controller('projects')
export class ProjectsController {
  constructor(private readonly projectsService: ProjectsService) {}

  @Get()
  @ApiOperation({ summary: 'List projects with optional filters' })
  findAll(@Query('page') page?: number, @Query('limit') limit?: number) {
    return this.projectsService.findAll(page, limit);
  }

  @Get('trending')
  @ApiOperation({ summary: 'Get trending projects' })
  getTrending() {
    return this.projectsService.getTrending();
  }

  @Get(':slug')
  @ApiOperation({ summary: 'Get project by slug' })
  findBySlug(@Param('slug') slug: string) {
    return this.projectsService.findBySlug(slug);
  }

  @Get(':slug/overlap')
  @ApiOperation({ summary: 'Get community overlap for a project' })
  getOverlap(@Param('slug') slug: string) {
    return this.projectsService.getOverlap(slug);
  }
}
