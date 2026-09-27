import { Controller, Get, Query, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { AuthGuard } from '@nestjs/passport';
import type { CashflowResponse } from '@nexus/types';
import { CashflowService } from './cashflow.service';

interface AuthRequest {
  user: { sub: string };
}

@ApiTags('me')
@ApiBearerAuth()
@UseGuards(AuthGuard('jwt'))
@Controller('me/cashflow')
export class CashflowController {
  constructor(private readonly cashflowService: CashflowService) {}

  @Get()
  @ApiOperation({
    summary: 'Money in/out, spending by category, and realized PnL across all linked wallets',
    description: 'Builds in the background on first call or with ?refresh=true; poll until status is "ready".',
  })
  getCashflow(@Req() req: AuthRequest, @Query('refresh') refresh?: string): Promise<CashflowResponse> {
    return this.cashflowService.getReport(req.user.sub, refresh === 'true' || refresh === '1');
  }
}
