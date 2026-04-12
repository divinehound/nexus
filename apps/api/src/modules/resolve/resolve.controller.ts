import { Controller, Get, Post, Query, Body } from '@nestjs/common';
import { ApiTags, ApiOperation } from '@nestjs/swagger';
import { SkipThrottle } from '@nestjs/throttler';
import { ResolveService } from './resolve.service';

@ApiTags('resolve')
@SkipThrottle()
@Controller('resolve')
export class ResolveController {
  constructor(private readonly resolveService: ResolveService) {}

  @Get('domain')
  @ApiOperation({ summary: 'Resolve a Solana SNS domain for a wallet address' })
  async resolveDomain(
    @Query('address') address: string,
  ): Promise<{ domain: string | null }> {
    if (!address) return { domain: null };
    const domain = await this.resolveService.resolveSolanaDomain(address);
    return { domain };
  }

  @Post('domains')
  @ApiOperation({ summary: 'Batch resolve Solana SNS domains for multiple addresses' })
  async resolveDomains(
    @Body() body: { addresses: string[] },
  ): Promise<{ results: Record<string, string | null> }> {
    const addresses = (body.addresses || []).slice(0, 100);
    if (addresses.length === 0) return { results: {} };
    const results = await this.resolveService.resolveBatch(addresses);
    return { results };
  }
}
