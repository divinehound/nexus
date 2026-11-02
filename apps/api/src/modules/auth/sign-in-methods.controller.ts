import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { AuthGuard } from '@nestjs/passport';
import { Throttle } from '@nestjs/throttler';
import type { RegistrationResponseJSON } from '@simplewebauthn/server';
import { EmailCodeService, normalizeEmail } from './email-code.service';
import { GoogleAuthService } from './google-auth.service';
import { IdentitiesService } from './identities.service';
import { PasskeyService } from './passkey.service';

interface AuthRequest {
  user: { sub: string };
}

/** The signed-in user's ways to sign in besides wallets (wallets live under /me/wallets). */
@ApiTags('me')
@ApiBearerAuth()
@UseGuards(AuthGuard('jwt'))
@Controller('me/sign-in-methods')
export class SignInMethodsController {
  constructor(
    private readonly identities: IdentitiesService,
    private readonly emailCodes: EmailCodeService,
    private readonly google: GoogleAuthService,
    private readonly passkeys: PasskeyService,
  ) {}

  @Get()
  @ApiOperation({ summary: 'List linked email, Google and passkey sign-in methods' })
  list(@Req() req: AuthRequest) {
    return this.identities.list(req.user.sub);
  }

  @Post('email/send-code')
  @HttpCode(200)
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @ApiOperation({ summary: 'Email a code to add that address as a sign-in method' })
  async sendEmailCode(@Req() req: AuthRequest, @Body() body: { email: string }) {
    const email = normalizeEmail(body?.email);
    await this.identities.assertLinkable(req.user.sub, 'email', email);
    return this.emailCodes.send(email, 'link', req.user.sub);
  }

  @Post('email/verify')
  @HttpCode(200)
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @ApiOperation({ summary: 'Add an email sign-in method with the emailed code' })
  async verifyEmailCode(@Req() req: AuthRequest, @Body() body: { email: string; code: string }) {
    const email = await this.emailCodes.verify(body?.email, body?.code, 'link', req.user.sub);
    await this.identities.link(req.user.sub, 'email', email, email);
    return this.identities.list(req.user.sub);
  }

  @Post('google')
  @HttpCode(200)
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @ApiOperation({ summary: 'Add a Google account as a sign-in method' })
  async linkGoogle(@Req() req: AuthRequest, @Body() body: { credential: string }) {
    const profile = await this.google.verifyCredential(body?.credential);
    await this.identities.link(req.user.sub, 'google', profile.sub, profile.email);
    return this.identities.list(req.user.sub);
  }

  @Delete('identities/:id')
  @ApiOperation({ summary: 'Remove an email or Google sign-in method' })
  removeIdentity(@Req() req: AuthRequest, @Param('id', ParseUUIDPipe) id: string) {
    return this.identities.removeIdentity(req.user.sub, id);
  }

  @Post('passkeys/options')
  @HttpCode(200)
  @ApiOperation({ summary: 'Start adding a passkey' })
  passkeyOptions(@Req() req: AuthRequest) {
    return this.passkeys.registrationOptions(req.user.sub);
  }

  @Post('passkeys/verify')
  @HttpCode(200)
  @ApiOperation({ summary: 'Finish adding a passkey' })
  async passkeyVerify(
    @Req() req: AuthRequest,
    @Body() body: { challengeId: string; response: RegistrationResponseJSON; name?: string },
  ) {
    await this.passkeys.verifyRegistration(body?.challengeId, body?.response, req.user.sub, body?.name);
    return this.identities.list(req.user.sub);
  }

  @Patch('passkeys/:id')
  @ApiOperation({ summary: 'Rename a passkey' })
  renamePasskey(@Req() req: AuthRequest, @Param('id', ParseUUIDPipe) id: string, @Body() body: { name: string }) {
    return this.identities.renamePasskey(req.user.sub, id, body?.name);
  }

  @Delete('passkeys/:id')
  @ApiOperation({ summary: 'Remove a passkey' })
  removePasskey(@Req() req: AuthRequest, @Param('id', ParseUUIDPipe) id: string) {
    return this.identities.removePasskey(req.user.sub, id);
  }
}
