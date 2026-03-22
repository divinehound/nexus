'use client';

import { Suspense, useState } from 'react';
import { useSearchParams, useRouter } from 'next/navigation';
import { useAppKit, useAppKitAccount, useAppKitProvider } from '@reown/appkit/react';
import type { Provider as SolanaProvider } from '@reown/appkit-adapter-solana';
import type { Provider as EvmProvider } from '@reown/appkit-adapter-wagmi';
import bs58 from 'bs58';
import { createWalletChallenge, verifyWalletLink, moveWalletLink } from '@/lib/api';

function LinkWalletContent() {
  const searchParams = useSearchParams();
  const router = useRouter();
  const token = searchParams.get('token');
  
  const { open } = useAppKit();
  const { isConnected, address, caipAddress } = useAppKitAccount();
  const { walletProvider: solanaProvider } = useAppKitProvider('solana');
  const { walletProvider: evmProvider } = useAppKitProvider('eip155');

  const [linking, setLinking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);
  const [confirmationToken, setConfirmationToken] = useState<string | null>(null);

  const handleLink = async () => {
    if (!token || !address) return;
    
    setLinking(true);
    setError(null);

    try {
      const isSolana = caipAddress?.startsWith('solana:');
      const chain = isSolana ? 'solana' : 'ethereum';

      const challenge = await createWalletChallenge(
        { chain, address, purpose: 'link_wallet' },
        token
      );

      let signature: string;

      if (isSolana && solanaProvider) {
        const encodedMessage = new TextEncoder().encode(challenge.message);
        const provider = solanaProvider as SolanaProvider;
        const signedMessage = await provider.signMessage(encodedMessage);
        signature = bs58.encode(signedMessage);
      } else if (evmProvider) {
        const provider = evmProvider as EvmProvider;
        const signedMessage = await provider.request({
          method: 'personal_sign',
          params: [challenge.message, address],
        });
        signature = signedMessage as string;
      } else {
        throw new Error('Wallet provider not available');
      }

      await verifyWalletLink(
        { chain, address, signature, message: challenge.message },
        token
      );

      setSuccess(true);
      
      // Auto-close after 3 seconds
      setTimeout(() => {
        window.close();
      }, 3000);
    } catch (err: any) {
      console.error('Link error:', err);
      
      // ApiError stores response body in err.data
      const errorData = err.data || {};
      const errorCode = errorData.error;
      const token = errorData.confirmationToken;
      
      if (errorCode === 'WALLET_ALREADY_LINKED' && token) {
        setConfirmationToken(token);
        setError(null);
      } else {
        // Show detailed error message
        const errorMsg = errorData.message || err.message || 'Wallet linking failed';
        setError(errorMsg);
      }
    } finally {
      setLinking(false);
    }
  };

  const handleConfirmMove = async () => {
    if (!token || !address || !confirmationToken) return;
    
    setLinking(true);
    setError(null);

    try {
      const isSolana = caipAddress?.startsWith('solana:');
      const chain = isSolana ? 'solana' : 'ethereum';

      const challenge = await createWalletChallenge(
        { chain, address, purpose: 'move_wallet', confirmationToken },
        token
      );

      let signature: string;

      if (isSolana && solanaProvider) {
        const encodedMessage = new TextEncoder().encode(challenge.message);
        const provider = solanaProvider as SolanaProvider;
        const signedMessage = await provider.signMessage(encodedMessage);
        signature = bs58.encode(signedMessage);
      } else if (evmProvider) {
        const provider = evmProvider as EvmProvider;
        const signedMessage = await provider.request({
          method: 'personal_sign',
          params: [challenge.message, address],
        });
        signature = signedMessage as string;
      } else {
        throw new Error('Wallet provider not available');
      }

      await moveWalletLink(
        { chain, address, confirmationToken, signature, message: challenge.message },
        token
      );

      setSuccess(true);
      setConfirmationToken(null);
      
      // Auto-close after 3 seconds
      setTimeout(() => {
        window.close();
      }, 3000);
    } catch (err: any) {
      console.error('Move error:', err);
      const errorMsg = err.error?.message || err.message || 'Wallet transfer failed';
      setError(errorMsg);
    } finally {
      setLinking(false);
    }
  };

  if (!token) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-gray-950 p-4">
        <div className="w-full max-w-md rounded-xl border border-red-900/50 bg-red-950/30 p-6">
          <h2 className="text-lg font-semibold text-red-200">Invalid Link</h2>
          <p className="mt-2 text-sm text-red-300">
            No authentication token provided. Please use the link button from your profile page.
          </p>
        </div>
      </div>
    );
  }

  if (success) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-gray-950 p-4">
        <div className="w-full max-w-md rounded-xl border border-green-900/50 bg-green-950/30 p-6 text-center">
          <svg className="mx-auto h-16 w-16 text-green-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
          </svg>
          <h2 className="mt-4 text-xl font-semibold text-green-200">Wallet Linked!</h2>
          <p className="mt-2 text-sm text-green-300">
            Your wallet has been successfully linked to your account.
          </p>
          <p className="mt-4 text-xs text-green-400">
            This window will close automatically...
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-gray-950 p-4">
      <div className="w-full max-w-md space-y-6">
        <div className="rounded-xl border border-gray-800 bg-gray-900 p-6">
          <h1 className="text-2xl font-bold">Link Wallet</h1>
          <p className="mt-2 text-sm text-gray-400">
            Connect your wallet and sign the message to link it to your NEXUS account.
          </p>
        </div>

        {!isConnected ? (
          <div className="rounded-xl border border-gray-800 bg-gray-900 p-6 text-center">
            <h2 className="text-lg font-semibold">Step 1: Connect Wallet</h2>
            <p className="mt-2 text-sm text-gray-400">
              Click below to open the wallet selection modal
            </p>
            <button
              onClick={() => open()}
              className="mt-4 w-full rounded-lg bg-purple-600 px-6 py-3 font-medium text-white hover:bg-purple-500"
            >
              Connect Wallet
            </button>
          </div>
        ) : (
          <div className="rounded-xl border border-gray-800 bg-gray-900 p-6">
            <div className="flex items-center gap-2 text-green-500">
              <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
              </svg>
              <span className="font-medium">Wallet Connected</span>
            </div>
            <p className="mt-2 text-sm text-gray-400">
              {address?.slice(0, 6)}...{address?.slice(-4)}
            </p>

            <div className="mt-6">
              <h2 className="text-lg font-semibold">Step 2: Sign Message</h2>
              <p className="mt-2 text-sm text-gray-400">
                Click below to sign a message proving you own this wallet
              </p>
              <button
                onClick={handleLink}
                disabled={linking}
                className="mt-4 w-full rounded-lg bg-purple-600 px-6 py-3 font-medium text-white hover:bg-purple-500 disabled:opacity-50"
              >
                {linking ? 'Signing...' : 'Sign & Link Wallet'}
              </button>
            </div>

            {confirmationToken && (
              <div className="mt-6 rounded-lg border border-yellow-900/50 bg-yellow-950/30 p-4">
                <h3 className="font-semibold text-yellow-200">Confirm Wallet Transfer</h3>
                <p className="mt-2 text-sm text-yellow-300">
                  This wallet is currently linked to another account. Click below to transfer it to your current account.
                </p>
                <button
                  onClick={handleConfirmMove}
                  disabled={linking}
                  className="mt-4 w-full rounded-lg bg-yellow-600 px-6 py-3 font-medium text-white hover:bg-yellow-500 disabled:opacity-50"
                >
                  {linking ? 'Confirming...' : 'Confirm Transfer'}
                </button>
              </div>
            )}

            {error && (
              <div className="mt-4 rounded-lg border border-red-900/50 bg-red-950/30 p-3">
                <p className="text-sm text-red-200">{error}</p>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

export default function LinkWalletPage() {
  return (
    <Suspense fallback={
      <div className="flex min-h-screen items-center justify-center bg-gray-950">
        <div className="h-12 w-12 animate-spin rounded-full border-4 border-gray-700 border-t-purple-500"></div>
      </div>
    }>
      <LinkWalletContent />
    </Suspense>
  );
}
