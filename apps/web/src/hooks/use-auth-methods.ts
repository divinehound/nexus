'use client';

import { useEffect, useState } from 'react';
import { apiFetch } from '@/lib/api';

export interface AuthMethods {
  wallet: boolean;
  email: boolean;
  google: boolean;
  googleClientId: string | null;
  passkey: boolean;
}

let cached: Promise<AuthMethods> | null = null;

/** Which sign-in methods the API has set up (Google needs a client id, email needs a sender). */
export function useAuthMethods(): AuthMethods | null {
  const [methods, setMethods] = useState<AuthMethods | null>(null);
  useEffect(() => {
    cached ??= apiFetch<AuthMethods>('/auth/methods').catch((err) => {
      cached = null;
      throw err;
    });
    let live = true;
    cached
      .then((m) => live && setMethods(m))
      .catch(() => live && setMethods({ wallet: true, email: false, google: false, googleClientId: null, passkey: true }));
    return () => {
      live = false;
    };
  }, []);
  return methods;
}
