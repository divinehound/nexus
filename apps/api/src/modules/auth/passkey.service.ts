import { BadRequestException, Inject, Injectable, Logger, NotFoundException, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'crypto';
import { and, eq, gt, lt } from 'drizzle-orm';
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
  type AuthenticationResponseJSON,
  type AuthenticatorTransportFuture,
  type RegistrationResponseJSON,
} from '@simplewebauthn/server';
import { DATABASE_TOKEN } from '../../common/database/database.module';
import { type Database, passkeyCredentials, users, wallets, webauthnChallenges } from '@nexus/database';

const CHALLENGE_TTL_MS = 5 * 60 * 1000;
const RP_NAME = 'Nexus';

/** UUID string → its 16 bytes, used as the WebAuthn user handle. */
function uuidToBytes(id: string): Uint8Array<ArrayBuffer> {
  return new Uint8Array(Buffer.from(id.replace(/-/g, ''), 'hex'));
}

/** Passkey (WebAuthn) registration and sign-in. Passkeys are discoverable, so sign-in needs no username. */
@Injectable()
export class PasskeyService {
  private readonly logger = new Logger(PasskeyService.name);

  constructor(
    @Inject(DATABASE_TOKEN) private readonly db: Database,
    private readonly config: ConfigService,
  ) {
    if (process.env.NODE_ENV === 'production' && this.rpId() === 'localhost') {
      this.logger.warn('Passkeys are tied to "localhost". Set WEB_URL (or WEBAUTHN_RP_ID and WEBAUTHN_ORIGINS).');
    }
  }

  /**
   * Options to create a passkey. With a user id it is added to that user;
   * without one it will make a new account when verified.
   */
  async registrationOptions(userId: string | null) {
    const isNewUser = !userId;
    const ownerId = userId ?? randomUUID();

    let userName = 'Nexus account';
    let excludeCredentials: { id: string; transports?: AuthenticatorTransportFuture[] }[] = [];
    if (userId) {
      const user = await this.db.query.users.findFirst({ where: eq(users.id, userId) });
      if (!user) throw new NotFoundException('User not found');
      const primary = user.primaryWalletId
        ? await this.db.query.wallets.findFirst({ where: eq(wallets.id, user.primaryWalletId) })
        : null;
      userName = user.email || user.displayName || primary?.ensName || primary?.address || userName;
      const existing = await this.db.query.passkeyCredentials.findMany({
        where: eq(passkeyCredentials.userId, userId),
      });
      excludeCredentials = existing.map((c) => ({
        id: c.credentialId,
        transports: c.transports as AuthenticatorTransportFuture[],
      }));
    }

    const options = await generateRegistrationOptions({
      rpName: RP_NAME,
      rpID: this.rpId(),
      userID: uuidToBytes(ownerId),
      userName,
      attestationType: 'none',
      excludeCredentials,
      authenticatorSelection: { residentKey: 'required', userVerification: 'required' },
    });

    const challengeId = await this.saveChallenge(options.challenge, 'register', ownerId, isNewUser);
    return { challengeId, options };
  }

  /** Verifies a new passkey and saves it. Returns the user it belongs to. */
  async verifyRegistration(
    challengeId: unknown,
    response: RegistrationResponseJSON,
    signedInUserId: string | null,
    name?: string | null,
  ) {
    const challenge = await this.takeChallenge(challengeId, 'register');
    if (!challenge.userId) throw new UnauthorizedException('Passkey request expired. Try again.');
    if (challenge.isNewUser ? signedInUserId !== null : challenge.userId !== signedInUserId) {
      throw new UnauthorizedException('Passkey request expired. Try again.');
    }

    let verification;
    try {
      verification = await verifyRegistrationResponse({
        response,
        expectedChallenge: challenge.challenge,
        expectedOrigin: this.origins(),
        expectedRPID: this.rpId(),
        requireUserVerification: true,
      });
    } catch (err) {
      this.logger.warn(`Passkey registration rejected: ${err instanceof Error ? err.message : String(err)}`);
      throw new UnauthorizedException('Could not verify the passkey.');
    }
    if (!verification.verified || !verification.registrationInfo) {
      throw new UnauthorizedException('Could not verify the passkey.');
    }
    const { credential, credentialDeviceType, credentialBackedUp } = verification.registrationInfo;

    const taken = await this.db.query.passkeyCredentials.findFirst({
      where: eq(passkeyCredentials.credentialId, credential.id),
    });
    if (taken) throw new BadRequestException('This passkey is already saved.');

    const userId = challenge.userId;
    return this.db
      .transaction(async (tx) => {
      if (challenge.isNewUser) {
        await tx.insert(users).values({ id: userId });
      }
      await tx.insert(passkeyCredentials).values({
        userId,
        credentialId: credential.id,
        publicKey: Buffer.from(credential.publicKey).toString('base64url'),
        counter: credential.counter,
        transports: credential.transports ?? [],
        deviceType: credentialDeviceType,
        backedUp: credentialBackedUp,
        name: (name ?? '').trim().slice(0, 100) || null,
      });
      const user = await tx.query.users.findFirst({ where: eq(users.id, userId) });
      if (!user) throw new NotFoundException('User not found');
      return user;
    })
      .catch((err: unknown) => {
        // The same passkey saved twice at once: the unique index catches the second.
        if ((err as { code?: string })?.code === '23505') throw new BadRequestException('This passkey is already saved.');
        throw err;
      });
  }

