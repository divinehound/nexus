import { Controller, Get, Param } from '@nestjs/common';
import { ApiTags, ApiOperation } from '@nestjs/swagger';
import { DiscoveryService } from './discovery.service';

@ApiTags('discovery')
@Controller('discovery')
export class DiscoveryController {
  constructor(private readonly discoveryService: DiscoveryService) {}

  @Get('recommendations/:walletAddress')
  @ApiOperation({ summary: 'Get project recommendations for a wallet (Tier 1: People Like You)' })
  getRecommendations(@Param('walletAddress') walletAddress: string) {
    return this.discoveryService.getRecommendations(walletAddress);
  }

  @Get('echo-score/:walletAddress')
  @ApiOperation({ summary: 'Get echo chamber score for a wallet' })
  getEchoScore(@Param('walletAddress') walletAddress: string) {
    return this.discoveryService.getEchoScore(walletAddress);
  }
}
