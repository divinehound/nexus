import { Body, Controller, Delete, Get, Param, ParseUUIDPipe, Post, Put, Query, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { AuthGuard } from '@nestjs/passport';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsIn,
  IsOptional,
  IsString,
  Length,
  Matches,
  MaxLength,
  ValidateNested,
} from 'class-validator';
import type { CashflowResponse } from '@nexus/types';
import { CashflowService, type ReportView } from './cashflow.service';
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

export class ScanTargetDto {
  @IsIn(CHAINS)
  chain!: string;

  @IsString()
  @Length(20, 64)
  @Matches(HASH_OR_ADDRESS)
  address!: string;
}

export class RefreshDto {
  /** Wallet+chain pairs to rescan; omit to rescan everything. */
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(200)
  @ValidateNested({ each: true })
  @Type(() => ScanTargetDto)
  targets?: ScanTargetDto[];

  /** 'full' (default) re-reads each whole history; 'new' only fetches what happened since the last scan. */
  @IsOptional()
  @IsIn(['full', 'new'])
  mode?: 'full' | 'new';
}

export class WalletChainsDto {
  @IsString()
  @Length(42, 42)
  @Matches(/^0x[0-9a-fA-F]{40}$/)
  address!: string;

  @IsArray()
  @ArrayMinSize(1)
  @IsIn(EVM_CHAINS, { each: true })
  chains!: string[];
}

export class ContactLabelDto {
  /** 'address' names everyone behind an address; 'tx' names just one transfer. */
  @IsIn(['address', 'tx'])
  kind!: 'address' | 'tx';

  @IsIn(CHAINS)
  chain!: string;

  /** The address, or the tx hash for kind 'tx'. */
  @IsString()
  @Length(10, 128)
  @Matches(HASH_OR_ADDRESS)
  ref!: string;

  @IsString()
  @Length(1, 100)
  label!: string;
}

export class TxNoteDto {
  @IsIn(CHAINS)
  chain!: string;

  @IsString()
  @Length(10, 128)
  @Matches(HASH_OR_ADDRESS)
  txHash!: string;

  /** Empty removes the note. */
  @IsString()
  @MaxLength(2000)
  note!: string;
}

export class FlagDto {
  @IsIn(CHAINS)
  chain!: string;

  @IsString()
  @Length(10, 128)
  @Matches(HASH_OR_ADDRESS)
  txHash!: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string;
}

/** ?wallet= and ?chain= narrow the returned report; they never change what's scanned. */
const view = (wallet?: string, chain?: string): ReportView => ({
  wallet: wallet || undefined,
  chain: chain || undefined,
});

@ApiTags('me')
@ApiBearerAuth()
@UseGuards(AuthGuard('jwt'))
@Controller('me/cashflow')
export class CashflowController {
  constructor(private readonly cashflowService: CashflowService) {}

  @Get()
  @ApiOperation({
    summary: 'Money in/out, spending by category, and realized PnL across all linked wallets',
    description:
      'Loads saved scans (scanning only wallets/chains never scanned) in the background; ?refresh=true rescans everything. Poll until status is "ready".',
  })
  getCashflow(
    @Req() req: AuthRequest,
    @Query('refresh') refresh?: string,
    @Query('wallet') wallet?: string,
    @Query('chain') chain?: string,
  ): Promise<CashflowResponse> {
    return this.cashflowService.getReport(req.user.sub, refresh === 'true' || refresh === '1', view(wallet, chain));
  }

  @Post('refresh')
  @ApiOperation({
    summary:
      'Rescan some wallet+chain pairs (or all, with no targets) — fully, or only new activity since the last scan (mode=new)',
  })
  refresh(
    @Req() req: AuthRequest,
    @Body() body: RefreshDto,
    @Query('wallet') wallet?: string,
    @Query('chain') chain?: string,
  ): Promise<CashflowResponse> {
    return this.cashflowService.refresh(req.user.sub, body.targets, view(wallet, chain), body.mode ?? 'full');
  }

  @Put('wallet-chains')
  @ApiOperation({ summary: 'Choose which EVM chains are scanned for one of your EVM wallets' })
  setWalletChains(
    @Req() req: AuthRequest,
    @Body() body: WalletChainsDto,
    @Query('wallet') wallet?: string,
    @Query('chain') chain?: string,
  ): Promise<CashflowResponse> {
    return this.cashflowService.setWalletChains(req.user.sub, body.address, body.chains, view(wallet, chain));
  }

