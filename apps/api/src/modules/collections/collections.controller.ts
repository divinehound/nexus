import { Controller, Get, Post, Param, Body, Query } from '@nestjs/common';
import { ApiTags, ApiOperation } from '@nestjs/swagger';
import { CollectionsService } from './collections.service';

@ApiTags('collections')
@Controller('collections')
export class CollectionsController {
  constructor(private readonly collectionsService: CollectionsService) {}

  // Static routes MUST come before dynamic parameter routes
  @Post('track')
  @ApiOperation({ summary: 'Track a new collection by contract address' })
  track(@Body() body: { chain: string; contractAddress: string }) {
    return this.collectionsService.trackCollection(body);
  }

  @Get('network/graph')
  @ApiOperation({ summary: 'Get collection network graph data for visualization' })
  getNetworkGraph(
    @Query('strategy') strategy?: 'top-collections' | 'connected-traverse',
    @Query('minSharedHolders') minSharedHolders?: string,
    @Query('maxNodes') maxNodes?: string,
    @Query('chains') chains?: string,
    @Query('focusCollectionId') focusCollectionId?: string,
  ) {
    return this.collectionsService.getNetworkGraph({
      strategy,
      minSharedHolders: minSharedHolders ? parseInt(minSharedHolders) : undefined,
      maxNodes: maxNodes ? parseInt(maxNodes) : undefined,
      chains: chains ? chains.split(',') : undefined,
      focusCollectionId,
    });
  }

  @Get('recommendations/:chain/:address')
  @ApiOperation({ summary: 'Get personalized collection recommendations for a wallet' })
  getRecommendations(
    @Param('chain') chain: string,
    @Param('address') address: string,
    @Query('limit') limit?: string,
    @Query('minOverlap') minOverlap?: string,
  ) {
    return this.collectionsService.getRecommendations(address, chain, {
      limit: limit ? parseInt(limit) : undefined,
      minOverlap: minOverlap ? parseInt(minOverlap) : undefined,
    });
  }

  // Dynamic parameter routes MUST come after static routes
  @Get(':id/related')
  @ApiOperation({ summary: 'Get related collections based on holder overlap' })
  getRelatedCollections(
    @Param('id') id: string,
    @Query('limit') limit?: string,
  ) {
    return this.collectionsService.getRelatedCollections(id, limit ? parseInt(limit) : 10);
  }

  @Get(':id/connections')
  @ApiOperation({ summary: 'Get network connections for a specific collection (for incremental graph building)' })
  getCollectionConnections(
    @Param('id') id: string,
    @Query('minSharedHolders') minSharedHolders?: string,
    @Query('limit') limit?: string,
  ) {
    return this.collectionsService.getCollectionConnections(id, {
      minSharedHolders: minSharedHolders ? parseInt(minSharedHolders) : 5,
      limit: limit ? parseInt(limit) : 10,
    });
  }

  @Get(':chain/:contract')
  @ApiOperation({ summary: 'Get collection by chain and contract address' })
  getByChainAndContract(
    @Param('chain') chain: string,
    @Param('contract') contract: string,
  ) {
    return this.collectionsService.findByChainAndContract(chain, contract);
  }
}
