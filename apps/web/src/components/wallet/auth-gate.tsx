'use client';

import { useAuth } from '@/context/auth-context';
import { ConnectButton } from './connect-button';

export function AuthGate({ children }: { children: React.ReactNode }) {
  const { user, isLoading } = useAuth();

  if (isLoading) {
    return (
      <div className="flex min-h-[50vh] items-center justify-center">
        <div className="h-8 w-8 animate-spin rounded-full border-2 border-gray-600 border-t-purple-500" />
      </div>
    );
  }

  if (!user) {
    return (
      <div className="flex min-h-[50vh] flex-col items-center justify-center gap-4">
        <p className="text-lg text-gray-400">Connect your wallet to access this page</p>
        <ConnectButton />
      </div>
    );
  }

  return <>{children}</>;
}
