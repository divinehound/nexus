import { createContext, useContext, useState, useCallback, useEffect, type ReactNode } from 'react';
import { startAuthentication, startRegistration } from '@simplewebauthn/browser';
import type {
  PublicKeyCredentialCreationOptionsJSON,
  PublicKeyCredentialRequestOptionsJSON,
} from '@simplewebauthn/browser';
import { apiFetch } from '@/lib/api';

interface AuthUser {
  id: string;
  primaryWalletId: string | null;
  role: string;
  email: string | null;
  displayName: string | null;
  echoScore: number | null;
  wallets: { id: string; address: string; chain: string; ensName: string | null; snsName: string | null }[];
}

interface AuthState {
  user: AuthUser | null;
  accessToken: string | null;
  isLoading: boolean;
}

interface AuthContextValue extends AuthState {
  loginEvm: (message: string, signature: string) => Promise<void>;
  loginSolana: (address: string, signature: string) => Promise<void>;
  logout: () => void;
  getNonce: (address: string) => Promise<string>;
  sendEmailCode: (email: string) => Promise<void>;
  loginEmailCode: (email: string, code: string) => Promise<void>;
  loginGoogle: (credential: string) => Promise<void>;
  loginPasskey: () => Promise<void>;
  signUpPasskey: () => Promise<void>;
  /** Re-reads the signed-in user, e.g. after adding a sign-in method. */
  reloadUser: () => Promise<void>;
  /** Gets fresh tokens and user, e.g. after linking or removing a wallet (the token carries the wallet address). */
  refreshSession: () => Promise<void>;
}

type AuthResponse = { user: AuthUser; accessToken: string; refreshToken: string };

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<AuthState>({
    user: null,
    accessToken: null,
    isLoading: true,
  });

  useEffect(() => {
    const stored = localStorage.getItem('nexus_auth');
    if (stored) {
      try {
        const { refreshToken } = JSON.parse(stored);
        apiFetch<{ accessToken: string; refreshToken: string }>('/auth/refresh', {
          method: 'POST',
          body: JSON.stringify({ refreshToken }),
        })
          .then(async (tokens) => {
            localStorage.setItem('nexus_auth', JSON.stringify(tokens));
            const user = await apiFetch<AuthUser>('/auth/me', { token: tokens.accessToken });
            setState({ user, accessToken: tokens.accessToken, isLoading: false });
          })
          .catch(() => {
            localStorage.removeItem('nexus_auth');
            setState({ user: null, accessToken: null, isLoading: false });
          });
      } catch {
        localStorage.removeItem('nexus_auth');
        setState({ user: null, accessToken: null, isLoading: false });
      }
    } else {
      setState((s) => ({ ...s, isLoading: false }));
    }
  }, []);

  const getNonce = useCallback(async (address: string) => {
    const { nonce } = await apiFetch<{ nonce: string }>('/auth/nonce', {
      method: 'POST',
      body: JSON.stringify({ address }),
    });
    return nonce;
  }, []);

  const handleAuthResponse = useCallback(
    async (response: { user: AuthUser; accessToken: string; refreshToken: string }) => {
      localStorage.setItem(
        'nexus_auth',
        JSON.stringify({ accessToken: response.accessToken, refreshToken: response.refreshToken }),
      );
      // The sign-in responses carry the bare user; /auth/me adds the wallets.
      const user = await apiFetch<AuthUser>('/auth/me', { token: response.accessToken }).catch(() => ({
        ...response.user,
        wallets: response.user.wallets ?? [],
      }));
      setState({ user, accessToken: response.accessToken, isLoading: false });
    },
    [],
  );

  const post = useCallback(
    <T,>(path: string, body: unknown) => apiFetch<T>(path, { method: 'POST', body: JSON.stringify(body) }),
    [],
  );

  const sendEmailCode = useCallback(
    async (email: string) => {
      await post('/auth/email/send-code', { email });
    },
    [post],
  );

  const loginEmailCode = useCallback(
    async (email: string, code: string) => {
      await handleAuthResponse(await post<AuthResponse>('/auth/email/verify', { email, code }));
    },
    [post, handleAuthResponse],
  );

  const loginGoogle = useCallback(
    async (credential: string) => {
      await handleAuthResponse(await post<AuthResponse>('/auth/google', { credential }));
    },
    [post, handleAuthResponse],
  );

  const loginPasskey = useCallback(async () => {
    const { challengeId, options } = await post<{
      challengeId: string;
      options: PublicKeyCredentialRequestOptionsJSON;
    }>('/auth/passkey/options', {});
    const response = await startAuthentication({ optionsJSON: options });
    await handleAuthResponse(await post<AuthResponse>('/auth/passkey/verify', { challengeId, response }));
  }, [post, handleAuthResponse]);

  const signUpPasskey = useCallback(async () => {
    const { challengeId, options } = await post<{
      challengeId: string;
      options: PublicKeyCredentialCreationOptionsJSON;
    }>('/auth/passkey/register/options', {});
    const response = await startRegistration({ optionsJSON: options });
    await handleAuthResponse(await post<AuthResponse>('/auth/passkey/register/verify', { challengeId, response }));
  }, [post, handleAuthResponse]);

  const refreshSession = useCallback(async () => {
    let refreshToken: string | undefined;
    try {
      refreshToken = JSON.parse(localStorage.getItem('nexus_auth') || '{}').refreshToken;
    } catch {
      refreshToken = undefined;
    }
    if (!refreshToken) return;
    const tokens = await apiFetch<{ accessToken: string; refreshToken: string }>('/auth/refresh', {
      method: 'POST',
      body: JSON.stringify({ refreshToken }),
    });
    localStorage.setItem('nexus_auth', JSON.stringify(tokens));
    const user = await apiFetch<AuthUser>('/auth/me', { token: tokens.accessToken });
    setState({ user, accessToken: tokens.accessToken, isLoading: false });
  }, []);

  const reloadUser = useCallback(async () => {
    if (!state.accessToken) return;
    const user = await apiFetch<AuthUser>('/auth/me', { token: state.accessToken });
    setState((s) => ({ ...s, user }));
  }, [state.accessToken]);

  const loginEvm = useCallback(
    async (message: string, signature: string) => {
      const response = await apiFetch<AuthResponse>(
        '/auth/verify/evm',
        { method: 'POST', body: JSON.stringify({ message, signature }) },
      );
      await handleAuthResponse(response);
    },
    [handleAuthResponse],
  );

  const loginSolana = useCallback(
    async (address: string, signature: string) => {
      const response = await apiFetch<AuthResponse>(
        '/auth/verify/solana',
        { method: 'POST', body: JSON.stringify({ address, signature }) },
      );
      await handleAuthResponse(response);
    },
    [handleAuthResponse],
  );

  const logout = useCallback(() => {
    localStorage.removeItem('nexus_auth');
    setState({ user: null, accessToken: null, isLoading: false });
  }, []);

  return (
    <AuthContext.Provider value={{
        ...state,
        loginEvm,
        loginSolana,
        logout,
        getNonce,
        sendEmailCode,
        loginEmailCode,
        loginGoogle,
        loginPasskey,
        signUpPasskey,
        reloadUser,
        refreshSession,
      }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
}