  async authenticationOptions() {
    const options = await generateAuthenticationOptions({
      rpID: this.rpId(),
      userVerification: 'required',
    });
    const challengeId = await this.saveChallenge(options.challenge, 'authenticate', null, false);
    return { challengeId, options };
  }

  /** Verifies a passkey sign-in. Returns the user. */
  async verifyAuthentication(challengeId: unknown, response: AuthenticationResponseJSON) {
    const challenge = await this.takeChallenge(challengeId, 'authenticate');
    if (!response?.id) throw new UnauthorizedException('Passkey sign-in failed.');

    const stored = await this.db.query.passkeyCredentials.findFirst({
      where: eq(passkeyCredentials.credentialId, response.id),
    });
    if (!stored) {
      throw new UnauthorizedException({
        error: 'UNKNOWN_PASSKEY',
        message: 'This passkey is not linked to a Nexus account.',
      });
    }

    let verification;
    try {
      verification = await verifyAuthenticationResponse({
        response,
        expectedChallenge: challenge.challenge,
        expectedOrigin: this.origins(),
        expectedRPID: this.rpId(),
        credential: {
          id: stored.credentialId,
          publicKey: new Uint8Array(Buffer.from(stored.publicKey, 'base64url')),
          counter: stored.counter,
          transports: stored.transports as AuthenticatorTransportFuture[],
        },
        requireUserVerification: true,
      });
    } catch (err) {
      this.logger.warn(`Passkey sign-in rejected: ${err instanceof Error ? err.message : String(err)}`);
      throw new UnauthorizedException('Passkey sign-in failed.');
    }
    if (!verification.verified) throw new UnauthorizedException('Passkey sign-in failed.');

    const now = new Date();
    await this.db
      .update(passkeyCredentials)
      .set({ counter: verification.authenticationInfo.newCounter, lastUsedAt: now })
      .where(eq(passkeyCredentials.id, stored.id));
    await this.db.update(users).set({ lastActiveAt: now }).where(eq(users.id, stored.userId));

    const user = await this.db.query.users.findFirst({ where: eq(users.id, stored.userId) });
    if (!user) throw new UnauthorizedException('User not found');
    return user;
  }

  private async saveChallenge(challenge: string, purpose: string, userId: string | null, isNewUser: boolean) {
    // Old challenges are cleared as new ones are made.
    await this.db.delete(webauthnChallenges).where(lt(webauthnChallenges.expiresAt, new Date()));
    const [row] = await this.db
      .insert(webauthnChallenges)
      .values({ challenge, purpose, userId, isNewUser, expiresAt: new Date(Date.now() + CHALLENGE_TTL_MS) })
      .returning({ id: webauthnChallenges.id });
    return row.id;
  }

  /** Loads and deletes a challenge so it can be used once. */
  private async takeChallenge(challengeId: unknown, purpose: string) {
    const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (typeof challengeId !== 'string' || !uuid.test(challengeId)) {
      throw new UnauthorizedException('Passkey request expired. Try again.');
    }
    const [row] = await this.db
      .delete(webauthnChallenges)
      .where(
        and(
          eq(webauthnChallenges.id, challengeId),
          eq(webauthnChallenges.purpose, purpose),
          gt(webauthnChallenges.expiresAt, new Date()),
        ),
      )
      .returning();
    if (!row) throw new UnauthorizedException('Passkey request expired. Try again.');
    return row;
  }

  private rpId(): string {
    return this.config.get<string>('auth.webauthnRpId') || 'localhost';
  }

  private origins(): string[] {
    return this.config.get<string[]>('auth.webauthnOrigins') ?? ['http://localhost:3000'];
  }
}
