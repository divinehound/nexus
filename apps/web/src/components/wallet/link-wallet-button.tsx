'use client';

import { useEffect, useState, useRef } from 'react';
import { useAppKit, useAppKitAccount, useDisconnect, useAppKitProvider } from '@reown/appkit/react';
import type { Provider } from '@reown/appkit-adapter-solana';
import type { Provider as EvmProvider } from '@reown/appkit-adapter-wagmi';
import bs58 from 'bs58';
import { createWalletChallenge, verifyWalletLink } from '@/lib/api';
import { hashMessage, recoverMessageAddress } from 'viem';

interface LinkWalletButtonProps {
  accessToken: string;
  onSuccess: () => void;
  onMove: (chain: string, address: string, confirmationToken: string) => void;
}

export function LinkWalletButton({ accessToken, onSuccess, onMove }: LinkWalletButtonProps) {
  const { open } = useAppKit();
  const { isConnected, address, caipAddress } = useAppKitAccount();
  const { disconnect } = useDisconnect();
  const { walletProvider: solanaProvider } = useAppKitProvider('solana');
  const { walletProvider: evmProvider } = useAppKitProvider('eip155');

  const [linking, setLinking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const processedAddress = useRef<string | null>(null);

  // Auto-link when wallet connects
  useEffect(() => {
    if (!isConnected || !address || linking || processedAddress.current === address) return;

    const handleLink = async () => {
      processedAddress.current = address;
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

        if (isSolana && solanaProvider) {
          // Solana signing
          const encodedMessage = new TextEncoder().encode(challenge.message);
          const provider = solanaProvider as Provider;
          const signedMessage = await provider.signMessage(encodedMessage);
          signature = bs58.encode(signedMessage);
        } else if (evmProvider) {
          // EVM signing via Reown provider
          const provider = evmProvider as EvmProvider;
          const signedMessage = await provider.request({
            method: 'personal_sign',
            params: [challenge.message, address],
          });
          signature = signedMessage as string;
        } else {
          throw new Error('Wallet provider not available');
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

        // Don't disconnect - user is already logged in, wallet can stay connected
      } catch (err: any) {
        console.error('Link error:', err);
        setError(err.message || 'Wallet linking failed');
        // Disconnect on error
        try {
          disconnect();
        } catch {}
      } finally {
        setLinking(false);
      }
    };

    handleLink();
  }, [isConnected, address, linking, caipAddress, solanaProvider, evmProvider, accessToken, onSuccess, onMove, disconnect]);

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
        onClick={() => {
          processedAddress.current = null;
          setError(null);
          open();
        }}
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
