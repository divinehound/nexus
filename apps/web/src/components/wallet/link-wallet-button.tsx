'use client';

import { useEffect, useState } from 'react';
import { useAppKit, useAppKitAccount, useDisconnect, useAppKitProvider } from '@reown/appkit/react';
import { useSignMessage } from 'wagmi';
import type { Provider } from '@reown/appkit-adapter-solana';
import bs58 from 'bs58';
import { createWalletChallenge, verifyWalletLink } from '@/lib/api';

interface LinkWalletButtonProps {
  accessToken: string;
  onSuccess: () => void;
  onMove: (chain: string, address: string, confirmationToken: string) => void;
}

export function LinkWalletButton({ accessToken, onSuccess, onMove }: LinkWalletButtonProps) {
  const { open } = useAppKit();
  const { isConnected, address, caipAddress } = useAppKitAccount();
  const { disconnect } = useDisconnect();
  const { signMessageAsync } = useSignMessage();
  const { walletProvider } = useAppKitProvider('solana');

  const [linking, setLinking] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Auto-link when wallet connects
  useEffect(() => {
    if (!isConnected || !address || linking) return;

    const handleLink = async () => {
      setLinking(true);
      setError(null);

      try {
        // Determine if EVM or Solana based on CAIP address
        const isSolana = caipAddress?.startsWith('solana:');
        const chain = isSolana ? 'solana' : 'ethereum'; // You may need to parse actual chain from caipAddress

        // Get challenge
        const challenge = await createWalletChallenge(
          { chain, address, purpose: 'link_wallet' },
          accessToken
        );

        let signature: string;

        if (isSolana && walletProvider) {
          // Solana signing
          const encodedMessage = new TextEncoder().encode(challenge.message);
          const provider = walletProvider as Provider;
          const signedMessage = await provider.signMessage(encodedMessage);
          signature = bs58.encode(signedMessage);
        } else {
          // EVM signing
          signature = await signMessageAsync({ message: challenge.message });
        }

        // Verify
        const result = await verifyWalletLink(
          { chain, address, signature, nonce: challenge.nonce },
          accessToken
        );

        if (result.requiresConfirmation && result.confirmationToken) {
          onMove(chain, address, result.confirmationToken);
        } else {
          onSuccess();
        }

        disconnect();
      } catch (err: any) {
        console.error('Link error:', err);
        setError(err.message || 'Wallet linking failed');
        disconnect();
      } finally {
        setLinking(false);
      }
    };

    handleLink();
  }, [isConnected, address, linking, caipAddress, walletProvider, signMessageAsync, accessToken, onSuccess, onMove, disconnect]);

  if (linking) {
    return (
      <div className="flex items-center gap-2 text-sm text-gray-300">
        <div className="h-4 w-4 animate-spin rounded-full border-2 border-gray-600 border-t-purple-500"></div>
        <span>Linking wallet...</span>
      </div>
    );
  }

  return (
    <div>
      <button
        onClick={() => open()}
        className="rounded-lg bg-purple-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-purple-500"
      >
        Link New Wallet
      </button>
      {error && (
        <p className="mt-2 text-sm text-red-400">{error}</p>
      )}
    </div>
  );
}
