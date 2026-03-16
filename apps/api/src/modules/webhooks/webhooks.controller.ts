import { Controller, Post, Body, Headers } from '@nestjs/common';
import { ApiTags, ApiOperation } from '@nestjs/swagger';

@ApiTags('webhooks')
@Controller('webhooks')
export class WebhooksController {
  @Post('alchemy')
  @ApiOperation({ summary: 'Handle Alchemy webhook for ETH NFT transfers' })
  handleAlchemy(@Body() body: unknown, @Headers('x-alchemy-signature') signature: string) {
    // TODO: Verify signature, process NFT transfer events
    // Insert into activity_feed, update holders table
    return { received: true };
  }

  @Post('helius')
  @ApiOperation({ summary: 'Handle Helius webhook for Solana NFT transfers' })
  handleHelius(@Body() body: unknown, @Headers('authorization') auth: string) {
    // TODO: Verify auth, process Solana NFT transfer events
    return { received: true };
  }
}
