import { Controller, Get, Query } from '@nestjs/common';
import { ApiTags, ApiOperation } from '@nestjs/swagger';
import { SearchService } from './search.service';

@ApiTags('search')
@Controller('search')
export class SearchController {
  constructor(private readonly searchService: SearchService) {}

  @Get()
  @ApiOperation({ summary: 'Search projects and collections by name or contract address' })
  search(@Query('q') query: string, @Query('chain') chain?: string) {
    return this.searchService.search(query, chain);
  }
}
