import { Controller, Post, Body, Headers, RawBody, UnauthorizedException } from '@nestjs/common';
import { ApiTags, ApiOperation } from '@nestjs/swagger';
import { WebhooksService } from './webhooks.service';

@ApiTags('webhooks')
@Controller('webhooks')
export class WebhooksController {
  constructor(private readonly webhooksService: WebhooksService) {}

  @Post('alchemy')
  @ApiOperation({ summary: 'Handle Alchemy webhook for ETH NFT transfers' })
  async handleAlchemy(
    @Body() body: unknown,
    @Headers('x-alchemy-signature') signature: string,
  ) {
    if (!this.webhooksService.verifyAlchemySignature(JSON.stringify(body), signature)) {
      throw new UnauthorizedException('Invalid webhook signature');
    }
    await this.webhooksService.handleAlchemyWebhook(body as never);
    return { received: true };
  }

  @Post('helius')
  @ApiOperation({ summary: 'Handle Helius webhook for Solana NFT transfers' })
  async handleHelius(
    @Body() body: unknown,
    @Headers('authorization') auth: string,
  ) {
    await this.webhooksService.handleHeliusWebhook(body as never);
    return { received: true };
  }
}
