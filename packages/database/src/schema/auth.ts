import { pgTable, uuid, varchar, integer, bigint, boolean, timestamp, text, uniqueIndex, index } from 'drizzle-orm/pg-core';
import { users } from './users';

/**
 * Ways to sign in other than a wallet: an email address proved with an
 * emailed code, or a Google account. `subject` is what the provider vouches
 * for: the lowercased email for 'email', Google's stable `sub` for 'google'.
 * `email` is the verified address in both cases.
 */
export const authIdentities = pgTable(
  'auth_identities',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .references(() => users.id, { onDelete: 'cascade' })
      .notNull(),
    provider: varchar('provider', { length: 16 }).notNull(),
    subject: varchar('subject', { length: 255 }).notNull(),
    email: varchar('email', { length: 255 }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
  },
  (table) => [
    uniqueIndex('auth_identities_provider_subject_unique').on(table.provider, table.subject),
    index('auth_identities_user_id_idx').on(table.userId),
    index('auth_identities_email_idx').on(table.email),
  ],
);

/**
 * One-time codes emailed to sign in ('sign_in') or to add an email to the
 * signed-in user ('link', with `userId`). Only an HMAC of the code is kept.
 */
export const emailLoginCodes = pgTable(
  'email_login_codes',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    email: varchar('email', { length: 255 }).notNull(),
    purpose: varchar('purpose', { length: 16 }).notNull(),
    userId: uuid('user_id').references(() => users.id, { onDelete: 'cascade' }),
    codeHash: varchar('code_hash', { length: 64 }).notNull(),
    attempts: integer('attempts').default(0).notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    consumedAt: timestamp('consumed_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [index('email_login_codes_email_idx').on(table.email, table.createdAt)],
);

/** WebAuthn credentials (passkeys). `credentialId` and `publicKey` are base64url. */
export const passkeyCredentials = pgTable(
  'passkey_credentials',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .references(() => users.id, { onDelete: 'cascade' })
      .notNull(),
    credentialId: text('credential_id').notNull(),
    publicKey: text('public_key').notNull(),
    counter: bigint('counter', { mode: 'number' }).default(0).notNull(),
    transports: varchar('transports', { length: 32 }).array().default([]).notNull(),
    deviceType: varchar('device_type', { length: 32 }),
    backedUp: boolean('backed_up').default(false).notNull(),
    name: varchar('name', { length: 100 }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
  },
  (table) => [
    uniqueIndex('passkey_credentials_credential_id_unique').on(table.credentialId),
    index('passkey_credentials_user_id_idx').on(table.userId),
  ],
);

/**
 * Single-use WebAuthn challenges. 'register' rows carry the user the passkey
 * will belong to (an existing user when adding one, a new id when signing up
 * with a passkey); 'authenticate' rows have no user.
 */
export const webauthnChallenges = pgTable('webauthn_challenges', {
  id: uuid('id').primaryKey().defaultRandom(),
  challenge: varchar('challenge', { length: 255 }).notNull(),
  purpose: varchar('purpose', { length: 16 }).notNull(),
  userId: uuid('user_id'),
  isNewUser: boolean('is_new_user').default(false).notNull(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
});
