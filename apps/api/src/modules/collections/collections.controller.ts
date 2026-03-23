import { Controller, Get, Post, Param, Body, Query } from '@nestjs/common';
import { ApiTags, ApiOperation } from '@nestjs/swagger';
import { CollectionsService } from './collections.service';

@ApiTags('collections')
@Controller('collections')
export class CollectionsController {
  constructor(private readonly collectionsService: CollectionsService) {}

  @Get(':chain/:contract')
  @ApiOperation({ summary: 'Get collection by chain and contract address' })
  getByChainAndContract(
    @Param('chain') chain: string,
    @Param('contract') contract: string,
  ) {
    return this.collectionsService.findByChainAndContract(chain, contract);
  }

  @Get(':id/related')
  @ApiOperation({ summary: 'Get related collections based on holder overlap' })
  getRelatedCollections(
    @Param('id') id: string,
    @Query('limit') limit?: string,
  ) {
    return this.collectionsService.getRelatedCollections(id, limit ? parseInt(limit) : 10);
  }

  @Post('track')
  @ApiOperation({ summary: 'Track a new collection by contract address' })
  track(@Body() body: { chain: string; contractAddress: string }) {
    return this.collectionsService.trackCollection(body);
  }
}
