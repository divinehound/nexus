import { ConflictException, ForbiddenException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { and, asc, eq, inArray, isNull, sql } from 'drizzle-orm';
import { DATABASE_TOKEN } from '../../common/database/database.module';
import { type Database, authIdentities, passkeyCredentials, users, wallets } from '@nexus/database';

export type IdentityProvider = 'email' | 'google';

/** Providers that prove control of an email address, so an account found by one can be reached by the other. */
const EMAIL_PROVING_PROVIDERS: IdentityProvider[] = ['email', 'google'];

/**
 * Email and Google identities, and the rules that tie them (and passkeys) to
 * a Nexus user. Wallet sign-in keeps its own path in AuthService.
 */
@Injectable()
export class IdentitiesService {
  constructor(@Inject(DATABASE_TOKEN) private readonly db: Database) {}

  /**
   * The user signing in with this identity. In order: the user it already
   * belongs to; the user who has the same verified email through the other
   * email-proving provider (a Google account and an emailed code both prove
   * the address); otherwise a new user.
   */
  async signIn(
    provider: IdentityProvider,
    subject: string,
    email: string | null,
    profile: { displayName?: string | null; avatarUrl?: string | null } = {},
  ) {
    const existing = await this.findIdentity(provider, subject);
    if (existing) {
      // Keep the provider's current address, so the same-email match below never uses a stale one.
      await this.touch(existing.id, existing.userId, email);
      return this.getUser(existing.userId);
    }

    let userId: string | null = null;
    if (email) {
      const sameEmail = await this.db.query.authIdentities.findFirst({
        where: and(eq(authIdentities.email, email), inArray(authIdentities.provider, EMAIL_PROVING_PROVIDERS)),
        orderBy: [asc(authIdentities.createdAt)],
      });
      userId = sameEmail?.userId ?? null;
    }

    let createdUserId: string | null = null;
    if (!userId) {
      const [created] = await this.db
        .insert(users)
        .values({ email, displayName: profile.displayName ?? null, avatarUrl: profile.avatarUrl ?? null })
        .returning();
      userId = created.id;
      createdUserId = created.id;
    }

    const identity = await this.insertIdentity(userId, provider, subject, email);
    if (createdUserId && identity.userId !== createdUserId) {
      // A concurrent sign-in saved this identity first; drop the empty user we made.
      await this.db.delete(users).where(eq(users.id, createdUserId));
    }
    await this.touch(identity.id, identity.userId);
    return this.getUser(identity.userId);
  }

  /** Refuses up front when the identity already signs in to another account. */
  async assertLinkable(userId: string, provider: IdentityProvider, subject: string) {
    const existing = await this.findIdentity(provider, subject);
    if (existing && existing.userId !== userId) {
      throw new ConflictException({
        error: 'IDENTITY_IN_USE',
        message: 'That email already signs in to another Nexus account.',
      });
    }
  }

  /** Add an identity to the signed-in user. Refuses one that belongs to someone else. */
  async link(userId: string, provider: IdentityProvider, subject: string, email: string | null) {
    const existing = await this.findIdentity(provider, subject);
    if (existing) {
      if (existing.userId === userId) return existing;
      throw new ConflictException({
        error: 'IDENTITY_IN_USE',
        message:
          provider === 'google'
            ? 'That Google account already signs in to another Nexus account.'
            : 'That email already signs in to another Nexus account.',
      });
    }
    const identity = await this.insertIdentity(userId, provider, subject, email);
    if (identity.userId !== userId) {
      throw new ConflictException({ error: 'IDENTITY_IN_USE', message: 'That sign-in method belongs to another account.' });
    }
    if (email) {
      await this.db
        .update(users)
        .set({ email })
        .where(and(eq(users.id, userId), isNull(users.email)));
    }
    return identity;
  }

  async list(userId: string) {
    const [identities, passkeys] = await Promise.all([
      this.db.query.authIdentities.findMany({
        where: eq(authIdentities.userId, userId),
        orderBy: [authIdentities.createdAt],
      }),
      this.db.query.passkeyCredentials.findMany({
        where: eq(passkeyCredentials.userId, userId),
        orderBy: [passkeyCredentials.createdAt],
      }),
    ]);
    return {
      identities: identities.map((i) => ({
        id: i.id,
        provider: i.provider,
        email: i.email,
        createdAt: i.createdAt,
        lastUsedAt: i.lastUsedAt,
      })),
      passkeys: passkeys.map((p) => ({
        id: p.id,
        name: p.name,
        deviceType: p.deviceType,
        backedUp: p.backedUp,
        createdAt: p.createdAt,
        lastUsedAt: p.lastUsedAt,
      })),
    };
  }

  async removeIdentity(userId: string, identityId: string) {
    await this.db.transaction(async (tx) => {
      const row = await tx.query.authIdentities.findFirst({
        where: and(eq(authIdentities.id, identityId), eq(authIdentities.userId, userId)),
      });
      if (!row) throw new NotFoundException('Sign-in method not found');
      await this.assertNotLast(tx, userId);
      await tx.delete(authIdentities).where(eq(authIdentities.id, identityId));
    });
    return { success: true };
  }

  async removePasskey(userId: string, passkeyId: string) {
    await this.db.transaction(async (tx) => {
      const row = await tx.query.passkeyCredentials.findFirst({
        where: and(eq(passkeyCredentials.id, passkeyId), eq(passkeyCredentials.userId, userId)),
      });
      if (!row) throw new NotFoundException('Passkey not found');
      await this.assertNotLast(tx, userId);
      await tx.delete(passkeyCredentials).where(eq(passkeyCredentials.id, passkeyId));
    });
    return { success: true };
  }

  async renamePasskey(userId: string, passkeyId: string, name: string) {
    const trimmed = (name ?? '').trim().slice(0, 100);
    const [row] = await this.db
      .update(passkeyCredentials)
      .set({ name: trimmed || null })
      .where(and(eq(passkeyCredentials.id, passkeyId), eq(passkeyCredentials.userId, userId)))
      .returning();
    if (!row) throw new NotFoundException('Passkey not found');
    return { success: true };
  }

  /** How many ways the user can sign in: verified wallets, identities and passkeys. */
  async countSignInMethods(db: Pick<Database, 'select'>, userId: string): Promise<number> {
    const [row] = await db
      .select({
        total: sql<number>`(
          (SELECT count(*) FROM ${wallets} WHERE ${wallets.userId} = ${userId})
          + (SELECT count(*) FROM ${authIdentities} WHERE ${authIdentities.userId} = ${userId})
          + (SELECT count(*) FROM ${passkeyCredentials} WHERE ${passkeyCredentials.userId} = ${userId})
        )::int`,
      })
      .from(users)
      .where(eq(users.id, userId));
    return Number(row?.total ?? 0);
  }

  private async assertNotLast(tx: Pick<Database, 'select'>, userId: string) {
    // Lock the user row so two removals can't both pass the check.
    await tx.select({ id: users.id }).from(users).where(eq(users.id, userId)).for('update');
    if ((await this.countSignInMethods(tx, userId)) <= 1) {
      throw new ForbiddenException({
        error: 'LAST_SIGN_IN_METHOD',
        message: 'This is your only way to sign in. Add another one first.',
      });
    }
  }

  private findIdentity(provider: IdentityProvider, subject: string) {
    return this.db.query.authIdentities.findFirst({
      where: and(eq(authIdentities.provider, provider), eq(authIdentities.subject, subject)),
    });
  }

  /** Insert, or return the row a concurrent request inserted first. */
  private async insertIdentity(userId: string, provider: IdentityProvider, subject: string, email: string | null) {
    const [inserted] = await this.db
      .insert(authIdentities)
      .values({ userId, provider, subject, email })
      .onConflictDoNothing({ target: [authIdentities.provider, authIdentities.subject] })
      .returning();
    if (inserted) return inserted;
    const existing = await this.findIdentity(provider, subject);
    if (!existing) throw new ConflictException('Could not save the sign-in method. Try again.');
    return existing;
  }

  private async touch(identityId: string, userId: string, email?: string | null) {
    const now = new Date();
    await this.db
      .update(authIdentities)
      .set(email ? { lastUsedAt: now, email } : { lastUsedAt: now })
      .where(eq(authIdentities.id, identityId));
    await this.db.update(users).set({ lastActiveAt: now }).where(eq(users.id, userId));
  }

  private async getUser(userId: string) {
    const user = await this.db.query.users.findFirst({ where: eq(users.id, userId) });
    if (!user) throw new NotFoundException('User not found');
    return user;
  }
}
