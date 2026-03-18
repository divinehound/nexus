import { Controller, Post, Get, Body, UseGuards, Req } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { AuthGuard } from '@nestjs/passport';
import { AuthService } from './auth.service';

@ApiTags('auth')
@Controller('auth')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  @Post('nonce')
  @ApiOperation({ summary: 'Get a nonce for wallet authentication' })
  getNonce(@Body() body: { address: string }) {
    return this.authService.generateNonce(body.address);
  }

  @Post('verify/evm')
  @ApiOperation({ summary: 'Verify SIWE signature (Ethereum) and get JWT tokens' })
  verifyEvm(@Body() body: { message: string; signature: string }) {
    return this.authService.verifyEvm(body.message, body.signature);
  }

  @Post('verify/solana')
  @ApiOperation({ summary: 'Verify Solana wallet signature and get JWT tokens' })
  verifySolana(@Body() body: { address: string; signature: string }) {
    return this.authService.verifySolana(body.address, body.signature);
  }

  @Post('refresh')
  @ApiOperation({ summary: 'Refresh JWT tokens' })
  refresh(@Body() body: { refreshToken: string }) {
    return this.authService.refresh(body.refreshToken);
  }

  @Get('me')
  @UseGuards(AuthGuard('jwt'))
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Get current authenticated user' })
  getMe(@Req() req: { user: { sub: string } }) {
    return this.authService.getMe(req.user.sub);
  }
}
