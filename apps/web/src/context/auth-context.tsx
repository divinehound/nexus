'use client';

import { createContext, useContext, useState, useCallback, useEffect, type ReactNode } from 'react';
import { apiFetch } from '@/lib/api';

interface AuthUser {
  id: string;
  primaryWalletId: string | null;
  role: string;
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
}

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
      setState({ user: response.user, accessToken: response.accessToken, isLoading: false });
    },
    [],
  );

  const loginEvm = useCallback(
    async (message: string, signature: string) => {
      const response = await apiFetch<{ user: AuthUser; accessToken: string; refreshToken: string }>(
        '/auth/verify/evm',
        { method: 'POST', body: JSON.stringify({ message, signature }) },
      );
      await handleAuthResponse(response);
    },
    [handleAuthResponse],
  );

  const loginSolana = useCallback(
    async (address: string, signature: string) => {
      const response = await apiFetch<{ user: AuthUser; accessToken: string; refreshToken: string }>(
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
    <AuthContext.Provider value={{ ...state, loginEvm, loginSolana, logout, getNonce }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
}
