'use client';

import { useEffect, useState, useRef } from 'react';
import { useAppKit, useAppKitAccount, useDisconnect, useAppKitProvider } from '@reown/appkit/react';
import type { Provider } from '@reown/appkit-adapter-solana';
import type { Provider as EvmProvider } from '@reown/appkit-adapter-wagmi';
import { useAuth } from '@/context/auth-context';
import { truncateAddress } from '@/lib/utils';
import bs58 from 'bs58';

export function ConnectButton() {
  const { user, isLoading, logout, loginEvm, loginSolana, getNonce } = useAuth();
  const { open } = useAppKit();
  const { isConnected, address, caipAddress, caipNetworkId } = useAppKitAccount();
  const { disconnect } = useDisconnect();
  const { walletProvider: solanaProvider } = useAppKitProvider('solana');
  const { walletProvider: evmProvider } = useAppKitProvider('eip155');

  const [signing, setSigning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const processedAddress = useRef<string | null>(null);

  // Reset processed address when disconnected
  useEffect(() => {
    if (!isConnected) {
      processedAddress.current = null;
    }
  }, [isConnected]);

  // Auto-sign when wallet connects (only if not already logged in)
  useEffect(() => {
    // Don't auto-sign if user is already authenticated, already processed this address, or still loading
    if (!isConnected || !address || user || signing || isLoading || processedAddress.current === address) return;

    const handleAuth = async () => {
      // Mark this address as processed
      processedAddress.current = address;
      setSigning(true);
      setError(null);

      try {
        // Determine if EVM or Solana based on CAIP address
        const isSolana = caipAddress?.startsWith('solana:');
        
        if (isSolana && solanaProvider) {
          // Solana flow
          const nonce = await getNonce(address);
          const message = `NEXUS Authentication\n\nWallet: ${address}\nNonce: ${nonce}\n\nSign this message to prove you own this wallet.`;
          const encodedMessage = new TextEncoder().encode(message);
          
          const provider = solanaProvider as Provider;
          const signedMessage = await provider.signMessage(encodedMessage);
          const signature = bs58.encode(signedMessage);

          await loginSolana(address, signature);
          disconnect();
        } else if (evmProvider) {
          // EVM flow - use proper SIWE format
          const nonce = await getNonce(address);
          const domain = typeof window !== 'undefined' ? window.location.host : 'nexus.dev.intentionworks.xyz';
          const origin = typeof window !== 'undefined' ? window.location.origin : 'https://nexus.dev.intentionworks.xyz';
          const issuedAt = new Date().toISOString();
          
          // Get chain ID from provider
          const provider = evmProvider as EvmProvider;
          let chainId = 1; // default to mainnet
          try {
            const chainIdHex = await provider.request({ method: 'eth_chainId' }) as string;
            chainId = parseInt(chainIdHex, 16);
            console.log('Connected chain ID:', chainId, 'from hex:', chainIdHex);
          } catch (e) {
            console.error('Failed to get chain ID:', e);
          }
          
          // SIWE message format
          const message = `${domain} wants you to sign in with your Ethereum account:
${address}

Sign in to NEXUS

URI: ${origin}
Version: 1
Chain ID: ${chainId}
Nonce: ${nonce}
Issued At: ${issuedAt}`;
          
          const signature = await provider.request({
            method: 'personal_sign',
            params: [message, address],
          }) as string;
          
          await loginEvm(message, signature);
          disconnect();
        } else {
          throw new Error('Wallet provider not available');
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
  }, [isConnected, address, user, signing, caipAddress, solanaProvider, evmProvider, getNonce, loginEvm, loginSolana, disconnect]);

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
