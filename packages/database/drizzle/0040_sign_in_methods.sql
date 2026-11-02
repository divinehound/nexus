-- Sign-in methods besides wallets: emailed one-time codes, Google, passkeys.
CREATE TABLE IF NOT EXISTS "auth_identities" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "provider" varchar(16) NOT NULL,
  "subject" varchar(255) NOT NULL,
  "email" varchar(255),
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "last_used_at" timestamp with time zone
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "auth_identities_provider_subject_unique" ON "auth_identities" ("provider", "subject");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "auth_identities_user_id_idx" ON "auth_identities" ("user_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "auth_identities_email_idx" ON "auth_identities" ("email");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "email_login_codes" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "email" varchar(255) NOT NULL,
  "purpose" varchar(16) NOT NULL,
  "user_id" uuid REFERENCES "users"("id") ON DELETE CASCADE,
  "code_hash" varchar(64) NOT NULL,
  "attempts" integer DEFAULT 0 NOT NULL,
  "expires_at" timestamp with time zone NOT NULL,
  "consumed_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "email_login_codes_email_idx" ON "email_login_codes" ("email", "created_at");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "passkey_credentials" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "credential_id" text NOT NULL,
  "public_key" text NOT NULL,
  "counter" bigint DEFAULT 0 NOT NULL,
  "transports" varchar(32)[] DEFAULT '{}' NOT NULL,
  "device_type" varchar(32),
  "backed_up" boolean DEFAULT false NOT NULL,
  "name" varchar(100),
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "last_used_at" timestamp with time zone
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "passkey_credentials_credential_id_unique" ON "passkey_credentials" ("credential_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "passkey_credentials_user_id_idx" ON "passkey_credentials" ("user_id");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "webauthn_challenges" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "challenge" varchar(255) NOT NULL,
  "purpose" varchar(16) NOT NULL,
  "user_id" uuid,
  "is_new_user" boolean DEFAULT false NOT NULL,
  "expires_at" timestamp with time zone NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "webauthn_challenges_expires_at_idx" ON "webauthn_challenges" ("expires_at");
