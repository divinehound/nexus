import { Controller, Get, Post, Query, Body, UseGuards } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { AuthGuard } from '@nestjs/passport';
import { SearchService } from './search.service';
import { CollectionImportService } from './collection-import.service';

@ApiTags('search')
@Controller('search')
export class SearchController {
  constructor(
    private readonly searchService: SearchService,
    private readonly collectionImportService: CollectionImportService,
  ) {}

  @Get()
  @ApiOperation({ summary: 'Search projects and collections by name or contract address' })
  search(@Query('q') query: string, @Query('chain') chain?: string) {
    return this.searchService.search(query, chain);
  }

  @Post('import')
  @UseGuards(AuthGuard('jwt'))
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Import a contract from the blockchain into the database' })
  importCollection(
    @Body() body: { contractAddress: string; chain: string },
  ) {
    return this.collectionImportService.importCollection(
      body.contractAddress,
      body.chain,
    );
  }
}
