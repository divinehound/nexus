import { Controller, Get, Query } from '@nestjs/common';
import { ApiTags, ApiOperation } from '@nestjs/swagger';
import { ResolveService } from './resolve.service';

@ApiTags('resolve')
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
}
