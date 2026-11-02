'use client';

import { FormEvent, useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { useAuth } from '@/context/auth-context';
import { useAuthMethods } from '@/hooks/use-auth-methods';
import { authErrorMessage } from '@/lib/auth-errors';
import { GoogleButton } from './google-button';

type Busy = null | 'google' | 'send' | 'verify' | 'passkey' | 'passkey-new';

/** Every way to sign in: wallet, Google, an emailed code, or a passkey. */
export function SignInDialog({
  open,
  onOpenChange,
  onConnectWallet,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onConnectWallet: () => void;
}) {
  const { sendEmailCode, loginEmailCode, loginGoogle, loginPasskey, signUpPasskey } = useAuth();
  const methods = useAuthMethods();
  const [email, setEmail] = useState('');
  const [code, setCode] = useState('');
  const [codeSentTo, setCodeSentTo] = useState<string | null>(null);
  const [busy, setBusy] = useState<Busy>(null);
  const [error, setError] = useState<string | null>(null);

  const reset = () => {
    setEmail('');
    setCode('');
    setCodeSentTo(null);
    setBusy(null);
    setError(null);
  };

  const run = async (step: Exclude<Busy, null>, action: () => Promise<void>, closeAfter = true) => {
    setBusy(step);
    setError(null);
    try {
      await action();
      if (closeAfter) {
        onOpenChange(false);
        reset();
      }
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
    void run(
      'send',
      async () => {
        await sendEmailCode(target);
        setCodeSentTo(target);
        setCode('');
      },
      false,
    );
  };

  const onVerifyCode = (e: FormEvent) => {
    e.preventDefault();
    if (!codeSentTo) return;
    void run('verify', () => loginEmailCode(codeSentTo, code));
  };

  return (
    <Dialog.Root
      open={open}
      onOpenChange={(next) => {
        onOpenChange(next);
        if (!next) reset();
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-black/70" />
        <Dialog.Content className="fixed left-1/2 top-1/2 z-50 max-h-[90vh] w-[calc(100%-2rem)] max-w-sm -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-xl border border-gray-800 bg-gray-900 p-6 shadow-2xl">
          <Dialog.Title className="text-xl font-semibold text-white">Sign in to Nexus</Dialog.Title>
          <Dialog.Description className="mt-1 text-sm text-gray-400">
            Use a wallet, Google, your email, or a passkey.
          </Dialog.Description>

          <div className="mt-5 space-y-3">
            <button
              type="button"
              onClick={() => {
                onOpenChange(false);
                reset();
                onConnectWallet();
              }}
              className="w-full rounded-full bg-purple-600 px-4 py-2.5 text-sm font-medium text-white transition-colors hover:bg-purple-500"
            >
              Connect a wallet
            </button>

            {methods?.google && methods.googleClientId && (
              <GoogleButton
                clientId={methods.googleClientId}
                onCredential={(credential) => void run('google', () => loginGoogle(credential))}
              />
            )}

            <button
              type="button"
              disabled={busy !== null}
              onClick={() => void run('passkey', loginPasskey)}
              className="w-full rounded-full border border-gray-700 px-4 py-2.5 text-sm font-medium text-gray-200 transition-colors hover:border-gray-500 hover:text-white disabled:opacity-50"
            >
              {busy === 'passkey' ? 'Waiting for passkey…' : 'Sign in with a passkey'}
            </button>
          </div>

          {methods?.email !== false && (
            <>
              <div className="my-5 flex items-center gap-3 text-xs uppercase tracking-wide text-gray-500">
                <span className="h-px flex-1 bg-gray-800" />
                or email
                <span className="h-px flex-1 bg-gray-800" />
              </div>

              {!codeSentTo ? (
                <form onSubmit={onSendCode} className="space-y-2">
                  <input
                    type="email"
                    required
                    autoComplete="email"
                    placeholder="you@example.com"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    className="w-full rounded-lg border border-gray-700 bg-gray-950 px-3 py-2 text-sm text-white placeholder:text-gray-600 focus:border-purple-500 focus:outline-none"
                  />
                  <button
                    type="submit"
                    disabled={busy !== null || !email.trim()}
                    className="w-full rounded-lg bg-gray-800 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-gray-700 disabled:opacity-50"
                  >
                    {busy === 'send' ? 'Sending…' : 'Email me a sign-in code'}
                  </button>
                </form>
              ) : (
                <form onSubmit={onVerifyCode} className="space-y-2">
                  <p className="text-sm text-gray-300">
                    We sent a 6-digit code to <span className="font-medium text-white">{codeSentTo}</span>.
                  </p>
                  <input
                    inputMode="numeric"
                    autoComplete="one-time-code"
                    pattern="[0-9 ]*"
                    maxLength={7}
                    placeholder="123456"
                    autoFocus
                    value={code}
                    onChange={(e) => setCode(e.target.value)}
                    className="w-full rounded-lg border border-gray-700 bg-gray-950 px-3 py-2 text-center font-mono text-lg tracking-[0.4em] text-white placeholder:text-gray-700 focus:border-purple-500 focus:outline-none"
                  />
                  <button
                    type="submit"
                    disabled={busy !== null || code.replace(/\s/g, '').length !== 6}
                    className="w-full rounded-lg bg-purple-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-purple-500 disabled:opacity-50"
                  >
                    {busy === 'verify' ? 'Checking…' : 'Sign in'}
                  </button>
                  <div className="flex justify-between text-xs text-gray-400">
                    <button type="button" className="hover:text-white" onClick={() => setCodeSentTo(null)}>
                      Use a different email
                    </button>
                    <button
                      type="button"
                      className="hover:text-white disabled:opacity-50"
                      disabled={busy !== null}
                      onClick={() =>
                        void run('send', async () => {
                          await sendEmailCode(codeSentTo);
                          setCode('');
                        }, false)
                      }
                    >
                      Send a new code
                    </button>
                  </div>
                </form>
              )}
            </>
          )}

          {error && <p className="mt-4 text-sm text-red-400">{error}</p>}

          <div className="mt-5 space-y-2 border-t border-gray-800 pt-4 text-xs text-gray-500">
            <p>
              New here?{' '}
              <button
                type="button"
                disabled={busy !== null}
                onClick={() => void run('passkey-new', signUpPasskey)}
                className="text-purple-400 hover:text-purple-300 disabled:opacity-50"
              >
                {busy === 'passkey-new' ? 'Creating…' : 'Create an account with a passkey'}
              </button>
            </p>
            <p>
              Already use Nexus with a wallet? Sign in with it first, then add email, Google or a passkey on your Me
              page so they open the same account.
            </p>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
