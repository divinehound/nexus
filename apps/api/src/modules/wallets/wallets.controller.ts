import { Controller, Get, Post, Body, Param } from '@nestjs/common';
import { ApiTags, ApiOperation } from '@nestjs/swagger';
import { WalletsService } from './wallets.service';

@ApiTags('wallets')
@Controller('wallets')
export class WalletsController {
  constructor(private readonly walletsService: WalletsService) {}

  @Post('connect')
  @ApiOperation({ summary: 'Connect a wallet and sync holdings' })
  connect(@Body() body: { address: string; chain: string }) {
    return this.walletsService.connectWallet(body.address, body.chain);
  }

  @Get(':address/holdings')
  @ApiOperation({ summary: 'Get holdings grouped by project' })
  getHoldings(@Param('address') address: string) {
    return this.walletsService.getHoldings(address);
  }

  @Get(':address/events')
  @ApiOperation({ summary: 'Get aggregated events from held projects' })
  getMyEvents(@Param('address') address: string) {
    return this.walletsService.getMyEvents(address);
  }

  @Get(':address/activity')
  @ApiOperation({ summary: 'Get activity feed from held projects' })
  getMyActivity(@Param('address') address: string) {
    return this.walletsService.getMyActivity(address);
  }
}
