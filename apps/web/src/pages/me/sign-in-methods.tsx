import { FormEvent, useCallback, useEffect, useState } from 'react';
import { startRegistration } from '@simplewebauthn/browser';
import type { PublicKeyCredentialCreationOptionsJSON } from '@simplewebauthn/browser';
import { apiFetch } from '@/lib/api';
import { promptDialog } from '@/components/ui/dialogs';
import { authErrorMessage } from '@/lib/auth-errors';
import { useAuthMethods } from '@/hooks/use-auth-methods';
import { GoogleButton } from '@/components/auth/google-button';
import { useAuth } from '@/context/auth-context';

interface SignInMethods {
  identities: { id: string; provider: 'email' | 'google'; email: string | null; createdAt: string; lastUsedAt: string | null }[];
  passkeys: { id: string; name: string | null; backedUp: boolean; createdAt: string; lastUsedAt: string | null }[];
}

function when(date: string | null) {
  return date ? new Date(date).toLocaleDateString() : 'never';
}

/** Email, Google and passkey sign-in for this account (wallets are listed separately). */
export function SignInMethodsSection({ accessToken }: { accessToken: string }) {
  const authMethods = useAuthMethods();
  const { reloadUser } = useAuth();
  const [methods, setMethods] = useState<SignInMethods | null>(null);
  const [email, setEmail] = useState('');
  const [code, setCode] = useState('');
  const [codeSentTo, setCodeSentTo] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const call = useCallback(
    <T,>(path: string, method = 'GET', body?: unknown) =>
      apiFetch<T>(`/me/sign-in-methods${path}`, {
        method,
        token: accessToken,
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
    [accessToken],
  );

  const load = useCallback(async () => {
    try {
      setMethods(await call<SignInMethods>(''));
    } catch (err) {
      setError(authErrorMessage(err, 'Failed to load sign-in methods'));
    }
  }, [call]);

  useEffect(() => {
    void load();
  }, [load]);

  const run = async (key: string, action: () => Promise<void>, success?: string) => {
    setBusy(key);
    setError(null);
    setNotice(null);
    try {
      await action();
      if (success) setNotice(success);
      // The header shows the email for accounts without a wallet.
      reloadUser().catch(() => undefined);
    } catch (err) {
      setError(authErrorMessage(err));
    } finally {
      setBusy(null);
    }
  };

  const onSendCode = (e: FormEvent) => {
    e.preventDefault();
    const target = email.trim();
    if (!target) return;
    void run('send', async () => {
      await call('/email/send-code', 'POST', { email: target });
      setCodeSentTo(target);
      setCode('');
    });
  };

  const onVerifyCode = (e: FormEvent) => {
    e.preventDefault();
    if (!codeSentTo) return;
    void run(
      'verify',
      async () => {
        setMethods(await call<SignInMethods>('/email/verify', 'POST', { email: codeSentTo, code }));
        setCodeSentTo(null);
        setEmail('');
        setCode('');
      },
      'Email added. You can now sign in with a code sent to it.',
    );
  };

  const onAddPasskey = () =>
    run(
      'passkey',
      async () => {
        const { challengeId, options } = await call<{
          challengeId: string;
          options: PublicKeyCredentialCreationOptionsJSON;
        }>('/passkeys/options', 'POST', {});
        const response = await startRegistration({ optionsJSON: options });
        setMethods(await call<SignInMethods>('/passkeys/verify', 'POST', { challengeId, response }));
      },
      'Passkey added.',
    );

  const onRemove = (path: string, key: string) =>
    run(key, async () => {
      await call(path, 'DELETE');
      await load();
    });

  const onRename = async (id: string, current: string | null) => {
    const name = await promptDialog({
      title: 'Rename passkey',
      label: 'Name',
      defaultValue: current ?? '',
      placeholder: 'e.g. MacBook Touch ID',
      confirmText: 'Save',
    });
    if (name === null) return;
    void run(`rename-${id}`, async () => {
      await call(`/passkeys/${id}`, 'PATCH', { name });
      await load();
    });
  };

  const hasGoogle = methods?.identities.some((i) => i.provider === 'google');

  return (
    <section className="rounded-xl border border-gray-800 p-6">
      <h2 className="text-xl font-semibold">Sign-in Methods</h2>
      <p className="mt-1 text-sm text-gray-400">
        Ways to sign in to this account besides your wallets. Adding them here keeps everything on one account.
      </p>

      <div className="mt-4 space-y-2">
        {methods && methods.identities.length === 0 && methods.passkeys.length === 0 && (
          <p className="text-sm text-gray-500">No email, Google or passkey sign-in yet.</p>
        )}
        {methods?.identities.map((identity) => (
          <div key={identity.id} className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-gray-800 p-3">
            <div>
              <p className="text-sm font-medium text-white">
                {identity.provider === 'google' ? 'Google' : 'Email code'}{' '}
                <span className="text-gray-300">{identity.email}</span>
              </p>
              <p className="text-xs text-gray-500">Last used {when(identity.lastUsedAt)}</p>
            </div>
            <button
              onClick={() => onRemove(`/identities/${identity.id}`, identity.id)}
              disabled={busy !== null}
              className="rounded-md border border-red-800 px-3 py-1.5 text-xs text-red-300 hover:border-red-600 disabled:opacity-60"
            >
              Remove
            </button>
          </div>
        ))}
        {methods?.passkeys.map((passkey) => (
          <div key={passkey.id} className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-gray-800 p-3">
            <div>
              <p className="text-sm font-medium text-white">
                Passkey <span className="text-gray-300">{passkey.name || (passkey.backedUp ? 'synced passkey' : 'this device')}</span>
              </p>
              <p className="text-xs text-gray-500">
                Added {when(passkey.createdAt)} · last used {when(passkey.lastUsedAt)}
              </p>
            </div>
            <div className="flex items-center gap-2">
              <button
                onClick={() => onRename(passkey.id, passkey.name)}
                disabled={busy !== null}
                className="rounded-md border border-gray-700 px-3 py-1.5 text-xs text-gray-200 hover:border-gray-500 disabled:opacity-60"
              >
                Rename
              </button>
              <button
                onClick={() => onRemove(`/passkeys/${passkey.id}`, passkey.id)}
                disabled={busy !== null}
                className="rounded-md border border-red-800 px-3 py-1.5 text-xs text-red-300 hover:border-red-600 disabled:opacity-60"
              >
                Remove
              </button>
            </div>
          </div>
        ))}
      </div>

      <div className="mt-6 grid gap-4 md:grid-cols-3">
        <div className="rounded-lg border border-gray-800 p-4">
          <h3 className="text-sm font-medium text-white">Passkey</h3>
          <p className="mt-1 text-xs text-gray-500">Face ID, Touch ID, Windows Hello or a security key.</p>
          <button
            onClick={onAddPasskey}
            disabled={busy !== null}
            className="mt-3 w-full rounded-md bg-purple-600 px-3 py-2 text-sm text-white hover:bg-purple-500 disabled:opacity-60"
          >
            {busy === 'passkey' ? 'Waiting for passkey…' : 'Add a passkey'}
          </button>
        </div>

        <div className="rounded-lg border border-gray-800 p-4">
          <h3 className="text-sm font-medium text-white">Google</h3>
          {!authMethods?.google || !authMethods.googleClientId ? (
            <p className="mt-1 text-xs text-gray-500">Google sign-in isn&apos;t set up on this server yet.</p>
          ) : hasGoogle ? (
            <p className="mt-1 text-xs text-gray-500">A Google account is linked.</p>
          ) : (
            <div className="mt-3">
              <GoogleButton
                clientId={authMethods.googleClientId}
                text="signin_with"
                onCredential={(credential) =>
                  void run(
                    'google',
                    async () => setMethods(await call<SignInMethods>('/google', 'POST', { credential })),
                    'Google account added.',
                  )
                }
              />
            </div>
          )}
        </div>

        <div className="rounded-lg border border-gray-800 p-4">
          <h3 className="text-sm font-medium text-white">Email code</h3>
          {authMethods?.email === false ? (
            <p className="mt-1 text-xs text-gray-500">Email sign-in isn&apos;t set up on this server yet.</p>
          ) : !codeSentTo ? (
            <form onSubmit={onSendCode} className="mt-3 space-y-2">
              <input
                type="email"
                required
                placeholder="you@example.com"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                className="w-full rounded-md border border-gray-700 bg-gray-950 px-3 py-2 text-sm text-white"
              />
              <button
                type="submit"
                disabled={busy !== null || !email.trim()}
                className="w-full rounded-md bg-gray-800 px-3 py-2 text-sm text-white hover:bg-gray-700 disabled:opacity-60"
              >
                {busy === 'send' ? 'Sending…' : 'Send code'}
              </button>
            </form>
          ) : (
            <form onSubmit={onVerifyCode} className="mt-3 space-y-2">
              <p className="text-xs text-gray-400">Code sent to {codeSentTo}</p>
              <input
                inputMode="numeric"
                autoComplete="one-time-code"
                maxLength={7}
                placeholder="123456"
                value={code}
                onChange={(e) => setCode(e.target.value)}
                className="w-full rounded-md border border-gray-700 bg-gray-950 px-3 py-2 text-center font-mono tracking-[0.3em] text-white"
              />
              <button
                type="submit"
                disabled={busy !== null || code.replace(/\s/g, '').length !== 6}
                className="w-full rounded-md bg-purple-600 px-3 py-2 text-sm text-white hover:bg-purple-500 disabled:opacity-60"
              >
                {busy === 'verify' ? 'Checking…' : 'Add email'}
              </button>
              <button type="button" onClick={() => setCodeSentTo(null)} className="w-full text-xs text-gray-400 hover:text-white">
                Use a different email
              </button>
            </form>
          )}
        </div>
      </div>

      {notice && <p className="mt-3 text-sm text-green-400">{notice}</p>}
      {error && <p className="mt-3 text-sm text-red-400">{error}</p>}
    </section>
  );
}
