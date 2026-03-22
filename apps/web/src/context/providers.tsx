'use client';

import { type ReactNode } from 'react';
import { ReownProvider } from '@/context/reown-provider';
import { AuthProvider } from '@/context/auth-context';

export function Providers({ children }: { children: ReactNode }) {
  return (
    <ReownProvider>
      <AuthProvider>{children}</AuthProvider>
    </ReownProvider>
  );
}
