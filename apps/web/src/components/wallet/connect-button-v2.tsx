'use client';

import { useState } from 'react';
import { ConnectButton as RainbowConnectButton } from '@rainbow-me/rainbowkit';
import { useAccount, useSignMessage, useChainId, useDisconnect } from 'wagmi';
import { useWallet } from '@solana/wallet-adapter-react';
import { WalletMultiButton } from '@solana/wallet-adapter-react-ui';
import { SiweMessage } from 'siwe';
import bs58 from 'bs58';
import { useAuth } from '@/context/auth-context';
import { truncateAddress } from '@/lib/utils';

export function ConnectButton() {
  const { user, isLoading, logout } = useAuth();
  const { disconnect: disconnectEvm } = useDisconnect();
  const { disconnect: disconnectSolana, connected: solanaConnected } = useWallet();

  const handleDisconnect = async () => {
    try {
      disconnectEvm();
    } catch {}

    if (solanaConnected && disconnectSolana) {
      try {
        await disconnectSolana();
      } catch {}
    }

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

  return <SignInFlow />;
}

function SignInFlow() {
  const [showModal, setShowModal] = useState(false);

  return (
    <>
      <button
        onClick={() => setShowModal(true)}
        className="rounded-lg bg-purple-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-purple-500"
      >
        Connect Wallet
      </button>

      {showModal && (
        <SignInModal
          isOpen={showModal}
          onClose={() => setShowModal(false)}
        />
      )}
    </>
  );
}

function SignInModal({ isOpen, onClose }: { isOpen: boolean; onClose: () => void }) {
  const { address: evmAddress } = useAccount();
  const { signMessageAsync } = useSignMessage();
  const chainId = useChainId();
  const { disconnect: disconnectEvm } = useDisconnect();

  const { publicKey: solanaPublicKey, signMessage: signSolanaMessage, disconnect: disconnectSolana } = useWallet();

  const { loginEvm, loginSolana, getNonce } = useAuth();

  const [signing, setSigning] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSignEvm = async () => {
    if (!evmAddress || !signMessageAsync) return;

    setSigning(true);
    setError(null);

    try {
      const nonce = await getNonce(evmAddress);
      const message = new SiweMessage({
        domain: window.location.host,
        address: evmAddress,
        statement: 'Sign in to NEXUS with your Ethereum wallet.',
        uri: window.location.origin,
        version: '1',
        chainId,
        nonce,
      });
      const messageString = message.prepareMessage();
      const signature = await signMessageAsync({ message: messageString });
      
      await loginEvm(messageString, signature);
      
      // Disconnect wallet after successful auth (ephemeral)
      disconnectEvm();
      
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to sign in');
    } finally {
      setSigning(false);
    }
  };

  const handleSignSolana = async () => {
    if (!solanaPublicKey || !signSolanaMessage) return;

    setSigning(true);
    setError(null);

    try {
      const address = solanaPublicKey.toBase58();
      const nonce = await getNonce(address);
      const message = `Sign this message to authenticate with NEXUS.\n\nNonce: ${nonce}`;
      
      const signatureBytes = await signSolanaMessage(new TextEncoder().encode(message));
      const signature = bs58.encode(signatureBytes);
      
      await loginSolana(address, signature);
      
      // Disconnect wallet after successful auth (ephemeral)
      if (disconnectSolana) {
        await disconnectSolana();
      }
      
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to sign in');
    } finally {
      setSigning(false);
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
              <h3 className="text-lg font-semibold">Sign In</h3>
              <p className="mt-1 text-sm text-gray-400">
                Connect your wallet to sign in. Works with any EVM or Solana wallet.
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
                    </div>
                    <button
                      onClick={handleSignEvm}
                      disabled={signing}
                      className="w-full rounded-lg bg-purple-600 px-4 py-2 text-sm font-medium text-white hover:bg-purple-500 disabled:opacity-60"
                    >
                      {signing ? 'Signing In...' : 'Sign In with This Wallet'}
                    </button>
                  </div>
                ) : (
                  <div className="[&_button]:!w-full [&_button]:!h-10 [&_button]:!text-sm">
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
                      onClick={handleSignSolana}
                      disabled={signing || !signSolanaMessage}
                      className="w-full rounded-lg bg-purple-600 px-4 py-2 text-sm font-medium text-white hover:bg-purple-500 disabled:opacity-60"
                    >
                      {signing ? 'Signing In...' : 'Sign In with This Wallet'}
                    </button>
                    {!signSolanaMessage && (
                      <p className="text-xs text-yellow-300">This wallet does not support signing messages</p>
                    )}
                  </div>
                ) : (
                  <div className="[&_button]:!w-full [&_button]:!h-10 [&_button]:!text-sm [&_button]:!bg-purple-600 [&_button]:hover:!bg-purple-500">
                    <WalletMultiButton />
                  </div>
                )}
              </div>
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
