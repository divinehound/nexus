'use client';

import { useState } from 'react';
import { useAccount, useSignMessage, useDisconnect } from 'wagmi';
import { useWallet } from '@solana/wallet-adapter-react';
import { ConnectButton as RainbowConnectButton } from '@rainbow-me/rainbowkit';
import { WalletMultiButton } from '@solana/wallet-adapter-react-ui';
import bs58 from 'bs58';
import { ApiError, createWalletChallenge, verifyWalletLink } from '@/lib/api';
import { truncateAddress } from '@/lib/utils';

interface LinkWalletModalProps {
  isOpen: boolean;
  onClose: () => void;
  accessToken: string;
  onSuccess: () => void;
  onMove: (data: { chain: string; address: string; confirmationToken: string }) => void;
}

export function LinkWalletModal({ isOpen, onClose, accessToken, onSuccess, onMove }: LinkWalletModalProps) {
  const { address: evmAddress, chain: evmChain } = useAccount();
  const { signMessageAsync } = useSignMessage();
  const { disconnect: disconnectEvm } = useDisconnect();
  
  const { publicKey: solanaPublicKey, signMessage: signSolanaMessage, disconnect: disconnectSolana } = useWallet();

  const [linking, setLinking] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Lock body scroll when modal is open
  if (typeof document !== 'undefined') {
    if (isOpen) {
      document.body.style.overflow = 'hidden';
    } else {
      document.body.style.overflow = '';
    }
  }

  const handleLinkEvm = async () => {
    if (!evmAddress || !signMessageAsync) return;

    setLinking(true);
    setError(null);

    try {
      const chain = evmChain?.name.toLowerCase() || 'ethereum';
      const challenge = await createWalletChallenge(
        { chain, address: evmAddress.toLowerCase(), purpose: 'link_wallet' },
        accessToken,
      );

      const signature = await signMessageAsync({ message: challenge.message });
      
      await verifyWalletLink(
        {
          chain,
          address: evmAddress.toLowerCase(),
          message: challenge.message,
          signature,
        },
        accessToken,
      );

      // Disconnect the wallet after linking (ephemeral connection)
      disconnectEvm();
      
      onSuccess();
      onClose();
    } catch (err) {
      if (err instanceof ApiError && err.status === 409 && err.data?.error === 'WALLET_ALREADY_LINKED' && err.data?.confirmationToken) {
        onMove({
          chain: evmChain?.name.toLowerCase() || 'ethereum',
          address: evmAddress.toLowerCase(),
          confirmationToken: err.data.confirmationToken,
        });
        onClose();
      } else {
        setError(err instanceof Error ? err.message : 'Failed to link wallet');
      }
    } finally {
      setLinking(false);
    }
  };

  const handleLinkSolana = async () => {
    if (!solanaPublicKey || !signSolanaMessage) return;

    setLinking(true);
    setError(null);

    try {
      const address = solanaPublicKey.toBase58();
      const challenge = await createWalletChallenge(
        { chain: 'solana', address, purpose: 'link_wallet' },
        accessToken,
      );

      const signatureBytes = await signSolanaMessage(new TextEncoder().encode(challenge.message));
      const signature = bs58.encode(signatureBytes);

      await verifyWalletLink(
        {
          chain: 'solana',
          address,
          message: challenge.message,
          signature,
        },
        accessToken,
      );

      // Disconnect the wallet after linking (ephemeral connection)
      if (disconnectSolana) {
        await disconnectSolana();
      }

      onSuccess();
      onClose();
    } catch (err) {
      if (err instanceof ApiError && err.status === 409 && err.data?.error === 'WALLET_ALREADY_LINKED' && err.data?.confirmationToken) {
        onMove({
          chain: 'solana',
          address: solanaPublicKey.toBase58(),
          confirmationToken: err.data.confirmationToken,
        });
        onClose();
      } else {
        setError(err instanceof Error ? err.message : 'Failed to link wallet');
      }
    } finally {
      setLinking(false);
    }
  };

  if (!isOpen) return null;

  return (
    <>
      <div className="fixed inset-0 z-50 bg-black/70" onClick={onClose} />
      <div className="fixed inset-0 z-[51] flex items-center justify-center px-4 py-4 sm:py-8">
        <div className="my-auto w-full max-w-lg max-h-[90vh] flex flex-col rounded-xl border border-gray-700 bg-gray-900 shadow-xl">
          <div className="flex items-center justify-between px-6 pt-6 pb-4 border-b border-gray-800">
            <div>
              <h3 className="text-lg font-semibold">Link Wallet</h3>
              <p className="mt-1 text-sm text-gray-400">
                Connect any wallet to link it to your account. Both EVM and Solana wallets supported.
              </p>
            </div>
            <button
              onClick={onClose}
              className="text-gray-400 hover:text-white flex-shrink-0 ml-4"
              aria-label="Close"
            >
              <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>

          <div className="overflow-y-auto px-6 py-4 space-y-4">
            {/* EVM Wallets */}
            <div className="rounded-lg border border-gray-800 p-4">
              <h4 className="text-sm font-semibold text-gray-300">EVM Wallets</h4>
              <p className="mt-1 text-xs text-gray-500">MetaMask, Coinbase Wallet, Phantom (EVM), etc</p>
              
              <div className="mt-3">
                {evmAddress ? (
                  <div className="space-y-3">
                    <div className="rounded border border-green-900/50 bg-green-950/30 p-2">
                      <p className="text-xs text-green-300">Connected: {truncateAddress(evmAddress)}</p>
                      {evmChain && <p className="text-xs text-green-400/70">Chain: {evmChain.name}</p>}
                    </div>
                    <button
                      onClick={handleLinkEvm}
                      disabled={linking}
                      className="w-full rounded-lg bg-purple-600 px-4 py-2 text-sm font-medium text-white hover:bg-purple-500 disabled:opacity-60"
                    >
                      {linking ? 'Linking...' : 'Link This Wallet'}
                    </button>
                  </div>
                ) : (
                  <div className="[&_button]:!w-full [&_button]:!h-10 [&_button]:!text-sm [&_button]:!font-medium [&_button]:!bg-purple-600 [&_button]:hover:!bg-purple-500">
                    <RainbowConnectButton />
                  </div>
                )}
              </div>
            </div>

            {/* Solana Wallets */}
            <div className="rounded-lg border border-gray-800 p-4">
              <h4 className="text-sm font-semibold text-gray-300">Solana Wallets</h4>
              <p className="mt-1 text-xs text-gray-500">Phantom, Solflare, Backpack, etc</p>
              
              <div className="mt-3">
                {solanaPublicKey ? (
                  <div className="space-y-3">
                    <div className="rounded border border-green-900/50 bg-green-950/30 p-2">
                      <p className="text-xs text-green-300">Connected: {truncateAddress(solanaPublicKey.toBase58())}</p>
                    </div>
                    <button
                      onClick={handleLinkSolana}
                      disabled={linking || !signSolanaMessage}
                      className="w-full rounded-lg bg-purple-600 px-4 py-2 text-sm font-medium text-white hover:bg-purple-500 disabled:opacity-60"
                    >
                      {linking ? 'Linking...' : 'Link This Wallet'}
                    </button>
                    {!signSolanaMessage && (
                      <p className="text-xs text-yellow-300">This wallet does not support signing messages</p>
                    )}
                  </div>
                ) : (
                  <div className="w-full [&_button]:!w-full [&_button]:!h-10 [&_button]:!text-sm [&_button]:!font-medium [&_button]:!bg-purple-600 [&_button]:hover:!bg-purple-500 [&_button]:!rounded-lg [&_button]:!border-none">
                    <WalletMultiButton style={{}} />
                  </div>
                )}
              </div>
            </div>
          </div>

          {error && (
            <div className="px-6 pb-4 pt-2">
              <div className="rounded-lg border border-red-900/50 bg-red-950/30 p-3">
                <p className="text-sm text-red-200">{error}</p>
              </div>
            </div>
          )}
        </div>
      </div>
    </>
  );
}
