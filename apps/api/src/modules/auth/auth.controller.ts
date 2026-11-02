import { Controller, Post, Get, Body, UseGuards, Req, HttpCode } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { AuthGuard } from '@nestjs/passport';
import { Throttle } from '@nestjs/throttler';
import type { AuthenticationResponseJSON, RegistrationResponseJSON } from '@simplewebauthn/server';
import { AuthService } from './auth.service';
import { EmailCodeService } from './email-code.service';
import { EmailSenderService } from './email-sender.service';
import { GoogleAuthService } from './google-auth.service';
import { IdentitiesService } from './identities.service';
import { PasskeyService } from './passkey.service';

@ApiTags('auth')
@Controller('auth')
export class AuthController {
  constructor(
    private readonly authService: AuthService,
    private readonly emailCodes: EmailCodeService,
    private readonly emailSender: EmailSenderService,
    private readonly google: GoogleAuthService,
    private readonly identities: IdentitiesService,
    private readonly passkeys: PasskeyService,
  ) {}

  @Get('methods')
  @ApiOperation({ summary: 'Which sign-in methods are set up on this server' })
  getMethods() {
    return {
      wallet: true,
      email: this.emailSender.isAvailable(),
      google: !!this.google.clientId(),
      googleClientId: this.google.clientId() || null,
      passkey: true,
    };
  }

  @Post('email/send-code')
  @HttpCode(200)
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @ApiOperation({ summary: 'Email a one-time sign-in code' })
  async sendEmailCode(@Body() body: { email: string }) {
    return this.emailCodes.send(body?.email, 'sign_in');
  }

  @Post('email/verify')
  @HttpCode(200)
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @ApiOperation({ summary: 'Sign in with an emailed code and get JWT tokens' })
  async verifyEmailCode(@Body() body: { email: string; code: string }) {
    const email = await this.emailCodes.verify(body?.email, body?.code, 'sign_in');
    const user = await this.identities.signIn('email', email, email);
    return this.authService.issueTokensForUser(user.id);
  }

  @Post('google')
  @HttpCode(200)
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @ApiOperation({ summary: 'Sign in with a Google ID token and get JWT tokens' })
  async signInWithGoogle(@Body() body: { credential: string }) {
    const profile = await this.google.verifyCredential(body?.credential);
    const user = await this.identities.signIn('google', profile.sub, profile.email, {
      displayName: profile.name,
      avatarUrl: profile.picture,
    });
    return this.authService.issueTokensForUser(user.id);
  }

  @Post('passkey/options')
  @HttpCode(200)
  @ApiOperation({ summary: 'Start a passkey sign-in' })
  passkeyOptions() {
    return this.passkeys.authenticationOptions();
  }

  @Post('passkey/verify')
  @HttpCode(200)
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @ApiOperation({ summary: 'Finish a passkey sign-in and get JWT tokens' })
  async passkeyVerify(@Body() body: { challengeId: string; response: AuthenticationResponseJSON }) {
    const user = await this.passkeys.verifyAuthentication(body?.challengeId, body?.response);
    return this.authService.issueTokensForUser(user.id);
  }

  @Post('passkey/register/options')
  @HttpCode(200)
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @ApiOperation({ summary: 'Start creating a new account with a passkey' })
  passkeySignUpOptions() {
    return this.passkeys.registrationOptions(null);
  }

  @Post('passkey/register/verify')
  @HttpCode(200)
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @ApiOperation({ summary: 'Finish creating a new account with a passkey and get JWT tokens' })
  async passkeySignUpVerify(@Body() body: { challengeId: string; response: RegistrationResponseJSON; name?: string }) {
    const user = await this.passkeys.verifyRegistration(body?.challengeId, body?.response, null, body?.name);
    return this.authService.issueTokensForUser(user.id);
  }

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
