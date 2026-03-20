import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { AuthGuard } from '@nestjs/passport';
import { MeService } from './me.service';

interface AuthRequest {
  user: { sub: string };
}

@ApiTags('me')
@ApiBearerAuth()
@UseGuards(AuthGuard('jwt'))
@Controller('me')
export class MeController {
  constructor(private readonly meService: MeService) {}

  @Get()
  @ApiOperation({ summary: 'Get current profile and linked wallets' })
  getMe(@Req() req: AuthRequest) {
    return this.meService.getMe(req.user.sub);
  }

  @Patch('profile')
  @ApiOperation({ summary: 'Update current user profile fields' })
  patchProfile(
    @Req() req: AuthRequest,
    @Body() body: { displayName?: string; avatarUrl?: string; bio?: string },
  ) {
    return this.meService.updateProfile(req.user.sub, body);
  }

  @Post('wallets/challenge')
  @ApiOperation({ summary: 'Create wallet linking challenge message' })
  createWalletChallenge(
    @Req() req: AuthRequest,
    @Body() body: { chain: string; address: string; purpose: 'link_wallet' },
  ) {
    return this.meService.createWalletChallenge(req.user.sub, body);
  }

  @Post('wallets/verify')
  @ApiOperation({ summary: 'Verify wallet ownership and link wallet' })
  verifyWallet(
    @Req() req: AuthRequest,
    @Body() body: { chain: string; address: string; signature: string; message: string },
  ) {
    return this.meService.verifyWallet(req.user.sub, body);
  }

  @Post('wallets/move')
  @ApiOperation({ summary: 'Confirm and transfer wallet ownership to current user' })
  moveWallet(
    @Req() req: AuthRequest,
    @Body()
    body: {
      chain: string;
      address: string;
      confirmationToken: string;
      signature: string;
      message: string;
    },
  ) {
    return this.meService.moveWallet(req.user.sub, body);
  }

  @Get('wallets')
  @ApiOperation({ summary: 'List current user wallets' })
  getWallets(@Req() req: AuthRequest) {
    return this.meService.listWallets(req.user.sub);
  }

  @Patch('wallets/:id/primary')
  @ApiOperation({ summary: 'Set primary wallet' })
  setPrimaryWallet(@Req() req: AuthRequest, @Param('id') id: string) {
    return this.meService.setPrimaryWallet(req.user.sub, id);
  }

  @Delete('wallets/:id')
  @ApiOperation({ summary: 'Delete linked wallet (cannot remove final wallet)' })
  deleteWallet(@Req() req: AuthRequest, @Param('id') id: string) {
    return this.meService.deleteWallet(req.user.sub, id);
  }
}
