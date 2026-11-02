/**
 * Runs against a real Postgres with the migrations applied. Set
 * TEST_DATABASE_URL to a throwaway database to run it; it is skipped otherwise.
 */
import { ConflictException, ForbiddenException, UnauthorizedException } from '@nestjs/common';
import { eq, inArray } from 'drizzle-orm';
import { createDatabase, users, wallets, authIdentities, emailLoginCodes, passkeyCredentials } from '@nexus/database';
import { EmailCodeService } from './email-code.service';
import { IdentitiesService } from './identities.service';
import { PasskeyService } from './passkey.service';
import { AuthService } from './auth.service';
import { JwtService } from '@nestjs/jwt';

jest.mock('@simplewebauthn/server', () => {
  const actual = jest.requireActual('@simplewebauthn/server');
  return {
    ...actual,
    verifyRegistrationResponse: jest.fn(),
    verifyAuthenticationResponse: jest.fn(),
  };
});
// eslint-disable-next-line @typescript-eslint/no-require-imports
const webauthn = require('@simplewebauthn/server');

const url = process.env.TEST_DATABASE_URL;
const describeDb = url ? describe : describe.skip;

describeDb('sign-in methods (database)', () => {
  const db = createDatabase(url ?? 'postgres://unused');
  const config = {
    get: (key: string) =>
      ({
        'jwt.secret': 'test-secret',
        'auth.webauthnRpId': 'localhost',
        'auth.webauthnOrigins': ['http://localhost:3000'],
      })[key],
  } as any;
  const sent: { to: string; code: string }[] = [];
  const sender = { sendCode: async (to: string, code: string) => void sent.push({ to, code }) } as any;
  const codes = new EmailCodeService(db, config, sender);
  const identities = new IdentitiesService(db);
  const passkeys = new PasskeyService(db, config);
  const createdUsers: string[] = [];
  let n = 0;
  const freshEmail = () => `user${Date.now()}-${n++}@example.com`;
  const lastCode = () => sent[sent.length - 1].code;
  const wrong = (code: string) => (code === '000000' ? '111111' : '000000');

  async function track<T extends { id: string }>(user: T) {
    createdUsers.push(user.id);
    return user;
  }

  afterAll(async () => {
    if (createdUsers.length) {
      await db.delete(wallets).where(inArray(wallets.userId, createdUsers));
      await db.delete(users).where(inArray(users.id, createdUsers));
    }
    await db.delete(emailLoginCodes).where(eq(emailLoginCodes.purpose, 'sign_in'));
    await db.delete(emailLoginCodes).where(eq(emailLoginCodes.purpose, 'link'));
    await (db as any).$client.end();
  });

  describe('emailed codes', () => {
    it('signs in with the code once, and only once', async () => {
      const email = freshEmail();
      await codes.send(email.toUpperCase(), 'sign_in');
      const code = lastCode();
      expect(code).toMatch(/^\d{6}$/);
      await expect(codes.verify(email, code, 'sign_in')).resolves.toBe(email);
      await expect(codes.verify(email, code, 'sign_in')).rejects.toBeInstanceOf(UnauthorizedException);
    });

    it('stops accepting the right code after five wrong ones', async () => {
      const email = freshEmail();
      await codes.send(email, 'sign_in');
      const code = lastCode();
      for (let i = 0; i < 5; i++) {
        await expect(codes.verify(email, wrong(code), 'sign_in')).rejects.toMatchObject({
          response: { error: 'WRONG_CODE' },
        });
      }
      await expect(codes.verify(email, code, 'sign_in')).rejects.toMatchObject({
        response: { error: 'TOO_MANY_ATTEMPTS' },
      });
    });

    it('only the newest code works', async () => {
      const email = freshEmail();
      await codes.send(email, 'sign_in');
      const first = lastCode();
      await codes.send(email, 'sign_in');
      const second = lastCode();
      if (first !== second) {
        await expect(codes.verify(email, first, 'sign_in')).rejects.toBeInstanceOf(UnauthorizedException);
      }
      await expect(codes.verify(email, second, 'sign_in')).resolves.toBe(email);
    });

    it('caps wrong tries per address across codes for the day', async () => {
      const email = freshEmail();
      // Four codes, five wrong tries each = 20.
      for (let c = 0; c < 4; c++) {
        await codes.send(email, 'sign_in');
        const code = lastCode();
        for (let i = 0; i < 5; i++) await codes.verify(email, wrong(code), 'sign_in').catch(() => undefined);
      }
      await expect(codes.send(email, 'sign_in')).rejects.toMatchObject({ response: { error: 'TOO_MANY_ATTEMPTS' } });
    });

    it("a right code doesn't count as a wrong try", async () => {
      const email = freshEmail();
      await codes.send(email, 'sign_in');
      await codes.verify(email, lastCode(), 'sign_in');
      const [row] = await db.select().from(emailLoginCodes).where(eq(emailLoginCodes.email, email));
      expect(row.attempts).toBe(0);
    });

    it("one user's link code doesn't cancel another user's", async () => {
      const a = await track((await db.insert(users).values({}).returning())[0]);
      const b = await track((await db.insert(users).values({}).returning())[0]);
      const email = freshEmail();
      await codes.send(email, 'link', a.id);
      const codeA = lastCode();
      await codes.send(email, 'link', b.id);
      await expect(codes.verify(email, codeA, 'link', a.id)).resolves.toBe(email);
    });

    it('limits how many codes one address is sent', async () => {
      const email = freshEmail();
      for (let i = 0; i < 5; i++) await codes.send(email, 'sign_in');
      await expect(codes.send(email, 'sign_in')).rejects.toMatchObject({ status: 429 });
    });

    it('a link code works only for the user who asked for it', async () => {
      const a = await track((await db.insert(users).values({}).returning())[0]);
      const b = await track((await db.insert(users).values({}).returning())[0]);
      const email = freshEmail();
      await codes.send(email, 'link', a.id);
      const code = lastCode();
      await expect(codes.verify(email, code, 'link', b.id)).rejects.toBeInstanceOf(UnauthorizedException);
      await expect(codes.verify(email, code, 'sign_in')).rejects.toBeInstanceOf(UnauthorizedException);
      await expect(codes.verify(email, code, 'link', a.id)).resolves.toBe(email);
    });
  });

  describe('identities', () => {
    it('signing in twice with an email finds the same user', async () => {
      const email = freshEmail();
      const first = await track(await identities.signIn('email', email, email));
      const again = await identities.signIn('email', email, email);
      expect(again.id).toBe(first.id);
      expect(first.email).toBe(email);
    });

    it('Google with the same verified email reaches the email user', async () => {
      const email = freshEmail();
      const byEmail = await track(await identities.signIn('email', email, email));
      const byGoogle = await identities.signIn('google', `g-${email}`, email, { displayName: 'G' });
      expect(byGoogle.id).toBe(byEmail.id);
    });

    it('two sign-ins at once with a new identity make one user', async () => {
      const email = freshEmail();
      const [a, b] = await Promise.all([
        identities.signIn('google', `race-${email}`, null),
        identities.signIn('google', `race-${email}`, null),
      ]);
      await track(a);
      expect(a.id).toBe(b.id);
      const rows = await db.query.authIdentities.findMany({
        where: eq(authIdentities.subject, `race-${email}`),
      });
      expect(rows).toHaveLength(1);
    });

    it('keeps the Google email current, so the same-email match follows it', async () => {
      const oldEmail = freshEmail();
      const newEmail = freshEmail();
      const user = await track(await identities.signIn('google', `g-move-${oldEmail}`, oldEmail));
      await identities.signIn('google', `g-move-${oldEmail}`, newEmail);
      const byOld = await track(await identities.signIn('email', oldEmail, oldEmail));
      expect(byOld.id).not.toBe(user.id);
      const byNew = await identities.signIn('email', newEmail, newEmail);
      expect(byNew.id).toBe(user.id);
    });

    it("won't link an identity another user signs in with", async () => {
      const email = freshEmail();
      await track(await identities.signIn('email', email, email));
      const other = await track((await db.insert(users).values({}).returning())[0]);
      await expect(identities.link(other.id, 'email', email, email)).rejects.toBeInstanceOf(ConflictException);
    });

    it("won't remove the last way to sign in, but will once a wallet is linked", async () => {
      const email = freshEmail();
      const user = await track(await identities.signIn('email', email, email));
      const { identities: rows } = await identities.list(user.id);
      await expect(identities.removeIdentity(user.id, rows[0].id)).rejects.toBeInstanceOf(ForbiddenException);

      await db.insert(wallets).values({ userId: user.id, chain: 'ethereum', address: `0x${Date.now().toString(16)}${n++}` });
      await expect(identities.removeIdentity(user.id, rows[0].id)).resolves.toEqual({ success: true });
    });
  });

  describe('refresh', () => {
    const jwt = new JwtService({ secret: 'test-secret' });
    const auth = new AuthService(db, jwt, config, {} as any);

    it('keeps a wallet address only while the wallet is still the user\'s', async () => {
      const user = await track((await db.insert(users).values({}).returning())[0]);
      const lower = `0x${'ab'.repeat(19)}${(n++ % 256).toString(16).padStart(2, '0')}`;
      const [wallet] = await db.insert(wallets).values({ userId: user.id, chain: 'ethereum', address: lower }).returning();
      const signedAs = lower.toUpperCase().replace('0X', '0x');
      const refreshToken = jwt.sign({ sub: user.id, address: signedAs, role: 'user' });

      const kept = jwt.decode((await auth.refresh(refreshToken)).accessToken) as { address: string | null };
      expect(kept.address).toBe(signedAs);

      await db.delete(wallets).where(eq(wallets.id, wallet.id));
      const dropped = jwt.decode((await auth.refresh(refreshToken)).accessToken) as { address: string | null };
      expect(dropped.address).toBeNull();
    });
  });

  describe('passkeys', () => {
    const fakeRegistration = (id: string) => ({
      verified: true,
      registrationInfo: {
        credential: { id, publicKey: new Uint8Array([1, 2, 3]), counter: 0, transports: ['internal'] },
        credentialDeviceType: 'multiDevice',
        credentialBackedUp: true,
      },
    });

    it('signs up with a passkey, then signs in with it', async () => {
      const credentialId = `cred-${Date.now()}`;
      const { challengeId } = await passkeys.registrationOptions(null);
      webauthn.verifyRegistrationResponse.mockResolvedValueOnce(fakeRegistration(credentialId));
      const user = await track(await passkeys.verifyRegistration(challengeId, { id: credentialId } as any, null, 'Laptop'));

      const auth = await passkeys.authenticationOptions();
      webauthn.verifyAuthenticationResponse.mockResolvedValueOnce({
        verified: true,
        authenticationInfo: { newCounter: 7 },
      });
      const signedIn = await passkeys.verifyAuthentication(auth.challengeId, { id: credentialId } as any);
      expect(signedIn.id).toBe(user.id);

      const stored = await db.query.passkeyCredentials.findFirst({
        where: eq(passkeyCredentials.credentialId, credentialId),
      });
      expect(stored).toMatchObject({ counter: 7, name: 'Laptop', backedUp: true });

      // The challenge was used up.
      await expect(passkeys.verifyAuthentication(auth.challengeId, { id: credentialId } as any)).rejects.toBeInstanceOf(
        UnauthorizedException,
      );
    });

    it("a challenge to add a passkey can't be finished by someone else", async () => {
      const a = await track((await db.insert(users).values({}).returning())[0]);
      const b = await track((await db.insert(users).values({}).returning())[0]);
      const { challengeId } = await passkeys.registrationOptions(a.id);
      webauthn.verifyRegistrationResponse.mockResolvedValue(fakeRegistration(`cred-x-${Date.now()}`));
      await expect(passkeys.verifyRegistration(challengeId, {} as any, b.id)).rejects.toBeInstanceOf(UnauthorizedException);

      const signUp = await passkeys.registrationOptions(null);
      await expect(passkeys.verifyRegistration(signUp.challengeId, {} as any, a.id)).rejects.toBeInstanceOf(
        UnauthorizedException,
      );
      webauthn.verifyRegistrationResponse.mockReset();
    });

    it('an unknown passkey is refused', async () => {
      const { challengeId } = await passkeys.authenticationOptions();
      await expect(passkeys.verifyAuthentication(challengeId, { id: 'nope' } as any)).rejects.toMatchObject({
        response: { error: 'UNKNOWN_PASSKEY' },
      });
    });
  });
});
