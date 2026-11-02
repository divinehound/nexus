import { BadRequestException, HttpException, HttpStatus, Inject, Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHmac, randomInt, timingSafeEqual } from 'crypto';
import { and, desc, eq, gt, isNull, lt, sql } from 'drizzle-orm';
import { DATABASE_TOKEN } from '../../common/database/database.module';
import { type Database, emailLoginCodes } from '@nexus/database';
import { EmailSenderService } from './email-sender.service';

export type EmailCodePurpose = 'sign_in' | 'link';

export const EMAIL_CODE_TTL_MS = 10 * 60 * 1000;
export const EMAIL_CODE_MAX_ATTEMPTS = 5;
/** Codes one address may be sent per window, whatever the caller's IP. */
export const EMAIL_CODES_PER_WINDOW = 5;
export const EMAIL_CODE_WINDOW_MS = 15 * 60 * 1000;
/**
 * Wrong tries an address may have across all its codes in a day. Without it a
 * guesser could keep asking for new codes: this caps them at 20 guesses a day.
 */
export const EMAIL_DAILY_FAILED_TRIES = 20;
const DAY_MS = 24 * 60 * 60 * 1000;

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function normalizeEmail(raw: unknown): string {
  const email = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
  if (!email || email.length > 254 || !EMAIL_PATTERN.test(email)) {
    throw new BadRequestException({ error: 'INVALID_EMAIL', message: 'Enter a valid email address.' });
  }
  return email;
}

/** One-time six-digit codes emailed to prove an address. */
@Injectable()
export class EmailCodeService {
  constructor(
    @Inject(DATABASE_TOKEN) private readonly db: Database,
    private readonly config: ConfigService,
    private readonly sender: EmailSenderService,
  ) {}

