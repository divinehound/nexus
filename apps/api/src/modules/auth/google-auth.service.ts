import { Injectable, Logger, ServiceUnavailableException, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createRemoteJWKSet, jwtVerify } from 'jose';

const GOOGLE_ISSUERS = ['https://accounts.google.com', 'accounts.google.com'];
const GOOGLE_JWKS = createRemoteJWKSet(new URL('https://www.googleapis.com/oauth2/v3/certs'));

export interface GoogleProfile {
  sub: string;
  email: string;
  name: string | null;
  picture: string | null;
}

/**
 * Checks the ID token Google Identity Services hands the browser ("Sign in
 * with Google"). Only needs the client id; no client secret is involved.
 */
@Injectable()
export class GoogleAuthService {
  private readonly logger = new Logger(GoogleAuthService.name);

  constructor(private readonly config: ConfigService) {}

  clientId(): string {
    return this.config.get<string>('auth.googleClientId') || '';
  }

  async verifyCredential(credential: unknown): Promise<GoogleProfile> {
    const clientId = this.clientId();
    if (!clientId) throw new ServiceUnavailableException('Google sign-in is not set up yet.');
    if (typeof credential !== 'string' || !credential) {
      throw new UnauthorizedException('Missing Google credential');
    }

    let payload: Record<string, unknown>;
    try {
      ({ payload } = await jwtVerify(credential, GOOGLE_JWKS, {
        issuer: GOOGLE_ISSUERS,
        audience: clientId,
      }));
    } catch (err) {
      this.logger.warn(`Rejected Google credential: ${err instanceof Error ? err.message : String(err)}`);
      throw new UnauthorizedException('Google sign-in failed. Try again.');
    }

    const email = typeof payload.email === 'string' ? payload.email.trim().toLowerCase() : '';
    if (typeof payload.sub !== 'string' || !payload.sub || !email || payload.email_verified !== true) {
      throw new UnauthorizedException('Your Google account needs a verified email to sign in.');
    }
    return {
      sub: payload.sub,
      email,
      name: typeof payload.name === 'string' ? payload.name : null,
      picture: typeof payload.picture === 'string' ? payload.picture : null,
    };
  }
}
