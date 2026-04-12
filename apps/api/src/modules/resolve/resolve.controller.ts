import { Controller, Post, Body } from '@nestjs/common';
import { ApiTags, ApiOperation } from '@nestjs/swagger';
import { SkipThrottle } from '@nestjs/throttler';
import { ResolveService } from './resolve.service';

@ApiTags('resolve')
@SkipThrottle()
@Controller('resolve')
export class ResolveController {
  constructor(private readonly resolveService: ResolveService) {}

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
