'use client';

import { useAppKit, useAppKitAccount, useDisconnect } from '@reown/appkit/react';
import { useAuth } from '@/context/auth-context';
import { truncateAddress } from '@/lib/utils';

export function ConnectButton() {
  const { user, isLoading, logout } = useAuth();
  const { open } = useAppKit();
  const { isConnected, address } = useAppKitAccount();
  const { disconnect } = useDisconnect();

  const handleDisconnect = async () => {
    try {
      disconnect();
    } catch {}
    logout();
  };

  if (isLoading) {
    return (
      <div className="h-10 w-28 animate-pulse rounded-lg bg-gray-800" />
    );
  }

  if (user) {
    const primaryWallet = user.wallets?.[0];
    return (
      <div className="flex items-center gap-3">
        <span className="text-sm text-gray-300">
          {primaryWallet?.ensName || primaryWallet?.snsName || truncateAddress(primaryWallet?.address || '')}
        </span>
        <button
          onClick={handleDisconnect}
          className="rounded-lg border border-gray-700 px-3 py-1.5 text-sm text-gray-400 transition-colors hover:border-gray-500 hover:text-white"
        >
          Disconnect
        </button>
      </div>
    );
  }

  return (
    <button
      onClick={() => open()}
      className="rounded-lg bg-purple-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-purple-500"
    >
      Connect Wallet
    </button>
  );
}
