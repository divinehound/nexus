import { Body, Controller, Get, Param, Post } from '@nestjs/common';
import { ApiTags, ApiOperation } from '@nestjs/swagger';
import { IsString } from 'class-validator';
import { CollectionsService } from './collections.service';
import { CollectionMetricsService } from './collection-metrics.service';

class TrackCollectionDto {
  @IsString()
  chain!: string;

  @IsString()
  contractAddress!: string;
}

@ApiTags('collections')
@Controller('collections')
export class CollectionsController {
  constructor(
    private readonly collectionsService: CollectionsService,
    private readonly collectionMetricsService: CollectionMetricsService,
  ) {}

  @Post('track')
  @ApiOperation({
    summary:
      'Track a collection contract immediately, even before verification or mapping',
  })
  async track(@Body() body: TrackCollectionDto) {
    const result = await this.collectionsService.trackCollection(body);
    return {
      statusCode: 202,
      ...result,
    };
  }

  @Get(':chain/:contractAddress/stats')
  @ApiOperation({ summary: 'Get collection metrics stats and trend history' })
  async getStats(
    @Param('chain') chain: string,
    @Param('contractAddress') contractAddress: string,
  ) {
    const collection = await this.collectionsService.findByChainAndContract(
      chain,
      contractAddress,
    );

    return this.collectionMetricsService.getCollectionStats(collection.id);
  }

  @Get(':chain/:contractAddress')
  @ApiOperation({ summary: 'Get tracked collection by chain + contract address' })
  findByChainAndAddress(
    @Param('chain') chain: string,
    @Param('contractAddress') contractAddress: string,
  ) {
    return this.collectionsService.findByChainAndContract(chain, contractAddress);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get collection by ID' })
  findById(@Param('id') id: string) {
    return this.collectionsService.findById(id);
  }

  @Get('address/:address')
  @ApiOperation({ summary: 'Get collection by contract address' })
  findByAddress(@Param('address') address: string) {
    return this.collectionsService.findByAddress(address);
  }
}
