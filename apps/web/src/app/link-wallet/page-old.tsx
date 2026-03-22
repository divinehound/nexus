'use client';

import { Suspense, useEffect, useState, useRef } from 'react';
import { useSearchParams, useRouter } from 'next/navigation';
import { useAppKit, useAppKitAccount, useAppKitProvider } from '@reown/appkit/react';
import type { Provider as SolanaProvider } from '@reown/appkit-adapter-solana';
import type { Provider as EvmProvider } from '@reown/appkit-adapter-wagmi';
import bs58 from 'bs58';
import { createWalletChallenge, verifyWalletLink } from '@/lib/api';

function LinkWalletContent() {
  const searchParams = useSearchParams();
  const router = useRouter();
  const token = searchParams.get('token');
  
  const { open } = useAppKit();
  const { isConnected, address, caipAddress } = useAppKitAccount();
  const { walletProvider: solanaProvider } = useAppKitProvider('solana');
  const { walletProvider: evmProvider } = useAppKitProvider('eip155');

  const [status, setStatus] = useState<'idle' | 'connecting' | 'linking' | 'success' | 'error'>('idle');
  const [error, setError] = useState<string | null>(null);
  const processedRef = useRef(false);

  // Open modal on mount if not connected
  useEffect(() => {
    if (!token) {
      setError('No authentication token provided');
      return;
    }

    if (!isConnected && status === 'idle') {
      setStatus('connecting');
      open();
    }
  }, [token, isConnected, status, open]);

  // Auto-link when wallet connects (only once)
  useEffect(() => {
    // Don't run if no connection, no address, no token, or already processed
    if (!isConnected || !address || !token || processedRef.current) return;

    const handleLink = async () => {
      processedRef.current = true; // Mark as processed immediately
      setStatus('linking');
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
          { chain, address, signature, nonce: challenge.nonce },
          token
        );

        setStatus('success');
        
        // Redirect back to profile after 2 seconds
        setTimeout(() => {
          window.close(); // Try to close the wallet browser
          // Fallback: redirect to profile
          router.push('/me');
        }, 2000);
      } catch (err: any) {
        console.error('Link error:', err);
        setError(err.message || 'Wallet linking failed');
        setStatus('error');
      }
    };

    handleLink();
  }, [isConnected, address, token, caipAddress, solanaProvider, evmProvider, status, router]);

  if (!token) {
    return (
      <div className="flex min-h-screen items-center justify-center p-4">
        <div className="w-full max-w-md rounded-xl border border-red-900/50 bg-red-950/30 p-6">
          <h2 className="text-lg font-semibold text-red-200">Invalid Link</h2>
          <p className="mt-2 text-sm text-red-300">
            No authentication token provided. Please use the link from your profile page.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex min-h-screen items-center justify-center p-4">
      <div className="w-full max-w-md space-y-4">
        {status === 'connecting' && (
          <div className="rounded-xl border border-gray-800 bg-gray-900 p-6 text-center">
            <div className="mx-auto h-12 w-12 animate-spin rounded-full border-4 border-gray-700 border-t-purple-500"></div>
            <h2 className="mt-4 text-lg font-semibold">Connect Your Wallet</h2>
            <p className="mt-2 text-sm text-gray-400">
              Select a wallet from the modal to link it to your account
            </p>
          </div>
        )}

        {status === 'linking' && (
          <div className="rounded-xl border border-gray-800 bg-gray-900 p-6 text-center">
            <div className="mx-auto h-12 w-12 animate-spin rounded-full border-4 border-gray-700 border-t-purple-500"></div>
            <h2 className="mt-4 text-lg font-semibold">Linking Wallet...</h2>
            <p className="mt-2 text-sm text-gray-400">
              Please sign the message in your wallet
            </p>
          </div>
        )}

        {status === 'success' && (
          <div className="rounded-xl border border-green-900/50 bg-green-950/30 p-6 text-center">
            <svg className="mx-auto h-12 w-12 text-green-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
            </svg>
            <h2 className="mt-4 text-lg font-semibold text-green-200">Wallet Linked!</h2>
            <p className="mt-2 text-sm text-green-300">
              Your wallet has been successfully linked to your account.
            </p>
            <p className="mt-1 text-xs text-green-400">
              Redirecting back to your profile...
            </p>
          </div>
        )}

        {status === 'error' && (
          <div className="rounded-xl border border-red-900/50 bg-red-950/30 p-6">
            <h2 className="text-lg font-semibold text-red-200">Link Failed</h2>
            <p className="mt-2 text-sm text-red-300">{error}</p>
            <button
              onClick={() => {
                setStatus('idle');
                setError(null);
              }}
              className="mt-4 w-full rounded-lg bg-red-600 px-4 py-2 text-sm font-medium text-white hover:bg-red-500"
            >
              Try Again
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

export default function LinkWalletPage() {
  return (
    <Suspense fallback={
      <div className="flex min-h-screen items-center justify-center">
        <div className="h-12 w-12 animate-spin rounded-full border-4 border-gray-700 border-t-purple-500"></div>
      </div>
    }>
      <LinkWalletContent />
    </Suspense>
  );
}
