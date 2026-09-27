import { Body, Controller, Delete, Get, Param, ParseUUIDPipe, Post, Query, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { AuthGuard } from '@nestjs/passport';
import { IsIn, IsString, Length, Matches } from 'class-validator';
import type { CashflowResponse } from '@nexus/types';
import { CashflowService } from './cashflow.service';
import { EVM_CHAINS } from './evm-activity.fetcher';

interface AuthRequest {
  user: { sub: string };
}

const CHAINS = [...EVM_CHAINS, 'solana'];
// Hex (EVM) or base58 (Solana) — nothing else belongs in a tx hash or address.
const HASH_OR_ADDRESS = /^(0x[0-9a-fA-F]+|[1-9A-HJ-NP-Za-km-z]+)$/;

export class TxLinkDto {
  @IsIn(['link', 'unlink'])
  kind!: 'link' | 'unlink';

  @IsIn(CHAINS)
  fromChain!: string;

  @IsString()
  @Length(10, 128)
  @Matches(HASH_OR_ADDRESS)
  fromTxHash!: string;

  @IsIn(CHAINS)
  toChain!: string;

  @IsString()
  @Length(10, 128)
  @Matches(HASH_OR_ADDRESS)
  toTxHash!: string;
}

export class AddressTagDto {
  @IsIn(CHAINS)
  chain!: string;

  @IsString()
  @Length(20, 64)
  @Matches(HASH_OR_ADDRESS)
  address!: string;

  @IsString()
  @Length(1, 64)
  exchange!: string;
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

  @Post('links')
  @ApiOperation({
    summary: 'Link two transactions as one move between your wallets (kind=link), or reject an automatic pairing (kind=unlink)',
  })
  addLink(@Req() req: AuthRequest, @Body() body: TxLinkDto): Promise<CashflowResponse> {
    return this.cashflowService.addLink(req.user.sub, body);
  }

  @Delete('links/:id')
  @ApiOperation({ summary: 'Remove a manual link or unlink' })
  removeLink(@Req() req: AuthRequest, @Param('id', ParseUUIDPipe) id: string): Promise<CashflowResponse> {
    return this.cashflowService.removeLink(req.user.sub, id);
  }

  @Post('address-tags')
  @ApiOperation({ summary: 'Mark an address as your account at a centralized exchange' })
  addAddressTag(@Req() req: AuthRequest, @Body() body: AddressTagDto): Promise<CashflowResponse> {
    return this.cashflowService.addAddressTag(req.user.sub, body);
  }

  @Delete('address-tags/:id')
  @ApiOperation({ summary: 'Remove an exchange tag' })
  removeAddressTag(@Req() req: AuthRequest, @Param('id', ParseUUIDPipe) id: string): Promise<CashflowResponse> {
    return this.cashflowService.removeAddressTag(req.user.sub, id);
  }
}
