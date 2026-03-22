'use client';

import { useEffect, useState } from 'react';
import { useAppKit, useAppKitAccount, useDisconnect, useAppKitProvider } from '@reown/appkit/react';
import { useSignMessage } from 'wagmi';
import type { Provider } from '@reown/appkit-adapter-solana';
import { useAuth } from '@/context/auth-context';
import { truncateAddress } from '@/lib/utils';
import bs58 from 'bs58';

export function ConnectButton() {
  const { user, isLoading, logout, loginEvm, loginSolana, getNonce } = useAuth();
  const { open } = useAppKit();
  const { isConnected, address, caipAddress } = useAppKitAccount();
  const { disconnect } = useDisconnect();
  const { signMessageAsync } = useSignMessage();
  const { walletProvider } = useAppKitProvider('solana');

  const [signing, setSigning] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Auto-sign when wallet connects
  useEffect(() => {
    if (!isConnected || !address || user || signing) return;

    const handleAuth = async () => {
      setSigning(true);
      setError(null);

      try {
        // Determine if EVM or Solana based on CAIP address
        const isSolana = caipAddress?.startsWith('solana:');
        
        if (isSolana && walletProvider) {
          // Solana flow
          const nonce = await getNonce(address);
          const message = `NEXUS Authentication\n\nWallet: ${address}\nNonce: ${nonce}\n\nSign this message to prove you own this wallet.`;
          const encodedMessage = new TextEncoder().encode(message);
          
          const provider = walletProvider as Provider;
          const signedMessage = await provider.signMessage(encodedMessage);
          const signature = bs58.encode(signedMessage);

          await loginSolana(address, signature);
          disconnect();
        } else {
          // EVM flow
          const nonce = await getNonce(address);
          const message = `NEXUS Authentication\n\nWallet: ${address}\nNonce: ${nonce}\n\nSign this message to prove you own this wallet.`;
          
          const signature = await signMessageAsync({ message });
          await loginEvm(message, signature);
          disconnect();
        }
      } catch (err: any) {
        console.error('Auth error:', err);
        setError(err.message || 'Authentication failed');
        disconnect();
      } finally {
        setSigning(false);
      }
    };

    handleAuth();
  }, [isConnected, address, user, signing, caipAddress, walletProvider, signMessageAsync, getNonce, loginEvm, loginSolana, disconnect]);

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

  if (signing) {
    return (
      <div className="flex items-center gap-2 text-sm text-gray-300">
        <div className="h-4 w-4 animate-spin rounded-full border-2 border-gray-600 border-t-purple-500"></div>
        <span>Signing...</span>
      </div>
    );
  }

  return (
    <div>
      <button
        onClick={() => open()}
        className="rounded-lg bg-purple-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-purple-500"
      >
        Connect Wallet
      </button>
      {error && (
        <p className="mt-2 text-xs text-red-400">{error}</p>
      )}
    </div>
  );
}