  async send(rawEmail: unknown, purpose: EmailCodePurpose, userId: string | null = null) {
    const email = normalizeEmail(rawEmail);
    const code = randomInt(0, 1_000_000).toString().padStart(6, '0');

    await this.db.transaction(async (tx) => {
      // One send per address at a time, so parallel requests can't pass the cap together.
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${'email-code:' + email}))`);

      const [{ recent, failed }] = await tx
        .select({
          recent: sql<number>`count(*) FILTER (WHERE ${emailLoginCodes.createdAt} > ${new Date(Date.now() - EMAIL_CODE_WINDOW_MS).toISOString()}::timestamptz)::int`,
          failed: sql<number>`coalesce(sum(${emailLoginCodes.attempts}), 0)::int`,
        })
        .from(emailLoginCodes)
        .where(and(eq(emailLoginCodes.email, email), gt(emailLoginCodes.createdAt, new Date(Date.now() - DAY_MS))));
      if (Number(recent) >= EMAIL_CODES_PER_WINDOW) {
        throw new HttpException(
          { error: 'TOO_MANY_CODES', message: 'Too many codes sent to this email. Try again in 15 minutes.' },
          HttpStatus.TOO_MANY_REQUESTS,
        );
      }
      if (Number(failed) >= EMAIL_DAILY_FAILED_TRIES) {
        throw new HttpException(
          { error: 'TOO_MANY_ATTEMPTS', message: 'Too many wrong codes for this email today. Try again tomorrow.' },
          HttpStatus.TOO_MANY_REQUESTS,
        );
      }

      // Only the newest code works: sign-in codes per address, link codes per address and user.
      await tx
        .update(emailLoginCodes)
        .set({ consumedAt: new Date() })
        .where(
          and(
            eq(emailLoginCodes.email, email),
            eq(emailLoginCodes.purpose, purpose),
            isNull(emailLoginCodes.consumedAt),
            purpose === 'link' && userId ? eq(emailLoginCodes.userId, userId) : undefined,
          ),
        );
      // Old rows are only needed for the daily counts.
      await tx.delete(emailLoginCodes).where(lt(emailLoginCodes.createdAt, new Date(Date.now() - 2 * DAY_MS)));
      await tx.insert(emailLoginCodes).values({
        email,
        purpose,
        userId,
        codeHash: this.hash(email, code),
        expiresAt: new Date(Date.now() + EMAIL_CODE_TTL_MS),
      });
    });

    await this.sender.sendCode(email, code, purpose);
    return { email, expiresInSeconds: EMAIL_CODE_TTL_MS / 1000 };
  }

  /** Checks the code and uses it up. Returns the normalized email it proves. */
  async verify(rawEmail: unknown, rawCode: unknown, purpose: EmailCodePurpose, userId: string | null = null) {
    const email = normalizeEmail(rawEmail);
    const code = typeof rawCode === 'string' ? rawCode.replace(/\s+/g, '') : '';
    if (!/^\d{6}$/.test(code)) {
      throw new BadRequestException({ error: 'INVALID_CODE', message: 'Enter the 6-digit code from the email.' });
    }

    const row = await this.db.query.emailLoginCodes.findFirst({
      where: and(
        eq(emailLoginCodes.email, email),
        eq(emailLoginCodes.purpose, purpose),
        isNull(emailLoginCodes.consumedAt),
        gt(emailLoginCodes.expiresAt, new Date()),
        purpose === 'link' && userId ? eq(emailLoginCodes.userId, userId) : undefined,
      ),
      orderBy: [desc(emailLoginCodes.createdAt)],
    });
    if (!row || (purpose === 'link' && row.userId !== userId)) {
      throw new UnauthorizedException({ error: 'CODE_EXPIRED', message: 'That code has expired. Request a new one.' });
    }
    const [{ failed }] = await this.db
      .select({ failed: sql<number>`coalesce(sum(${emailLoginCodes.attempts}), 0)::int` })
      .from(emailLoginCodes)
      .where(
        and(eq(emailLoginCodes.email, email), gt(emailLoginCodes.createdAt, new Date(Date.now() - DAY_MS))),
      );
    // `attempts` counts wrong tries only: the right one is taken back off when the code is used.
    if (Number(failed) >= EMAIL_DAILY_FAILED_TRIES) {
      throw new UnauthorizedException({
        error: 'TOO_MANY_ATTEMPTS',
        message: 'Too many wrong codes for this email today. Try again tomorrow.',
      });
    }

    // Count the try before checking it, atomically, so parallel guesses can't exceed the limit.
    const [tried] = await this.db
      .update(emailLoginCodes)
      .set({ attempts: sql`${emailLoginCodes.attempts} + 1` })
      .where(
        and(
          eq(emailLoginCodes.id, row.id),
          isNull(emailLoginCodes.consumedAt),
          lt(emailLoginCodes.attempts, EMAIL_CODE_MAX_ATTEMPTS),
        ),
      )
      .returning({ id: emailLoginCodes.id });
    if (!tried) {
      throw new UnauthorizedException({ error: 'TOO_MANY_ATTEMPTS', message: 'Too many wrong tries. Request a new code.' });
    }

    if (!this.matches(row.codeHash, this.hash(email, code))) {
      throw new UnauthorizedException({ error: 'WRONG_CODE', message: 'That code is not right.' });
    }

    // Use it up; if a parallel request got there first, this one fails.
    const [used] = await this.db
      .update(emailLoginCodes)
      .set({ consumedAt: new Date(), attempts: sql`${emailLoginCodes.attempts} - 1` })
      .where(and(eq(emailLoginCodes.id, row.id), isNull(emailLoginCodes.consumedAt)))
      .returning({ id: emailLoginCodes.id });
    if (!used) {
      throw new UnauthorizedException({ error: 'CODE_EXPIRED', message: 'That code has already been used.' });
    }
    return email;
  }

  private hash(email: string, code: string): string {
    return createHmac('sha256', this.config.get<string>('jwt.secret') || '')
      .update(`email-code:${email}:${code}`)
      .digest('hex');
  }

  private matches(a: string, b: string): boolean {
    const left = Buffer.from(a, 'hex');
    const right = Buffer.from(b, 'hex');
    return left.length === right.length && timingSafeEqual(left, right);
  }
}