  @Post('flags')
  @ApiOperation({ summary: 'Flag a transaction as read wrong (or missing) so it can be re-imported on its own' })
  addFlag(
    @Req() req: AuthRequest,
    @Body() body: FlagDto,
    @Query('wallet') wallet?: string,
    @Query('chain') chain?: string,
  ): Promise<CashflowResponse> {
    return this.cashflowService.addFlag(req.user.sub, body, view(wallet, chain));
  }

  @Delete('flags/:id')
  @ApiOperation({ summary: 'Remove a flag' })
  removeFlag(
    @Req() req: AuthRequest,
    @Param('id', ParseUUIDPipe) id: string,
    @Query('wallet') wallet?: string,
    @Query('chain') chain?: string,
  ): Promise<CashflowResponse> {
    return this.cashflowService.removeFlag(req.user.sub, id, view(wallet, chain));
  }

  @Post('flags/reimport')
  @ApiOperation({ summary: 'Re-read only the flagged transactions from the chain' })
  reimportFlags(
    @Req() req: AuthRequest,
    @Query('wallet') wallet?: string,
    @Query('chain') chain?: string,
  ): Promise<CashflowResponse> {
    return this.cashflowService.reimportFlags(req.user.sub, view(wallet, chain));
  }

  @Post('links')
  @ApiOperation({
    summary: 'Link two transactions as one move between your wallets (kind=link), or reject an automatic pairing (kind=unlink)',
  })
  addLink(
    @Req() req: AuthRequest,
    @Body() body: TxLinkDto,
    @Query('wallet') wallet?: string,
    @Query('chain') chain?: string,
  ): Promise<CashflowResponse> {
    return this.cashflowService.addLink(req.user.sub, body, view(wallet, chain));
  }

  @Delete('links/:id')
  @ApiOperation({ summary: 'Remove a manual link or unlink' })
  removeLink(
    @Req() req: AuthRequest,
    @Param('id', ParseUUIDPipe) id: string,
    @Query('wallet') wallet?: string,
    @Query('chain') chain?: string,
  ): Promise<CashflowResponse> {
    return this.cashflowService.removeLink(req.user.sub, id, view(wallet, chain));
  }

  @Post('address-tags')
  @ApiOperation({ summary: 'Mark an address as your account at a centralized exchange' })
  addAddressTag(
    @Req() req: AuthRequest,
    @Body() body: AddressTagDto,
    @Query('wallet') wallet?: string,
    @Query('chain') chain?: string,
  ): Promise<CashflowResponse> {
    return this.cashflowService.addAddressTag(req.user.sub, body, view(wallet, chain));
  }

  @Put('tx-notes')
  @ApiOperation({ summary: 'Set (or clear, with an empty note) your note on a transaction' })
  setTxNote(
    @Req() req: AuthRequest,
    @Body() body: TxNoteDto,
    @Query('wallet') wallet?: string,
    @Query('chain') chain?: string,
  ): Promise<CashflowResponse> {
    return this.cashflowService.setTxNote(req.user.sub, body, view(wallet, chain));
  }

  @Post('contact-labels')
  @ApiOperation({ summary: 'Name the person behind an address or one transfer' })
  addContactLabel(
    @Req() req: AuthRequest,
    @Body() body: ContactLabelDto,
    @Query('wallet') wallet?: string,
    @Query('chain') chain?: string,
  ): Promise<CashflowResponse> {
    return this.cashflowService.addContactLabel(req.user.sub, body, view(wallet, chain));
  }

  @Delete('contact-labels/:id')
  @ApiOperation({ summary: 'Remove a person name from an address or transfer' })
  removeContactLabel(
    @Req() req: AuthRequest,
    @Param('id', ParseUUIDPipe) id: string,
    @Query('wallet') wallet?: string,
    @Query('chain') chain?: string,
  ): Promise<CashflowResponse> {
    return this.cashflowService.removeContactLabel(req.user.sub, id, view(wallet, chain));
  }

  @Delete('address-tags/:id')
  @ApiOperation({ summary: 'Remove an exchange tag' })
  removeAddressTag(
    @Req() req: AuthRequest,
    @Param('id', ParseUUIDPipe) id: string,
    @Query('wallet') wallet?: string,
    @Query('chain') chain?: string,
  ): Promise<CashflowResponse> {
    return this.cashflowService.removeAddressTag(req.user.sub, id, view(wallet, chain));
  }
}
